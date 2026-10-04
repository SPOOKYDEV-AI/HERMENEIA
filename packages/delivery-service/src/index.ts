import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import type {
  DeliveryAckInput,
  ServerEvent,
  SyncResponse,
} from "../../protocol/src/index.js";

export interface PersistentInboxEvent {
  inboxEpoch: number;
  offset: number;
  eventId: UUID;
  eventType:
    | "message.available"
    | "message.edited"
    | "message.deleted"
    | "translation.source_required";
  tenantId: UUID;
  conversationId: UUID;
  messageId: UUID;
  envelopeId: UUID | null;
  sourceRevision: number;
  protectedPayload: string | null;
  renditionType: "ORIGINAL" | "TRANSLATION" | null;
  envelopeStatus:
    | "PENDING"
    | "ACKED"
    | "EXPIRED"
    | "REVOKED"
    | null;
  expiresAt: string | null;
  translationId: UUID | null;
  sourceRef: string | null;
  createdAt: string;
}

export interface PersistentDeliveryStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  getDeviceSyncState(
    tx: Tx,
    actor: ActorContext,
  ): Promise<{
    inboxEpoch: number;
    nextOffset: number;
    lastAckedOffset: number;
  } | undefined>;

  listInboxEvents(
    tx: Tx,
    input: {
      tenantId: UUID;
      deviceId: UUID;
      inboxEpoch: number;
      afterOffset: number;
      limit: number;
    },
  ): Promise<PersistentInboxEvent[]>;

  acknowledgeEnvelope(
    tx: Tx,
    input: {
      tenantId: UUID;
      deviceId: UUID;
      envelopeId: UUID;
      ackedAt: string;
    },
  ): Promise<
    "ACKED" |
    "ALREADY_ACKED" |
    "EXPIRED" |
    "REVOKED" |
    "NOT_FOUND"
  >;
}

export interface PersistentDeliveryClock {
  now(): string;
}

export type SyncCursorDecision =
  | { kind: "CONTINUE"; afterOffset: number }
  | { kind: "RESET_EPOCH"; currentEpoch: number }
  | { kind: "RESET_AHEAD"; maximumIssuedOffset: number };

export function evaluateSyncCursor(
  state: {
    inboxEpoch: number;
    nextOffset: number;
    lastAckedOffset: number;
  },
  requested: {
    inboxEpoch: number;
    afterOffset: number;
  },
): SyncCursorDecision {
  if (requested.inboxEpoch !== state.inboxEpoch) {
    return {
      kind: "RESET_EPOCH",
      currentEpoch: state.inboxEpoch,
    };
  }

  const maximumIssuedOffset = Math.max(0, state.nextOffset - 1);
  if (requested.afterOffset > maximumIssuedOffset) {
    return {
      kind: "RESET_AHEAD",
      maximumIssuedOffset,
    };
  }

  return {
    kind: "CONTINUE",
    afterOffset: requested.afterOffset,
  };
}

export type PersistentSyncResult =
  | {
      kind: "OK";
      response: SyncResponse;
    }
  | {
      kind: "RESET";
      response: {
        protocol_version: 1;
        code: "SYNC_RESET_REQUIRED";
        new_cursor: string;
        events: ServerEvent[];
      };
    };

export class PersistentDeliveryService<Tx> {
  constructor(
    private readonly store: PersistentDeliveryStore<Tx>,
    private readonly clock: PersistentDeliveryClock,
  ) {}

  async sync(
    actor: ActorContext,
    input: {
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<PersistentSyncResult> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Sync limit must be an integer between 1 and 200",
      );
    }

