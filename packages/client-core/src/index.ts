import type {
  CommandStatusResult,
  MessageRevisionResult,
  UUID,
} from "../../domain/src/index.js";
import type {
  AcceptedMessageResponse,
  ApiErrorBody,
  DeleteMessageCommand,
  DeliveryAckInput,
  EditMessageCommand,
  SendMessageCommand,
  ServerEvent,
  SourceContent,
  SyncResponse,
} from "../../protocol/src/index.js";

export type ClientNetworkState = "OFFLINE" | "ONLINE";

export type LocalOutgoingState =
  | "QUEUED_LOCAL"
  | "SENDING"
  | "RETRY_WAIT"
  | "ACCEPTED"
  | "FAILED_PERMANENT";

export interface LocalOutgoingMessage {
  localId: UUID;
  commandId: UUID;
  clientMessageId: UUID;
  conversationId: UUID;
  source: SourceContent;
  state: LocalOutgoingState;
  accepted?: AcceptedMessageResponse;
  lastErrorCode?: string;
}

export interface LocalIncomingEnvelope {
  eventId: UUID;
  envelopeId: UUID;
  conversationId: UUID | null;
  messageId: UUID;
  sourceRevision: number;
  renditionType: "ORIGINAL" | "TRANSLATION";
  protectedPayload: string;
  expiresAt: string;
  persistedAt: string;
}

export interface PendingDeliveryAck {
  envelopeId: UUID;
  persistedAt: string;
}

export interface ClientIdFactory {
  next(prefix: string): UUID;
}

export interface ClientClock {
  now(): string;
}

export interface MessagingTransport {
  send(command: SendMessageCommand): Promise<AcceptedMessageResponse>;
  edit(command: EditMessageCommand): Promise<MessageRevisionResult>;
  delete(command: DeleteMessageCommand): Promise<MessageRevisionResult>;
  commandStatus(commandId: UUID): Promise<CommandStatusResult>;
  sync(cursor?: string): Promise<SyncResponse>;
  acknowledge(acks: DeliveryAckInput[]): Promise<void>;
}

export class TransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ClientStore {
  putOutgoing(message: LocalOutgoingMessage): void;
  getOutgoing(localId: UUID): LocalOutgoingMessage | undefined;
  listOutgoing(): LocalOutgoingMessage[];
  updateOutgoing(localId: UUID, patch: Partial<LocalOutgoingMessage>): void;

  getSyncCursor(): string | undefined;

  applyIncomingEventAtomically(
    event: ServerEvent,
    envelope: LocalIncomingEnvelope,
  ): void;

  applyDeleteEventAtomically(event: ServerEvent, messageId: UUID): void;
  applyControlEventAtomically(event: ServerEvent): void;

  hasAppliedEvent(eventId: UUID): boolean;
  listIncoming(): LocalIncomingEnvelope[];

  listPendingAcks(): PendingDeliveryAck[];
  removePendingAcks(envelopeIds: UUID[]): void;
}

export class InMemoryClientStore implements ClientStore {
  private readonly outgoing = new Map<UUID, LocalOutgoingMessage>();
  private readonly incoming = new Map<UUID, LocalIncomingEnvelope>();
  private readonly appliedEvents = new Set<UUID>();
  private readonly pendingAcks = new Map<UUID, PendingDeliveryAck>();
  private syncCursor?: string;

  putOutgoing(message: LocalOutgoingMessage): void {
    this.outgoing.set(message.localId, structuredClone(message));
  }

  getOutgoing(localId: UUID): LocalOutgoingMessage | undefined {
    const value = this.outgoing.get(localId);
    return value ? structuredClone(value) : undefined;
  }

  listOutgoing(): LocalOutgoingMessage[] {
    return [...this.outgoing.values()].map((value) => structuredClone(value));
  }

  updateOutgoing(localId: UUID, patch: Partial<LocalOutgoingMessage>): void {
    const current = this.outgoing.get(localId);
    if (!current) {
      throw new Error(`Unknown local message ${localId}`);
    }
    this.outgoing.set(localId, structuredClone({ ...current, ...patch }));
  }

  getSyncCursor(): string | undefined {
    return this.syncCursor;
  }

