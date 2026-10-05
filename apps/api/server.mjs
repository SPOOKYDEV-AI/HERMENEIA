import http from "node:http";
import { URL } from "node:url";

import { DomainError } from "../../.build/packages/domain/src/index.js";

const JSON_LIMIT_BYTES = 70 * 1024;
const MAX_ACKS = 100;
const MAX_SYNC_LIMIT = 200;
const MAX_WAIT_MS = 30_000;

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function noContent(res, statusCode = 204) {
  res.writeHead(statusCode);
  res.end();
}

function errorBody(code, message, retryable = false, details = undefined) {
  return {
    code,
    message,
    retryable,
    ...(details ? { details } : {}),
  };
}

function mapError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: errorBody(error.code, error.message, error.retryable),
    };
  }

  if (error instanceof DomainError) {
    switch (error.code) {
      case "IDEMPOTENCY_CONFLICT":
      case "REVISION_CONFLICT":
      case "SOURCE_REVISION_MISMATCH":
      case "SOURCE_REQUIRED":
        return { status: 409, body: errorBody(error.code, error.message, false) };
      case "SOURCE_BUFFER_UNAVAILABLE":
        return { status: 503, body: errorBody(error.code, error.message, true) };
      case "SOURCE_EXPIRED":
        return { status: 410, body: errorBody(error.code, error.message, false) };
      case "NOT_AUTHORIZED":
      case "DEVICE_REVOKED":
        return { status: 403, body: errorBody(error.code, error.message, false) };
      case "RECIPIENT_UNAVAILABLE":
        return { status: 503, body: errorBody(error.code, error.message, true) };
      case "DELIVERY_EXPIRED":
        return { status: 410, body: errorBody(error.code, error.message, false) };
      case "INVALID_COMMAND":
        return { status: 400, body: errorBody(error.code, error.message, false) };
      default:
        return { status: 400, body: errorBody(error.code, error.message, false) };
    }
  }

  return {
    status: 500,
    body: errorBody("INTERNAL_ERROR", "Unexpected server error", true),
  };
}

class HttpError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function readJson(req, maxBytes = JSON_LIMIT_BYTES) {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_COMMAND", "Request body must be valid JSON");
  }
}

function requireProtocolV1(body) {
  if (body.protocol_version !== 1) {
    throw new HttpError(400, "INVALID_COMMAND", "protocol_version must equal 1");
  }
}

function parseCursor(value, currentEpoch) {
  if (!value) {
    return { epoch: currentEpoch, offset: 0 };
  }
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    throw new HttpError(409, "SYNC_RESET_REQUIRED", "Cursor format is invalid");
  }
  return { epoch: Number(match[1]), offset: Number(match[2]) };
}

function cursor(epoch, offset) {
  return `${epoch}:${offset}`;
}

function normalizeSyncEvent(core, deviceId, event) {
  if (event.type === "message.deleted") {
    return {
      protocol_version: 1,
      event_id: event.eventId,
      cursor: cursor(event.inboxEpoch, event.offset),
      type: event.type,
      server_time: event.createdAt,
      tenant_id: event.tenantId,
      conversation_id: event.conversationId,
      payload: {
        message_id: event.messageId,
        source_revision: event.sourceRevision,
      },
    };
  }

  if (!event.envelopeId) {
    throw new HttpError(409, "SYNC_RESET_REQUIRED", "Content event has no envelope");
  }

  const envelope = core.getEnvelopeForDevice(deviceId, event.envelopeId);
  if (!envelope) {
    throw new HttpError(409, "SYNC_RESET_REQUIRED", "Envelope no longer available");
  }

  return {
    protocol_version: 1,
    event_id: event.eventId,
    cursor: cursor(event.inboxEpoch, event.offset),
    type: event.type,
    server_time: event.createdAt,
    tenant_id: event.tenantId,
    conversation_id: event.conversationId,
    payload: {
      message_id: event.messageId,
      envelope_id: event.envelopeId,
      source_revision: envelope.sourceRevision,
      rendition_type: envelope.renditionType,
      protected_payload: envelope.protectedPayload,
      expires_at: envelope.expiresAt,
    },
  };
}