    return this.store.withTransaction(async (tx) => {
      const state = await this.store.getDeviceSyncState(tx, actor);
      if (!state) {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Device sync state is not available to actor",
        );
      }

      const requested = parseCursor(
        input.cursor,
        state.inboxEpoch,
      );
      if (!requested) {
        return resetResponse(
          state.inboxEpoch,
          0,
        );
      }

      const decision = evaluateSyncCursor(state, requested);
      if (decision.kind !== "CONTINUE") {
        const resetOffset =
          decision.kind === "RESET_AHEAD"
            ? decision.maximumIssuedOffset
            : 0;
        return resetResponse(state.inboxEpoch, resetOffset);
      }

      const rows = await this.store.listInboxEvents(tx, {
        tenantId: actor.tenantId,
        deviceId: actor.deviceId,
        inboxEpoch: state.inboxEpoch,
        afterOffset: decision.afterOffset,
        limit,
      });

      const events: ServerEvent[] = [];
      let nextOffset = decision.afterOffset;

      for (const row of rows) {
        if (row.tenantId !== actor.tenantId) {
          throw new Error(
            "Invariant violation: cross-tenant inbox event returned",
          );
        }

        if (row.eventType === "message.deleted") {
          events.push(normalizeDelete(row));
          nextOffset = row.offset;
          continue;
        }

        if (row.eventType === "translation.source_required") {
          if (!row.translationId || !row.sourceRef) {
            throw new Error(
              "Invariant violation: source-required event metadata missing",
            );
          }
          events.push(normalizeSourceRequired(row));
          nextOffset = row.offset;
          continue;
        }

        if (
          row.envelopeStatus === "ACKED" ||
          row.envelopeStatus === "REVOKED"
        ) {
          nextOffset = row.offset;
          continue;
        }

        if (
          row.envelopeStatus !== "PENDING" ||
          !row.envelopeId ||
          !row.protectedPayload ||
          !row.renditionType ||
          !row.expiresAt
        ) {
          if (events.length > 0) {
            break;
          }
          return resetResponse(state.inboxEpoch, row.offset);
        }

        events.push(normalizeContent(row));
        nextOffset = row.offset;
      }

      return {
        kind: "OK",
        response: {
          protocol_version: 1,
          events,
          next_cursor: cursor(state.inboxEpoch, nextOffset),
        },
      };
    });
  }

  async acknowledge(
    actor: ActorContext,
    acks: DeliveryAckInput[],
  ): Promise<void> {
    if (!Array.isArray(acks) || acks.length < 1 || acks.length > 100) {
      throw new DomainError(
        "INVALID_COMMAND",
        "ACK batch must contain 1..100 items",
      );
    }

    for (const ack of acks) {
      if (
        !ack ||
        typeof ack.envelope_id !== "string" ||
        typeof ack.persisted_at !== "string" ||
        !Number.isFinite(Date.parse(ack.persisted_at))
      ) {
        throw new DomainError(
          "INVALID_COMMAND",
          "Invalid delivery ACK",
        );
      }
    }

    const ackedAt = this.clock.now();
    if (!Number.isFinite(Date.parse(ackedAt))) {
      throw new Error("Clock returned an invalid timestamp");
    }

    await this.store.withTransaction(async (tx) => {
      for (const ack of acks) {
        const result = await this.store.acknowledgeEnvelope(tx, {
          tenantId: actor.tenantId,
          deviceId: actor.deviceId,
          envelopeId: ack.envelope_id,
          ackedAt,
        });

        if (result === "ACKED" || result === "ALREADY_ACKED") {
          continue;
        }
        if (result === "EXPIRED") {
          throw new DomainError(
            "DELIVERY_EXPIRED",
            "Envelope is no longer deliverable",
          );
        }
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Envelope is not available to device",
        );
      }
    });
  }
}

function parseCursor(
  value: string | undefined,
  currentEpoch: number,
): { inboxEpoch: number; afterOffset: number } | undefined {
  if (!value) {
    return {
      inboxEpoch: currentEpoch,
      afterOffset: 0,
    };
  }

  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;

  const inboxEpoch = Number(match[1]);
  const afterOffset = Number(match[2]);
  if (
    !Number.isSafeInteger(inboxEpoch) ||
    inboxEpoch < 1 ||
    !Number.isSafeInteger(afterOffset) ||
    afterOffset < 0
  ) {
    return undefined;
  }

  return { inboxEpoch, afterOffset };
}

function cursor(inboxEpoch: number, offset: number): string {
  return `${inboxEpoch}:${offset}`;
}

function resetResponse(
  inboxEpoch: number,
  offset: number,
): PersistentSyncResult {
  return {
    kind: "RESET",
    response: {
      protocol_version: 1,
      code: "SYNC_RESET_REQUIRED",
      new_cursor: cursor(inboxEpoch, offset),
      events: [],
    },
  };
}

function baseEvent(row: PersistentInboxEvent): Omit<ServerEvent, "payload"> {
  return {
    protocol_version: 1,
    event_id: row.eventId,
    cursor: cursor(row.inboxEpoch, row.offset),
    type: row.eventType,
    server_time: row.createdAt,
    tenant_id: row.tenantId,
    conversation_id: row.conversationId,
  };
}

function normalizeDelete(row: PersistentInboxEvent): ServerEvent {
  return {
    ...baseEvent(row),
    payload: {
      message_id: row.messageId,
      source_revision: row.sourceRevision,
    },
  };
}

function normalizeSourceRequired(
  row: PersistentInboxEvent,
): ServerEvent {
  if (!row.translationId || !row.sourceRef) {
    throw new Error(
      "Invariant violation: source-required event metadata missing",
    );
  }

  return {
    ...baseEvent(row),
    payload: {
      translation_id: row.translationId,
      message_id: row.messageId,
      source_revision: row.sourceRevision,
      source_ref: row.sourceRef,
    },
  };
}

function normalizeContent(row: PersistentInboxEvent): ServerEvent {
  return {
    ...baseEvent(row),
    payload: {
      message_id: row.messageId,
      envelope_id: row.envelopeId,
      source_revision: row.sourceRevision,
      rendition_type: row.renditionType,
      protected_payload: row.protectedPayload,
      expires_at: row.expiresAt,
    },
  };
}
