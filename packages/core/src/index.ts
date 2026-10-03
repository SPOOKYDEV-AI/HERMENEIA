import type {
  AcceptedMessage,
  ActorContext,
  DeliveryEnvelope,
  DeviceInboxEvent,
  MessageMetadata,
  TranslationJob,
  UUID,
} from "../../domain/src/index.js";
import { DomainError } from "../../domain/src/index.js";
import type { SendMessageCommand, SourceContent } from "../../protocol/src/index.js";

export interface IdFactory {
  next(prefix: string): UUID;
}

export interface Clock {
  now(): string;
}

export interface SourceFingerprinter {
  fingerprint(source: SourceContent): string;
}

export interface EnvelopeProtector {
  protect(input: {
    tenantId: UUID;
    conversationId: UUID;
    messageId: UUID;
    sourceRevision: number;
    recipientDeviceId: UUID;
    source: SourceContent;
  }): string;
}

export interface TranslationDispatcher {
  notify(job: TranslationJob): void;
}

interface DeviceRecord {
  deviceId: UUID;
  userId: UUID;
  status: "ACTIVE" | "REVOKED";
  inboxEpoch: number;
  nextOffset: number;
}

interface ConversationRecord {
  tenantId: UUID;
  conversationId: UUID;
  members: Set<UUID>;
  nextMessageSeq: number;
  nextOpSeq: number;
}

interface DedupeRecord {
  fingerprint: string;
  accepted: AcceptedMessage;
}

export interface MessagingCoreDependencies {
  ids: IdFactory;
  clock: Clock;
  fingerprinter: SourceFingerprinter;
  envelopeProtector: EnvelopeProtector;
  translationDispatcher?: TranslationDispatcher;
  envelopeTtlSeconds?: number;
}

export class InMemoryMessagingCore {
  private readonly devices = new Map<UUID, DeviceRecord>();
  private readonly conversations = new Map<UUID, ConversationRecord>();
  private readonly messages = new Map<UUID, MessageMetadata>();
  private readonly dedupe = new Map<string, DedupeRecord>();
  private readonly envelopes = new Map<UUID, DeliveryEnvelope>();
  private readonly inboxEvents = new Map<UUID, DeviceInboxEvent[]>();
  private readonly translationJobs = new Map<UUID, TranslationJob>();
  private readonly envelopeTtlSeconds: number;

  constructor(private readonly deps: MessagingCoreDependencies) {
    this.envelopeTtlSeconds = deps.envelopeTtlSeconds ?? 7 * 24 * 60 * 60;
  }

  registerDevice(userId: UUID, deviceId: UUID): void {
    this.devices.set(deviceId, {
      deviceId,
      userId,
      status: "ACTIVE",
      inboxEpoch: 1,
      nextOffset: 1,
    });
    this.inboxEvents.set(deviceId, []);
  }

