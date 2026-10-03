import type {
  AcceptedMessage,
  ActorContext,
  CommandStatusResult,
  DeliveryEnvelope,
  DeviceInboxEvent,
  MessageMetadata,
  MessageRevisionResult,
  TranslationJob,
  UUID,
} from "../../domain/src/index.js";
import { DomainError } from "../../domain/src/index.js";
import type {
  DeleteMessageCommand,
  EditMessageCommand,
  SendMessageCommand,
  SourceContent,
} from "../../protocol/src/index.js";

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
  logicalFingerprint: string;
  accepted: AcceptedMessage;
}

type CommandResult = AcceptedMessage | MessageRevisionResult;

interface CommandReceiptRecord {
  tenantId: UUID;
  commandId: UUID;
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: "message.send" | "message.edit" | "message.delete";
  fingerprint: string;
  result: CommandResult;
}

interface PreparedDelivery {
  envelopes: DeliveryEnvelope[];
  events: DeviceInboxEvent[];
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
  private readonly messageSourceFingerprints = new Map<UUID, Map<number, string>>();
  private readonly dedupe = new Map<string, DedupeRecord>();
  private readonly commandReceipts = new Map<string, CommandReceiptRecord>();
  private readonly envelopes = new Map<UUID, DeliveryEnvelope>();
  private readonly inboxEvents = new Map<UUID, DeviceInboxEvent[]>();
  private readonly translationJobs = new Map<UUID, TranslationJob>();
  private readonly terminalEnvelopeOwners = new Map<UUID, UUID>();
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