function matchPath(pathname, regex) {
  const match = regex.exec(pathname);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export function createHermeneiaHttpServer({
  core = null,
  authenticate,
  sendService = core,
  commandService = core,
  mutationService = core,
  deliveryService = null,
  translationRecoveryService = null,
  correctionService = null,
  translationFeedbackService = null,
  deviceService = null,
  readinessService = null,
}) {
  if (!sendService || typeof sendService.sendMessage !== "function") {
    throw new TypeError("sendService.sendMessage is required");
  }
  if (
    !commandService ||
    typeof commandService.getCommandStatus !== "function"
  ) {
    throw new TypeError("commandService.getCommandStatus is required");
  }
  if (
    !mutationService ||
    typeof mutationService.editMessage !== "function" ||
    typeof mutationService.deleteMessage !== "function"
  ) {
    throw new TypeError(
      "mutationService.editMessage and mutationService.deleteMessage are required",
    );
  }
  if (
    translationRecoveryService !== null &&
    (
      typeof translationRecoveryService.resupplySource !== "function" ||
      typeof translationRecoveryService.retryTranslation !== "function"
    )
  ) {
    throw new TypeError(
      "translationRecoveryService.resupplySource and retryTranslation are required",
    );
  }
  if (
    correctionService !== null &&
    typeof correctionService.createCorrection !== "function"
  ) {
    throw new TypeError(
      "correctionService.createCorrection is required",
    );
  }
  if (
    translationFeedbackService !== null &&
    typeof translationFeedbackService.createFeedback !== "function"
  ) {
    throw new TypeError(
      "translationFeedbackService.createFeedback is required",
    );
  }

  if (
    deviceService !== null &&
    (
      typeof deviceService.enrollDevice !== "function" ||
      typeof deviceService.listDevices !== "function" ||
      typeof deviceService.rotateMaterial !== "function" ||
      typeof deviceService.revokeDevice !== "function"
    )
  ) {
    throw new TypeError(
      "deviceService enrollment/list/rotation/revocation methods are required",
    );
  }

  if (
    deliveryService !== null &&
    (
      typeof deliveryService.sync !== "function" ||
      typeof deliveryService.acknowledge !== "function"
    )
  ) {
    throw new TypeError(
      "deliveryService.sync and deliveryService.acknowledge are required",
    );
  }
  if (
    deliveryService === null &&
    (
      !core ||
      typeof core.getDeviceSyncPosition !== "function" ||
      typeof core.syncDevice !== "function" ||
      typeof core.getEnvelopeForDevice !== "function" ||
      typeof core.acknowledgeEnvelope !== "function"
    )
  ) {
    throw new TypeError(
      "deliveryService is required when no in-memory delivery core is provided",
    );
  }
  if (typeof authenticate !== "function") {
    throw new TypeError("authenticate(req) dependency is required");
  }

  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && requestUrl.pathname === "/healthz") {
        return json(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && requestUrl.pathname === "/readyz") {
        const ready = readinessService
          ? await readinessService.check()
          : true;
        return json(
          res,
          ready ? 200 : 503,
          { status: ready ? "ready" : "not_ready" },
        );
      }

      const actor = await authenticate(req);
      if (!actor) {
        throw new HttpError(401, "NOT_AUTHORIZED", "Authentication required");
      }

      if (
        (req.method === "POST" || req.method === "GET") &&
        requestUrl.pathname === "/v1/devices"
      ) {
        if (!deviceService) {
          throw new HttpError(
            503,
            "DEVICE_SERVICE_UNAVAILABLE",
            "Device trust service unavailable",
            true,
          );
        }

        if (req.method === "GET") {
          return json(
            res,
            200,
            await deviceService.listDevices(actor),
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);
        if (
          typeof body.command_id !== "string" ||
          typeof body.device_id !== "string" ||
          typeof body.public_material_ref !== "string" ||
          body.public_material_ref.length > 4096 ||
          body.public_material_ref.trim().length < 1 ||
          (
            body.platform !== undefined &&
            !["WEB","ANDROID","IOS","DESKTOP","OTHER"].includes(body.platform)
          )
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid device enrollment payload",
          );
        }

        return json(
          res,
          201,
          await deviceService.enrollDevice(actor, {
            protocol_version: 1,
            command_id: body.command_id,
            device_id: body.device_id,
            public_material_ref: body.public_material_ref,
            ...(body.platform ? { platform: body.platform } : {}),
          }),
        );
      }

      const deviceMaterialMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/devices\/([^/]+)\/delivery-material$/,
      );
      if (req.method === "PATCH" && deviceMaterialMatch) {
        if (!deviceService) {
          throw new HttpError(
            503,
            "DEVICE_SERVICE_UNAVAILABLE",
            "Device trust service unavailable",
            true,
          );
        }
        const body = await readJson(req);
        requireProtocolV1(body);
        if (
          typeof body.command_id !== "string" ||
          typeof body.expected_credential_version !== "number" ||
          !Number.isInteger(body.expected_credential_version) ||
          body.expected_credential_version < 1 ||
          typeof body.public_material_ref !== "string" ||
          body.public_material_ref.length > 4096 ||
          body.public_material_ref.trim().length < 1
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid device material rotation payload",
          );
        }

        return json(
          res,
          200,
          await deviceService.rotateMaterial(actor, {
            protocol_version: 1,
            command_id: body.command_id,
            device_id: deviceMaterialMatch[0],
            expected_credential_version:
              body.expected_credential_version,
            public_material_ref: body.public_material_ref,
          }),
        );
      }

      const deviceRevokeMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/devices\/([^/]+)\/revoke$/,
      );
      if (req.method === "POST" && deviceRevokeMatch) {
        if (!deviceService) {
          throw new HttpError(
            503,
            "DEVICE_SERVICE_UNAVAILABLE",
            "Device trust service unavailable",
            true,
          );
        }
        const body = await readJson(req);
        requireProtocolV1(body);
        if (typeof body.command_id !== "string") {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid device revocation payload",
          );
        }

        return json(
          res,
          200,
          await deviceService.revokeDevice(actor, {
            protocol_version: 1,
            command_id: body.command_id,
            device_id: deviceRevokeMatch[0],
          }),
        );
      }

      const commandStatusMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/commands\/([^/]+)$/,
      );
      if (req.method === "GET" && commandStatusMatch) {
        return json(
          res,
          200,
          await commandService.getCommandStatus(
            actor,
            commandStatusMatch[0],
          ),
        );
      }

      const sendMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/conversations\/([^/]+)\/messages$/,
      );
      if (req.method === "POST" && sendMatch) {
        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.client_message_id !== "string" ||
          !body.source ||
          typeof body.source.text !== "string"
        ) {
          throw new HttpError(400, "INVALID_COMMAND", "Invalid send payload");
        }

        const accepted = await sendService.sendMessage(actor, {
          protocol_version: 1,
          command_id: body.command_id,
          client_message_id: body.client_message_id,
          conversation_id: sendMatch[0],
          source: {
            text: body.source.text,
            ...(typeof body.source.language_hint === "string"
              ? { language_hint: body.source.language_hint }
              : {}),
          },
          ...(typeof body.reply_to_message_id === "string"
            ? { reply_to_message_id: body.reply_to_message_id }
            : {}),
          ...(typeof body.client_authored_at === "string"
            ? { client_authored_at: body.client_authored_at }
            : {}),
        });

        return json(res, 202, accepted);
      }

      const messageMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/messages\/([^/]+)$/,
      );

      if (req.method === "PATCH" && messageMatch) {
        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.expected_revision !== "number" ||
          !Number.isInteger(body.expected_revision) ||
          body.expected_revision < 1 ||
          !body.source ||
          typeof body.source.text !== "string"
        ) {
          throw new HttpError(400, "INVALID_COMMAND", "Invalid edit payload");
        }

        const result = await mutationService.editMessage(actor, {
          protocol_version: 1,
          command_id: body.command_id,
          message_id: messageMatch[0],
          expected_revision: body.expected_revision,
          source: {
            text: body.source.text,
            ...(typeof body.source.language_hint === "string"
              ? { language_hint: body.source.language_hint }
              : {}),
          },
        });

        return json(res, 200, result);
      }

      if (req.method === "DELETE" && messageMatch) {
        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.expected_revision !== "number" ||
          !Number.isInteger(body.expected_revision) ||
          body.expected_revision < 1
        ) {
          throw new HttpError(400, "INVALID_COMMAND", "Invalid delete payload");
        }

        const result = await mutationService.deleteMessage(actor, {
          protocol_version: 1,
          command_id: body.command_id,
          message_id: messageMatch[0],
          expected_revision: body.expected_revision,
        });

        return json(res, 200, result);
      }

      const translationFeedbackMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/translations\/([^/]+)\/feedback$/,
      );

      if (req.method === "POST" && translationFeedbackMatch) {
        if (!translationFeedbackService) {
          throw new HttpError(
            503,
            "INTERNAL_ERROR",
            "Translation feedback service unavailable",
            true,
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.kind !== "string" ||
          (
            body.note !== undefined &&
            typeof body.note !== "string"
          )
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid translation feedback payload",
          );
        }

        const result =
          await translationFeedbackService.createFeedback(
            actor,
            {
              protocol_version: 1,
              command_id: body.command_id,
              translation_id:
                translationFeedbackMatch[0],
              kind: body.kind,
              ...(body.note !== undefined
                ? { note: body.note }
                : {}),
            },
          );

        return json(res, 202, result);
      }

      const correctionReviewMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/conversations\/([^/]+)\/repairs\/([^/]+)\/review$/,
      );

      if (req.method === "POST" && correctionReviewMatch) {
        if (
          !correctionService ||
          typeof correctionService.reviewCorrection !== "function"
        ) {
          throw new HttpError(
            503,
            "INTERNAL_ERROR",
            "Correction review service unavailable",
            true,
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.decision !== "string"
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid correction review payload",
          );
        }

        const result =
          await correctionService.reviewCorrection(
            actor,
            {
              protocol_version: 1,
              command_id: body.command_id,
              conversation_id:
                correctionReviewMatch[0],
              repair_event_id:
                correctionReviewMatch[1],
              decision: body.decision,
            },
          );

        return json(res, 202, result);
      }

      const correctionRevocationMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/conversations\/([^/]+)\/corrections\/([^/]+)\/revoke$/,
      );

      if (req.method === "POST" && correctionRevocationMatch) {
        if (
          !correctionService ||
          typeof correctionService.revokeCorrection !== "function"
        ) {
          throw new HttpError(
            503,
            "INTERNAL_ERROR",
            "Correction revocation service unavailable",
            true,
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);

        if (typeof body.command_id !== "string") {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid correction revocation payload",
          );
        }

        const result =
          await correctionService.revokeCorrection(
            actor,
            {
              protocol_version: 1,
              command_id: body.command_id,
              conversation_id:
                correctionRevocationMatch[0],
              claim_id:
                correctionRevocationMatch[1],
            },
          );

        return json(res, 202, result);
      }

      const correctionMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/conversations\/([^/]+)\/corrections$/,
      );

      if (req.method === "POST" && correctionMatch) {
        if (!correctionService) {
          throw new HttpError(
            503,
            "INTERNAL_ERROR",
            "Correction service unavailable",
            true,
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.kind !== "string" ||
          typeof body.requested_scope !== "string" ||
          !body.payload ||
          typeof body.payload !== "object" ||
          Array.isArray(body.payload)
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid correction payload",
          );
        }

        const result =
          await correctionService.createCorrection(
            actor,
            {
              protocol_version: 1,
              command_id: body.command_id,
              conversation_id: correctionMatch[0],
              ...(body.target_message_id === null ||
              typeof body.target_message_id === "string"
                ? {
                    target_message_id:
                      body.target_message_id,
                  }
                : {}),
              ...(body.target_source_revision === null ||
              typeof body.target_source_revision === "number"
                ? {
                    target_source_revision:
                      body.target_source_revision,
                  }
                : {}),
              ...(body.target_translation_id === null ||
              typeof body.target_translation_id === "string"
                ? {
                    target_translation_id:
                      body.target_translation_id,
                  }
                : {}),
              kind: body.kind,
              requested_scope:
                body.requested_scope,
              payload: body.payload,
            },
          );

        return json(res, 202, result);
      }

      const translationSourceMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/translations\/([^/]+)\/source$/,
      );

      if (req.method === "POST" && translationSourceMatch) {
        if (!translationRecoveryService) {
          throw new HttpError(
            503,
            "PROVIDER_UNAVAILABLE",
            "Translation recovery service unavailable",
            true,
          );
        }

        const body = await readJson(req);
        requireProtocolV1(body);

        if (
          typeof body.command_id !== "string" ||
          typeof body.message_id !== "string" ||
          typeof body.source_revision !== "number" ||
          !Number.isInteger(body.source_revision) ||
          body.source_revision < 1 ||
          typeof body.source_ref !== "string" ||
          body.source_ref.length < 16 ||
          !body.source ||
          typeof body.source.text !== "string" ||
          body.source.text.length < 1
        ) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            "Invalid source re-supply payload",
          );
        }

        const result =
          await translationRecoveryService.resupplySource(actor, {
            protocol_version: 1,
            command_id: body.command_id,
            translation_id: translationSourceMatch[0],
            message_id: body.message_id,
            source_revision: body.source_revision,
            source_ref: body.source_ref,
            source: {
              text: body.source.text,
              ...(typeof body.source.language_hint === "string"
                ? { language_hint: body.source.language_hint }
                : {}),
            },
          });

        return json(res, 202, result);
      }

      const translationRetryMatch = matchPath(
        requestUrl.pathname,
        /^\/v1\/translations\/([^/]+)\/retry$/,
      );

      if (req.method === "POST" && translationRetryMatch) {
        if (!translationRecoveryService) {
          throw new HttpError(
            503,
            "PROVIDER_UNAVAILABLE",
            "Translation recovery service unavailable",
            true,
          );
        }

        const result =
          await translationRecoveryService.retryTranslation(
            actor,
            translationRetryMatch[0],
          );

        return json(res, 202, result);
      }

      if (req.method === "GET" && requestUrl.pathname === "/v1/sync") {
        const limit = Math.min(
          MAX_SYNC_LIMIT,
          Math.max(1, Number(requestUrl.searchParams.get("limit") ?? 100) || 100),
        );
        const waitMs = Math.min(
          MAX_WAIT_MS,
          Math.max(0, Number(requestUrl.searchParams.get("wait_ms") ?? 0) || 0),
        );

        if (deliveryService) {
          const syncInput = {
            ...(requestUrl.searchParams.get("cursor")
              ? { cursor: requestUrl.searchParams.get("cursor") }
              : {}),
            limit,
          };

          let result = await deliveryService.sync(actor, syncInput);
          if (
            result.kind === "OK" &&
            result.response.events.length === 0 &&
            waitMs > 0
          ) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            result = await deliveryService.sync(actor, syncInput);
          }

          return json(
            res,
            result.kind === "RESET" ? 409 : 200,
            result.response,
          );
        }

        const position = core.getDeviceSyncPosition(actor.deviceId);
        const parsed = parseCursor(
          requestUrl.searchParams.get("cursor"),
          position.inboxEpoch,
        );

        if (parsed.epoch !== position.inboxEpoch) {
          return json(res, 409, {
            protocol_version: 1,
            code: "SYNC_RESET_REQUIRED",
            new_cursor: cursor(position.inboxEpoch, 0),
            events: [],
          });
        }

        let events = core.syncDevice(actor.deviceId, parsed.offset);
        if (!events.length && waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          events = core.syncDevice(actor.deviceId, parsed.offset);
        }

        const selected = events.slice(0, limit);
        const normalized = selected.map((event) =>
          normalizeSyncEvent(core, actor.deviceId, event),
        );
        const lastOffset = selected.length
          ? selected[selected.length - 1].offset
          : parsed.offset;

        return json(res, 200, {
          protocol_version: 1,
          events: normalized,
          next_cursor: cursor(position.inboxEpoch, lastOffset),
        });
      }

      if (req.method === "POST" && requestUrl.pathname === "/v1/delivery/acks") {
        const body = await readJson(req);
        requireProtocolV1(body);

        if (!Array.isArray(body.acks) || body.acks.length < 1 || body.acks.length > MAX_ACKS) {
          throw new HttpError(400, "INVALID_COMMAND", "acks must contain 1..100 items");
        }

        for (const ack of body.acks) {
          if (
            !ack ||
            typeof ack.envelope_id !== "string" ||
            typeof ack.persisted_at !== "string" ||
            !Number.isFinite(Date.parse(ack.persisted_at))
          ) {
            throw new HttpError(400, "INVALID_COMMAND", "Invalid delivery ACK");
          }
        }

        if (deliveryService) {
          await deliveryService.acknowledge(actor, body.acks);
          return noContent(res);
        }

        for (const ack of body.acks) {
          core.acknowledgeEnvelope(actor.deviceId, ack.envelope_id);
        }

        return noContent(res);
      }

      throw new HttpError(404, "NOT_FOUND", "Route not found");
    } catch (error) {
      const mapped = mapError(error);
      return json(res, mapped.status, mapped.body);
    }
  });
}