  revokeDevice(deviceId: UUID): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.status = "REVOKED";
  }

  registerConversation(tenantId: UUID, conversationId: UUID, memberUserIds: UUID[]): void {
    this.conversations.set(conversationId, {
      tenantId,
      conversationId,
      members: new Set(memberUserIds),
      nextMessageSeq: 1,
      nextOpSeq: 1,
    });
  }

  async sendMessage(
    actor: ActorContext,
    command: SendMessageCommand,
  ): Promise<AcceptedMessage> {
    this.assertActorDevice(actor);

    const conversation = this.conversations.get(command.conversation_id);
    if (
      !conversation ||
      conversation.tenantId !== actor.tenantId ||
      !conversation.members.has(actor.userId)
    ) {
      throw new DomainError("NOT_AUTHORIZED", "Conversation is not available to actor");
    }

    if (!command.source.text) {
      throw new DomainError("INVALID_COMMAND", "Source text is required");
    }

    const fingerprint = this.deps.fingerprinter.fingerprint(command.source);
    const dedupeKey = [
      actor.tenantId,
      actor.userId,
      command.client_message_id,
    ].join(":");

    const previous = this.dedupe.get(dedupeKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "client_message_id was already used with different source content",
        );
      }
      return previous.accepted;
    }

    const now = this.deps.clock.now();
    const messageId = this.deps.ids.next("msg");
    const messageSeq = conversation.nextMessageSeq;
    const _opSeq = conversation.nextOpSeq;

    const message: MessageMetadata = {
      tenantId: actor.tenantId,
      messageId,
      conversationId: conversation.conversationId,
      authorUserId: actor.userId,
      authorDeviceId: actor.deviceId,
      clientMessageId: command.client_message_id,
      messageSeq,
      currentRevision: 1,
      status: "ACTIVE",
      acceptedAt: now,
    };

    const preparedEnvelopes: DeliveryEnvelope[] = [];
    const preparedEvents: DeviceInboxEvent[] = [];

    for (const device of this.devices.values()) {
      if (
        device.status !== "ACTIVE" ||
        device.deviceId === actor.deviceId ||
        !conversation.members.has(device.userId)
      ) {
        continue;
      }

      const envelopeId = this.deps.ids.next("env");
      const expiresAt = new Date(
        Date.parse(now) + this.envelopeTtlSeconds * 1000,
      ).toISOString();

      preparedEnvelopes.push({
        tenantId: actor.tenantId,
        envelopeId,
        conversationId: conversation.conversationId,
        messageId,
        sourceRevision: 1,
        recipientUserId: device.userId,
        recipientDeviceId: device.deviceId,
        renditionType: "ORIGINAL",
        protectedPayload: this.deps.envelopeProtector.protect({
          tenantId: actor.tenantId,
          conversationId: conversation.conversationId,
          messageId,
          sourceRevision: 1,
          recipientDeviceId: device.deviceId,
          source: command.source,
        }),
        status: "PENDING",
        createdAt: now,
        expiresAt,
      });

      preparedEvents.push({
        deviceId: device.deviceId,
        inboxEpoch: device.inboxEpoch,
        offset: device.nextOffset,
        eventId: this.deps.ids.next("evt"),
        type: "message.available",
        tenantId: actor.tenantId,
        conversationId: conversation.conversationId,
        messageId,
        envelopeId,
        createdAt: now,
      });
    }

    const translationJob: TranslationJob = {
      jobId: this.deps.ids.next("job"),
      messageId,
      sourceRevision: 1,
      status: "AVAILABLE",
      createdAt: now,
    };

    const accepted: AcceptedMessage = {
      protocol_version: 1,
      status: "ACCEPTED",
      message_id: messageId,
      message_seq: messageSeq,
      source_revision: 1,
      accepted_at: now,
      translation_status: "PENDING",
    };

    // In-memory equivalent of one durable transaction: all failure-prone envelope
    // protection is complete before state is mutated.
    conversation.nextMessageSeq += 1;
    conversation.nextOpSeq += 1;
    this.messages.set(messageId, message);
    for (const envelope of preparedEnvelopes) {
      this.envelopes.set(envelope.envelopeId, envelope);
    }
    for (const event of preparedEvents) {
      const device = this.devices.get(event.deviceId);
      if (!device) {
        throw new Error("Invariant violation: event target device disappeared");
      }
      this.inboxEvents.get(event.deviceId)?.push(event);
      device.nextOffset += 1;
    }
    this.translationJobs.set(translationJob.jobId, translationJob);
    this.dedupe.set(dedupeKey, { fingerprint, accepted });

    // Translation dispatch is post-commit and cannot revoke ACCEPTED.
    try {
      this.deps.translationDispatcher?.notify(translationJob);
    } catch {
      // Durable AVAILABLE job remains for a later worker/dispatcher retry.
    }

    return accepted;
  }

  syncDevice(deviceId: UUID, afterOffset = 0): DeviceInboxEvent[] {
    const device = this.devices.get(deviceId);
    if (!device || device.status !== "ACTIVE") {
      throw new DomainError("DEVICE_REVOKED", "Device is not active");
    }
    return [...(this.inboxEvents.get(deviceId) ?? [])]
      .filter((event) => event.inboxEpoch === device.inboxEpoch && event.offset > afterOffset)
      .sort((a, b) => a.offset - b.offset);
  }

  pendingEnvelopes(deviceId: UUID): DeliveryEnvelope[] {
    return [...this.envelopes.values()].filter(
      (envelope) =>
        envelope.recipientDeviceId === deviceId && envelope.status === "PENDING",
    );
  }

  acknowledgeEnvelope(deviceId: UUID, envelopeId: UUID): void {
    const envelope = this.envelopes.get(envelopeId);
    if (!envelope || envelope.recipientDeviceId !== deviceId) {
      throw new DomainError("NOT_AUTHORIZED", "Envelope is not available to device");
    }
    if (envelope.status === "ACKED") {
      return;
    }
    if (envelope.status !== "PENDING") {
      throw new DomainError("DELIVERY_EXPIRED", "Envelope is no longer deliverable");
    }
    envelope.status = "ACKED";
    envelope.ackedAt = this.deps.clock.now();
  }

  getMessageCount(): number {
    return this.messages.size;
  }

  getTranslationJobs(): TranslationJob[] {
    return [...this.translationJobs.values()];
  }

  private assertActorDevice(actor: ActorContext): void {
    const device = this.devices.get(actor.deviceId);
    if (!device || device.status !== "ACTIVE") {
      throw new DomainError("DEVICE_REVOKED", "Actor device is not active");
    }
    if (device.userId !== actor.userId) {
      throw new DomainError("NOT_AUTHORIZED", "Device does not belong to actor");
    }
  }
}