  registerConversation(
    tenantId: UUID,
    conversationId: UUID,
    memberUserIds: UUID[],
  ): void {
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
    const conversation = this.getConversationForActor(
      actor,
      command.conversation_id,
    );

    if (!command.source.text) {
      throw new DomainError("INVALID_COMMAND", "Source text is required");
    }

    if (command.reply_to_message_id) {
      const replyTarget = this.messages.get(command.reply_to_message_id);
      if (
        !replyTarget ||
        replyTarget.tenantId !== actor.tenantId ||
        replyTarget.conversationId !== conversation.conversationId
      ) {
        throw new DomainError(
          "INVALID_COMMAND",
          "Reply target must belong to the same conversation",
        );
      }
    }

    const sourceFingerprint = this.deps.fingerprinter.fingerprint(command.source);
    const commandFingerprint = [
      command.conversation_id,
      command.client_message_id,
      sourceFingerprint,
      command.reply_to_message_id ?? "",
      command.client_authored_at ?? "",
    ].join("|");

    const priorCommand = this.getExistingCommandResult(
      actor,
      command.command_id,
      "message.send",
      commandFingerprint,
    );
    if (priorCommand) {
      return priorCommand as AcceptedMessage;
    }

    const dedupeKey = [
      actor.tenantId,
      actor.userId,
      command.client_message_id,
    ].join(":");
    const logicalFingerprint = [
      command.conversation_id,
      sourceFingerprint,
      command.reply_to_message_id ?? "",
      command.client_authored_at ?? "",
    ].join("|");

    const previous = this.dedupe.get(dedupeKey);
    if (previous) {
      if (previous.logicalFingerprint !== logicalFingerprint) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "client_message_id was already used for a different logical message",
        );
      }
      this.storeCommandReceipt(
        actor,
        command.command_id,
        "message.send",
        commandFingerprint,
        previous.accepted,
      );
      return previous.accepted;
    }

    const externalMembers = [...conversation.members].filter(
      (userId) => userId !== actor.userId,
    );
    const unavailableRecipient =
      externalMembers.length < 1 ||
      externalMembers.some(
        (userId) =>
          ![...this.devices.values()].some(
            (device) =>
              device.userId === userId &&
              device.status === "ACTIVE",
          ),
      );
    if (unavailableRecipient) {
      throw new DomainError(
        "RECIPIENT_UNAVAILABLE",
        "At least one active recipient has no deliverable device",
      );
    }

    const now = this.deps.clock.now();
    const messageId = this.deps.ids.next("msg");
    const messageSeq = conversation.nextMessageSeq;
    const sourceRevision = 1;

    const message: MessageMetadata = {
      tenantId: actor.tenantId,
      messageId,
      conversationId: conversation.conversationId,
      authorUserId: actor.userId,
      authorDeviceId: actor.deviceId,
      clientMessageId: command.client_message_id,
      messageSeq,
      currentRevision: sourceRevision,
      status: "ACTIVE",
      acceptedAt: now,
    };

    const prepared = this.prepareContentDelivery(
      actor,
      conversation,
      messageId,
      sourceRevision,
      command.source,
      "message.available",
      now,
    );

    const translationJob = this.createTranslationJob(
      messageId,
      sourceRevision,
      now,
    );

    const accepted: AcceptedMessage = {
      protocol_version: 1,
      status: "ACCEPTED",
      message_id: messageId,
      message_seq: messageSeq,
      source_revision: sourceRevision,
      accepted_at: now,
      translation_status: "PENDING",
    };

    // In-memory equivalent of one durable transaction.
    conversation.nextMessageSeq += 1;
    conversation.nextOpSeq += 1;
    this.messages.set(messageId, message);
    this.messageSourceFingerprints.set(
      messageId,
      new Map([[sourceRevision, sourceFingerprint]]),
    );
    this.applyPreparedDelivery(prepared);
    this.translationJobs.set(translationJob.jobId, translationJob);
    this.dedupe.set(dedupeKey, {
      logicalFingerprint,
      accepted,
    });
    this.storeCommandReceipt(
      actor,
      command.command_id,
      "message.send",
      commandFingerprint,
      accepted,
    );

    this.notifyTranslationPostCommit(translationJob);
    return accepted;
  }

  async editMessage(
    actor: ActorContext,
    command: EditMessageCommand,
  ): Promise<MessageRevisionResult> {
    this.assertActorDevice(actor);

    if (!command.source.text) {
      throw new DomainError("INVALID_COMMAND", "Source text is required");
    }

    const sourceFingerprint = this.deps.fingerprinter.fingerprint(command.source);
    const commandFingerprint = [
      command.message_id,
      command.expected_revision,
      sourceFingerprint,
    ].join("|");

    const priorCommand = this.getExistingCommandResult(
      actor,
      command.command_id,
      "message.edit",
      commandFingerprint,
    );
    if (priorCommand) {
      return priorCommand as MessageRevisionResult;
    }

    const message = this.getMutableMessageForAuthor(
      actor,
      command.message_id,
      command.expected_revision,
    );
    const conversation = this.getConversationForActor(
      actor,
      message.conversationId,
    );

    const now = this.deps.clock.now();
    const revision = message.currentRevision + 1;
    const opSeq = conversation.nextOpSeq;

    // Prepare all failure-prone delivery work before destructive mutation.
    const prepared = this.prepareContentDelivery(
      actor,
      conversation,
      message.messageId,
      revision,
      command.source,
      "message.edited",
      now,
    );
    const translationJob = this.createTranslationJob(
      message.messageId,
      revision,
      now,
    );

    // Only after preparation succeeds may stale undelivered content be revoked.
    this.revokePendingEnvelopesForMessage(message.messageId);
    this.supersedeTranslationJobs(message.messageId);

    const result: MessageRevisionResult = {
      message_id: message.messageId,
      revision,
      op_seq: opSeq,
      status: "ACTIVE",
    };

    message.currentRevision = revision;
    conversation.nextOpSeq += 1;
    this.messageSourceFingerprints
      .get(message.messageId)
      ?.set(revision, sourceFingerprint);
    this.applyPreparedDelivery(prepared);
    this.translationJobs.set(translationJob.jobId, translationJob);
    this.storeCommandReceipt(
      actor,
      command.command_id,
      "message.edit",
      commandFingerprint,
      result,
    );

    this.notifyTranslationPostCommit(translationJob);
    return result;
  }

  async deleteMessage(
    actor: ActorContext,
    command: DeleteMessageCommand,
  ): Promise<MessageRevisionResult> {
    this.assertActorDevice(actor);

    const commandFingerprint = [
      command.message_id,
      command.expected_revision,
      "DELETE",
    ].join("|");

    const priorCommand = this.getExistingCommandResult(
      actor,
      command.command_id,
      "message.delete",
      commandFingerprint,
    );
    if (priorCommand) {
      return priorCommand as MessageRevisionResult;
    }

    const message = this.getMutableMessageForAuthor(
      actor,
      command.message_id,
      command.expected_revision,
    );
    const conversation = this.getConversationForActor(
      actor,
      message.conversationId,
    );

    const revision = message.currentRevision + 1;
    const opSeq = conversation.nextOpSeq;
    const now = this.deps.clock.now();

    this.revokePendingEnvelopesForMessage(message.messageId);
    this.supersedeTranslationJobs(message.messageId);

    const events = this.prepareControlEvents(
      actor,
      conversation,
      message.messageId,
      revision,
      "message.deleted",
      now,
    );

    const result: MessageRevisionResult = {
      message_id: message.messageId,
      revision,
      op_seq: opSeq,
      status: "DELETED",
    };

    message.currentRevision = revision;
    message.status = "DELETED";
    conversation.nextOpSeq += 1;
    this.applyPreparedDelivery({ envelopes: [], events });
    this.storeCommandReceipt(
      actor,
      command.command_id,
      "message.delete",
      commandFingerprint,
      result,
    );

    return result;
  }

  getCommandStatus(
    actor: ActorContext,
    commandId: UUID,
  ): CommandStatusResult {
    this.assertActorDevice(actor);
    const receipt = this.commandReceipts.get(
      this.commandReceiptKey(actor.tenantId, commandId),
    );

    if (
      !receipt ||
      receipt.actorUserId !== actor.userId ||
      receipt.actorDeviceId !== actor.deviceId
    ) {
      return {
        command_id: commandId,
        status: "UNKNOWN",
      };
    }

    return {
      command_id: commandId,
      status: "SUCCEEDED",
      result: { ...receipt.result } as Record<string, unknown>,
    };
  }

  syncDevice(deviceId: UUID, afterOffset = 0): DeviceInboxEvent[] {
    const device = this.devices.get(deviceId);
    if (!device || device.status !== "ACTIVE") {
      throw new DomainError("DEVICE_REVOKED", "Device is not active");
    }
    return [...(this.inboxEvents.get(deviceId) ?? [])]
      .filter(
        (event) =>
          event.inboxEpoch === device.inboxEpoch &&
          event.offset > afterOffset,
      )
      .sort((a, b) => a.offset - b.offset);
  }

  pendingEnvelopes(deviceId: UUID): DeliveryEnvelope[] {
    return [...this.envelopes.values()].filter(
      (envelope) =>
        envelope.recipientDeviceId === deviceId &&
        envelope.status === "PENDING",
    );
  }

  getEnvelopeForDevice(
    deviceId: UUID,
    envelopeId: UUID,
  ): DeliveryEnvelope | undefined {
    const envelope = this.envelopes.get(envelopeId);
    if (!envelope || envelope.recipientDeviceId !== deviceId) {
      return undefined;
    }
    return { ...envelope };
  }

  getDeviceSyncPosition(
    deviceId: UUID,
  ): { inboxEpoch: number; nextOffset: number } {
    const device = this.devices.get(deviceId);
    if (!device || device.status !== "ACTIVE") {
      throw new DomainError("DEVICE_REVOKED", "Device is not active");
    }
    return {
      inboxEpoch: device.inboxEpoch,
      nextOffset: device.nextOffset,
    };
  }

  acknowledgeEnvelope(deviceId: UUID, envelopeId: UUID): void {
    const terminalOwner = this.terminalEnvelopeOwners.get(envelopeId);
    if (terminalOwner) {
      if (terminalOwner !== deviceId) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Envelope is not available to device",
        );
      }
      return;
    }

    const envelope = this.envelopes.get(envelopeId);
    if (!envelope || envelope.recipientDeviceId !== deviceId) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Envelope is not available to device",
      );
    }
    if (envelope.status !== "PENDING") {
      throw new DomainError(
        "DELIVERY_EXPIRED",
        "Envelope is no longer deliverable",
      );
    }

    // Relay payload is removed on ACK. Keep only a minimal device-bound tombstone.
    this.envelopes.delete(envelopeId);
    this.terminalEnvelopeOwners.set(envelopeId, deviceId);
  }

  getMessageCount(): number {
    return this.messages.size;
  }

  getMessageMetadata(messageId: UUID): MessageMetadata | undefined {
    const message = this.messages.get(messageId);
    return message ? { ...message } : undefined;
  }

  getTranslationJobs(): TranslationJob[] {
    return [...this.translationJobs.values()].map((job) => ({ ...job }));
  }

  private getConversationForActor(
    actor: ActorContext,
    conversationId: UUID,
  ): ConversationRecord {
    const conversation = this.conversations.get(conversationId);
    if (
      !conversation ||
      conversation.tenantId !== actor.tenantId ||
      !conversation.members.has(actor.userId)
    ) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Conversation is not available to actor",
      );
    }
    return conversation;
  }

  private getMutableMessageForAuthor(
    actor: ActorContext,
    messageId: UUID,
    expectedRevision: number,
  ): MessageMetadata {
    const message = this.messages.get(messageId);
    if (
      !message ||
      message.tenantId !== actor.tenantId ||
      message.authorUserId !== actor.userId
    ) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Message is not mutable by actor",
      );
    }

    if (
      message.status !== "ACTIVE" ||
      message.currentRevision !== expectedRevision
    ) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Message revision is stale or no longer active",
      );
    }

    return message;
  }

  private prepareContentDelivery(
    actor: ActorContext,
    conversation: ConversationRecord,
    messageId: UUID,
    sourceRevision: number,
    source: SourceContent,
    eventType: "message.available" | "message.edited",
    now: string,
  ): PreparedDelivery {
    const externalRecipients = [...conversation.members].filter(
      (userId) => userId !== actor.userId,
    );
    const unavailableRecipients = externalRecipients.filter(
      (userId) =>
        ![...this.devices.values()].some(
          (device) =>
            device.userId === userId &&
            device.status === "ACTIVE",
        ),
    );

    if (
      externalRecipients.length === 0 ||
      unavailableRecipients.length > 0
    ) {
      throw new DomainError(
        "RECIPIENT_UNAVAILABLE",
        "At least one active recipient has no deliverable device",
      );
    }

    const envelopes: DeliveryEnvelope[] = [];
    const events: DeviceInboxEvent[] = [];

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

      envelopes.push({
        tenantId: actor.tenantId,
        envelopeId,
        conversationId: conversation.conversationId,
        messageId,
        sourceRevision,
        recipientUserId: device.userId,
        recipientDeviceId: device.deviceId,
        renditionType: "ORIGINAL",
        protectedPayload: this.deps.envelopeProtector.protect({
          tenantId: actor.tenantId,
          conversationId: conversation.conversationId,
          messageId,
          sourceRevision,
          recipientDeviceId: device.deviceId,
          source,
        }),
        status: "PENDING",
        createdAt: now,
        expiresAt,
      });

      events.push({
        deviceId: device.deviceId,
        inboxEpoch: device.inboxEpoch,
        offset: device.nextOffset,
        eventId: this.deps.ids.next("evt"),
        type: eventType,
        tenantId: actor.tenantId,
        conversationId: conversation.conversationId,
        messageId,
        sourceRevision,
        envelopeId,
        createdAt: now,
      });
    }

    return { envelopes, events };
  }

  private prepareControlEvents(
    actor: ActorContext,
    conversation: ConversationRecord,
    messageId: UUID,
    sourceRevision: number,
    eventType: "message.deleted",
    now: string,
  ): DeviceInboxEvent[] {
    const events: DeviceInboxEvent[] = [];

    for (const device of this.devices.values()) {
      if (
        device.status !== "ACTIVE" ||
        device.deviceId === actor.deviceId ||
        !conversation.members.has(device.userId)
      ) {
        continue;
      }

      events.push({
        deviceId: device.deviceId,
        inboxEpoch: device.inboxEpoch,
        offset: device.nextOffset,
        eventId: this.deps.ids.next("evt"),
        type: eventType,
        tenantId: actor.tenantId,
        conversationId: conversation.conversationId,
        messageId,
        sourceRevision,
        createdAt: now,
      });
    }

    return events;
  }

  private applyPreparedDelivery(prepared: PreparedDelivery): void {
    for (const envelope of prepared.envelopes) {
      this.envelopes.set(envelope.envelopeId, envelope);
    }

    for (const event of prepared.events) {
      const device = this.devices.get(event.deviceId);
      if (!device) {
        throw new Error(
          "Invariant violation: event target device disappeared",
        );
      }
      this.inboxEvents.get(event.deviceId)?.push(event);
      device.nextOffset += 1;
    }
  }

  private revokePendingEnvelopesForMessage(messageId: UUID): void {
    const revokedIds = new Set<UUID>();

    for (const [envelopeId, envelope] of this.envelopes.entries()) {
      if (
        envelope.messageId === messageId &&
        envelope.status === "PENDING"
      ) {
        revokedIds.add(envelopeId);
        this.envelopes.delete(envelopeId);
        this.terminalEnvelopeOwners.set(
          envelopeId,
          envelope.recipientDeviceId,
        );
      }
    }

    if (!revokedIds.size) {
      return;
    }

    for (const [deviceId, events] of this.inboxEvents.entries()) {
      this.inboxEvents.set(
        deviceId,
        events.filter(
          (event) =>
            !event.envelopeId || !revokedIds.has(event.envelopeId),
        ),
      );
    }
  }

  private supersedeTranslationJobs(messageId: UUID): void {
    for (const job of this.translationJobs.values()) {
      if (job.messageId === messageId && job.status === "AVAILABLE") {
        job.status = "SUPERSEDED";
      }
    }
  }

  private createTranslationJob(
    messageId: UUID,
    sourceRevision: number,
    now: string,
  ): TranslationJob {
    return {
      jobId: this.deps.ids.next("job"),
      messageId,
      sourceRevision,
      status: "AVAILABLE",
      createdAt: now,
    };
  }

  private notifyTranslationPostCommit(job: TranslationJob): void {
    try {
      this.deps.translationDispatcher?.notify(job);
    } catch {
      // Durable AVAILABLE job remains for a later worker/dispatcher retry.
    }
  }

  private getExistingCommandResult(
    actor: ActorContext,
    commandId: UUID,
    commandType: CommandReceiptRecord["commandType"],
    fingerprint: string,
  ): CommandResult | undefined {
    const existing = this.commandReceipts.get(
      this.commandReceiptKey(actor.tenantId, commandId),
    );
    if (!existing) {
      return undefined;
    }

    if (
      existing.actorUserId !== actor.userId ||
      existing.actorDeviceId !== actor.deviceId
    ) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Command identifier is not available to actor",
      );
    }

    if (
      existing.commandType !== commandType ||
      existing.fingerprint !== fingerprint
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "command_id was already used for a different operation",
      );
    }

    return existing.result;
  }

  private storeCommandReceipt(
    actor: ActorContext,
    commandId: UUID,
    commandType: CommandReceiptRecord["commandType"],
    fingerprint: string,
    result: CommandResult,
  ): void {
    this.commandReceipts.set(
      this.commandReceiptKey(actor.tenantId, commandId),
      {
        tenantId: actor.tenantId,
        commandId,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        commandType,
        fingerprint,
        result,
      },
    );
  }

  private commandReceiptKey(tenantId: UUID, commandId: UUID): string {
    return `${tenantId}:${commandId}`;
  }

  private assertActorDevice(actor: ActorContext): void {
    const device = this.devices.get(actor.deviceId);
    if (!device || device.status !== "ACTIVE") {
      throw new DomainError(
        "DEVICE_REVOKED",
        "Actor device is not active",
      );
    }
    if (device.userId !== actor.userId) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Device does not belong to actor",
      );
    }
  }
}