  applyIncomingEventAtomically(
    event: ServerEvent,
    envelope: LocalIncomingEnvelope,
  ): void {
    if (this.appliedEvents.has(event.event_id)) {
      this.syncCursor = event.cursor;
      return;
    }

    // One synchronous store mutation models the transaction boundary required
    // from IndexedDB/SQLite adapters: envelope + event id + cursor + pending ACK.
    this.incoming.set(envelope.messageId, structuredClone(envelope));
    this.appliedEvents.add(event.event_id);
    this.pendingAcks.set(envelope.envelopeId, {
      envelopeId: envelope.envelopeId,
      persistedAt: envelope.persistedAt,
    });
    this.syncCursor = event.cursor;
  }

  applyDeleteEventAtomically(event: ServerEvent, messageId: UUID): void {
    this.incoming.delete(messageId);
    this.appliedEvents.add(event.event_id);
    this.syncCursor = event.cursor;
  }

  applyControlEventAtomically(event: ServerEvent): void {
    this.appliedEvents.add(event.event_id);
    this.syncCursor = event.cursor;
  }

  hasAppliedEvent(eventId: UUID): boolean {
    return this.appliedEvents.has(eventId);
  }

  listIncoming(): LocalIncomingEnvelope[] {
    return [...this.incoming.values()].map((value) => structuredClone(value));
  }

  listPendingAcks(): PendingDeliveryAck[] {
    return [...this.pendingAcks.values()].map((value) => ({ ...value }));
  }

  removePendingAcks(envelopeIds: UUID[]): void {
    for (const envelopeId of envelopeIds) {
      this.pendingAcks.delete(envelopeId);
    }
  }
}

export interface ClientMessagingEngineDependencies {
  store: ClientStore;
  transport: MessagingTransport;
  ids: ClientIdFactory;
  clock: ClientClock;
}

export class ClientMessagingEngine {
  private networkState: ClientNetworkState = "OFFLINE";

  constructor(private readonly deps: ClientMessagingEngineDependencies) {}

  setNetworkState(state: ClientNetworkState): void {
    this.networkState = state;
  }

  queueMessage(conversationId: UUID, source: SourceContent): LocalOutgoingMessage {
    const localId = this.deps.ids.next("local");
    const message: LocalOutgoingMessage = {
      localId,
      commandId: this.deps.ids.next("cmd"),
      clientMessageId: this.deps.ids.next("client-msg"),
      conversationId,
      source: structuredClone(source),
      state: "QUEUED_LOCAL",
    };
    this.deps.store.putOutgoing(message);
    return structuredClone(message);
  }

  async flushOutbox(): Promise<void> {
    if (this.networkState !== "ONLINE") {
      return;
    }

    const candidates = this.deps.store
      .listOutgoing()
      .filter((message) =>
        message.state === "QUEUED_LOCAL" || message.state === "RETRY_WAIT"
      );

    for (const message of candidates) {
      this.deps.store.updateOutgoing(message.localId, { state: "SENDING" });

      const command: SendMessageCommand = {
        protocol_version: 1,
        command_id: message.commandId,
        client_message_id: message.clientMessageId,
        conversation_id: message.conversationId,
        source: structuredClone(message.source),
      };

      try {
        const accepted = await this.deps.transport.send(command);
        this.deps.store.updateOutgoing(message.localId, {
          state: "ACCEPTED",
          accepted,
          lastErrorCode: undefined,
        });
      } catch (error) {
        if (error instanceof TransportError && !error.retryable) {
          this.deps.store.updateOutgoing(message.localId, {
            state: "FAILED_PERMANENT",
            lastErrorCode: error.code,
          });
          continue;
        }

        this.deps.store.updateOutgoing(message.localId, {
          state: "RETRY_WAIT",
          lastErrorCode:
            error instanceof TransportError ? error.code : "NETWORK_ERROR",
        });
      }
    }
  }

  async syncOnce(): Promise<void> {
    if (this.networkState !== "ONLINE") {
      return;
    }

    const response = await this.deps.transport.sync(this.deps.store.getSyncCursor());

    for (const event of response.events) {
      if (this.deps.store.hasAppliedEvent(event.event_id)) {
        continue;
      }
      if (event.type === "message.deleted") {
        const messageId = asString(event.payload.message_id, "message_id");
        this.deps.store.applyDeleteEventAtomically(event, messageId);
        continue;
      }

      if (
        event.type !== "message.available" &&
        event.type !== "message.edited"
      ) {
        this.deps.store.applyControlEventAtomically(event);
        continue;
      }

      const payload = event.payload;
      const envelopeId = asString(payload.envelope_id, "envelope_id");
      const messageId = asString(payload.message_id, "message_id");
      const sourceRevision = asPositiveInteger(payload.source_revision, "source_revision");
      const renditionType = asRenditionType(payload.rendition_type);
      const protectedPayload = asString(payload.protected_payload, "protected_payload");
      const expiresAt = asString(payload.expires_at, "expires_at");
      const persistedAt = this.deps.clock.now();

      this.deps.store.applyIncomingEventAtomically(event, {
        eventId: event.event_id,
        envelopeId,
        conversationId: event.conversation_id ?? null,
        messageId,
        sourceRevision,
        renditionType,
        protectedPayload,
        expiresAt,
        persistedAt,
      });
    }

    await this.flushPendingAcks();
  }

