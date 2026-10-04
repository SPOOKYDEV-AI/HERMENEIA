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
        return { status: 409, body: errorBody(error.code, error.message, false) };
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

      const actor = await authenticate(req);
      if (!actor) {
        throw new HttpError(401, "NOT_AUTHORIZED", "Authentication required");
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