  async flushPendingAcks(): Promise<void> {
    if (this.networkState !== "ONLINE") {
      return;
    }

    const pending = this.deps.store.listPendingAcks();
    if (!pending.length) {
      return;
    }

    try {
      await this.deps.transport.acknowledge(
        pending.map((ack) => ({
          envelope_id: ack.envelopeId,
          persisted_at: ack.persistedAt,
        })),
      );
      this.deps.store.removePendingAcks(
        pending.map((ack) => ack.envelopeId),
      );
    } catch {
      // The local payload and cursor are already durable. ACK can retry later.
    }
  }
}

export interface HttpMessagingTransportOptions {
  baseUrl: string;
  headers: () => Record<string, string>;
}

export class HttpMessagingTransport implements MessagingTransport {
  constructor(private readonly options: HttpMessagingTransportOptions) {}

  async send(command: SendMessageCommand): Promise<AcceptedMessageResponse> {
    const response = await this.request(
      `/v1/conversations/${encodeURIComponent(command.conversation_id)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          protocol_version: command.protocol_version,
          command_id: command.command_id,
          client_message_id: command.client_message_id,
          source: command.source,
          reply_to_message_id: command.reply_to_message_id ?? null,
          client_authored_at: command.client_authored_at ?? null,
        }),
      },
    );
    return (await response.json()) as AcceptedMessageResponse;
  }

  async edit(command: EditMessageCommand): Promise<MessageRevisionResult> {
    const response = await this.request(
      `/v1/messages/${encodeURIComponent(command.message_id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          protocol_version: command.protocol_version,
          command_id: command.command_id,
          expected_revision: command.expected_revision,
          source: command.source,
        }),
      },
    );
    return (await response.json()) as MessageRevisionResult;
  }

  async delete(command: DeleteMessageCommand): Promise<MessageRevisionResult> {
    const response = await this.request(
      `/v1/messages/${encodeURIComponent(command.message_id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          protocol_version: command.protocol_version,
          command_id: command.command_id,
          expected_revision: command.expected_revision,
        }),
      },
    );
    return (await response.json()) as MessageRevisionResult;
  }

  async commandStatus(commandId: UUID): Promise<CommandStatusResult> {
    const response = await this.request(
      `/v1/commands/${encodeURIComponent(commandId)}`,
      { method: "GET" },
    );
    return (await response.json()) as CommandStatusResult;
  }

  async sync(cursor?: string): Promise<SyncResponse> {
    const url = new URL("/v1/sync", this.options.baseUrl);
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await this.request(url.pathname + url.search, {
      method: "GET",
    });
    return (await response.json()) as SyncResponse;
  }

  async acknowledge(acks: DeliveryAckInput[]): Promise<void> {
    await this.request("/v1/delivery/acks", {
      method: "POST",
      body: JSON.stringify({
        protocol_version: 1,
        acks,
      }),
    });
  }

  private async request(
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method: init.method,
        headers: {
          "content-type": "application/json",
          ...this.options.headers(),
        },
        body: init.body,
      });
    } catch (error) {
      throw new TransportError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Network request failed",
        true,
      );
    }

    if (response.ok) {
      return response;
    }

    let apiError: ApiErrorBody | undefined;
    try {
      apiError = (await response.json()) as ApiErrorBody;
    } catch {
      // Use generic HTTP classification below.
    }

    const retryable =
      apiError?.retryable ??
      (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      );

    throw new TransportError(
      apiError?.code ?? `HTTP_${response.status}`,
      apiError?.message ?? `HTTP ${response.status}`,
      retryable,
      response.status,
    );
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid sync payload field: ${field}`);
  }
  return value;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid sync payload field: ${field}`);
  }
  return value;
}

function asRenditionType(value: unknown): "ORIGINAL" | "TRANSLATION" {
  if (value !== "ORIGINAL" && value !== "TRANSLATION") {
    throw new Error("Invalid sync payload field: rendition_type");
  }
  return value;
}
