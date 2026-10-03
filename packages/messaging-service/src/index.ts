import type {
  AcceptedMessage,
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import { DomainError } from "../../domain/src/index.js";
import type {
  SendMessageCommand,
  SourceContent,
} from "../../protocol/src/index.js";
import type {
  TransientSourceKey,
  TransientSourceStore,
} from "../../transient-source/src/index.js";

export interface PersistentConversationAllocation {
  messageSeq: number;
  opSeq: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
}

export interface PersistentRecipientDevice {
  userId: UUID;
  deviceId: UUID;
  credentialVersion: number;
  publicMaterialRef: string;
}

export interface PersistentRecipientTarget {
  userId: UUID;
  devices: PersistentRecipientDevice[];
}

export interface PersistentExistingAcceptance {
  messageId: UUID;
  messageSeq: number;
  currentRevision: number;
  acceptedAt: string;
  originalSourceHash: string | null;
}

export interface PersistentCommandReceipt {
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export interface PersistentMessagingStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  findCommandReceipt(
    tx: Tx,
    actor: ActorContext,
    commandId: UUID,
  ): Promise<PersistentCommandReceipt | undefined>;

  findAcceptedMessageByClientId(
    tx: Tx,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<PersistentExistingAcceptance | undefined>;

  allocateMessageAndOperationSequence(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<PersistentConversationAllocation | undefined>;

  listRecipientDeliveryTargets(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<PersistentRecipientTarget[]>;

  replyTargetExists(
    tx: Tx,
    tenantId: UUID,
    conversationId: UUID,
    messageId: UUID,
  ): Promise<boolean>;

  insertMessageMetadata(
    tx: Tx,
    input: {
      tenantId: UUID;
      messageId: UUID;
      conversationId: UUID;
      authorUserId: UUID;
      authorDeviceId: UUID;
      clientMessageId: UUID;
      messageSeq: number;
      replyToMessageId?: UUID | null;
      acceptedAt: string;
      clientAuthoredAt?: string | null;
    },
  ): Promise<void>;

  insertMessageRevision(
    tx: Tx,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      revision: number;
      opSeq: number;
      mutationType: "CREATED" | "EDITED" | "DELETED";
      actorUserId: UUID;
      sourceHash?: string | null;
      sourceLanguage?: string | null;
      createdAt: string;
    },
  ): Promise<void>;

  insertDeliveryEnvelope(
    tx: Tx,
    input: {
      tenantId: UUID;
      envelopeId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
      recipientUserId: UUID;
      recipientDeviceId: UUID;
      credentialVersion: number;
      protectedPayload: string;
      createdAt: string;
      expiresAt: string;
    },
  ): Promise<void>;

  allocateDeviceInboxOffset(
    tx: Tx,
    deviceId: UUID,
  ): Promise<{ inboxEpoch: number; offset: number }>;

  insertInboxEvent(
    tx: Tx,
    input: {
      deviceId: UUID;
      inboxEpoch: number;
      offset: number;
      eventId: UUID;
      eventType: "message.available" | "message.edited" | "message.deleted";
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      envelopeId?: UUID | null;
      sourceRevision: number;
      createdAt: string;
    },
  ): Promise<void>;

  insertOutboxJob(
    tx: Tx,
    input: {
      jobId: UUID;
      tenantId: UUID;
      jobType: string;
      businessKey: string;
      payloadRef: Record<string, unknown>;
      priority: number;
      availableAt: string;
    },
  ): Promise<void>;

  insertCommandReceipt(
    tx: Tx,
    input: {
      tenantId: UUID;
      commandId: UUID;
      actorUserId: UUID;
      actorDeviceId: UUID;
      commandType: string;
      commandFingerprint: string;
      result: Record<string, unknown>;
      now: string;
    },
  ): Promise<void>;
}

export interface PersistentMessagingIdFactory {
  next(prefix: string): UUID;
}

export interface PersistentMessagingClock {
  now(): string;
}

export interface PersistentSourceFingerprinter {
  /**
   * Must return an opaque stable fingerprint suitable for idempotency.
   * Production implementations must not use an unkeyed digest of short
   * plaintext messages.
   */
  fingerprint(source: SourceContent): string;
}

export interface PersistentEnvelopeProtector {
  /**
   * Returns a base64 representation of the protected envelope payload.
   * Production implementations must use a separately reviewed construction.
   */
  protect(input: {
    tenantId: UUID;
    conversationId: UUID;
    messageId: UUID;
    sourceRevision: number;
    recipientUserId: UUID;
    recipientDeviceId: UUID;
    recipientCredentialVersion: number;
    recipientPublicMaterialRef: string;
    source: SourceContent;
  }): string | Promise<string>;
}

export interface PersistentMessagingServiceDependencies<Tx> {
  store: PersistentMessagingStore<Tx>;
  ids: PersistentMessagingIdFactory;
  clock: PersistentMessagingClock;
  fingerprinter: PersistentSourceFingerprinter;
  envelopeProtector: PersistentEnvelopeProtector;
  transientSources?: TransientSourceStore;
  envelopeTtlSeconds?: number;
  transientSourceTtlSeconds?: number;
}

export class PersistentMessagingService<Tx> {
  private readonly envelopeTtlSeconds: number;
  private readonly transientSourceTtlSeconds: number;

  constructor(
    private readonly deps: PersistentMessagingServiceDependencies<Tx>,
  ) {
    this.envelopeTtlSeconds =
      deps.envelopeTtlSeconds ?? 7 * 24 * 60 * 60;
    this.transientSourceTtlSeconds =
      deps.transientSourceTtlSeconds ?? 5 * 60;
  }

  async sendMessage(
    actor: ActorContext,
    command: SendMessageCommand,
  ): Promise<AcceptedMessage> {
    if (!command.source.text) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Source text is required",
      );
    }

    const sourceFingerprint =
      this.deps.fingerprinter.fingerprint(command.source);
    const commandFingerprint = [
      "message.send",
      command.conversation_id,
      command.client_message_id,
      sourceFingerprint,
      command.reply_to_message_id ?? "",
      command.client_authored_at ?? "",
    ].join("|");

    let preparedTransientKey: TransientSourceKey | undefined;

    try {
      return await this.deps.store.withTransaction(async (tx) => {
        const existingCommand =
          await this.deps.store.findCommandReceipt(
            tx,
            actor,
            command.command_id,
          );

        if (existingCommand) {
          if (
            existingCommand.commandType !== "message.send" ||
            existingCommand.commandFingerprint !== commandFingerprint
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "command_id was already used for a different operation",
            );
          }

          if (existingCommand.status !== "SUCCEEDED") {
            throw new Error(
              "Invariant violation: non-terminal command receipt",
            );
          }

          const accepted = acceptedFromResult(existingCommand.result);
          await this.bestEffortBufferSource(
            actor.tenantId,
            accepted.message_id,
            1,
            accepted.accepted_at,
            command.source,
          );
          return accepted;
        }

        const existingMessage =
          await this.deps.store.findAcceptedMessageByClientId(
            tx,
            actor,
            command.client_message_id,
          );

        if (existingMessage) {
          if (
            !existingMessage.originalSourceHash ||
            existingMessage.originalSourceHash !== sourceFingerprint
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "client_message_id was already used with different source content",
            );
          }

          const accepted: AcceptedMessage = {
            protocol_version: 1,
            status: "ACCEPTED",
            message_id: existingMessage.messageId,
            message_seq: existingMessage.messageSeq,
            source_revision: 1,
            accepted_at: existingMessage.acceptedAt,
            translation_status: "PENDING",
          };

          await this.deps.store.insertCommandReceipt(tx, {
            tenantId: actor.tenantId,
            commandId: command.command_id,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandType: "message.send",
            commandFingerprint,
            result: accepted as unknown as Record<string, unknown>,
            now: this.deps.clock.now(),
          });

          await this.bestEffortBufferSource(
            actor.tenantId,
            existingMessage.messageId,
            1,
            existingMessage.acceptedAt,
            command.source,
          );
          return accepted;
        }

        const allocation =
          await this.deps.store.allocateMessageAndOperationSequence(
            tx,
            actor,
            command.conversation_id,
          );

        if (!allocation) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Conversation is not available to actor",
          );
        }

        if (command.reply_to_message_id) {
          const replyExists =
            await this.deps.store.replyTargetExists(
              tx,
              actor.tenantId,
              command.conversation_id,
              command.reply_to_message_id,
            );
          if (!replyExists) {
            throw new DomainError(
              "INVALID_COMMAND",
              "Reply target must belong to the same conversation",
            );
          }
        }

        const targets =
          await this.deps.store.listRecipientDeliveryTargets(
            tx,
            actor,
            command.conversation_id,
          );

        const externalRecipients = targets.filter(
          (target) => target.userId !== actor.userId,
        );

        if (
          externalRecipients.length === 0 ||
          externalRecipients.some(
            (target) => target.devices.length === 0,
          )
        ) {
          throw new DomainError(
            "RECIPIENT_UNAVAILABLE",
            "At least one active recipient has no deliverable device",
          );
        }

        const now = this.deps.clock.now();
        const messageId = this.deps.ids.next("msg");
        const sourceRevision = 1;
        const expiresAt = addSeconds(
          now,
          this.envelopeTtlSeconds,
        );

        const transientBuffered =
          await this.bestEffortBufferSource(
            actor.tenantId,
            messageId,
            sourceRevision,
            now,
            command.source,
          );
        if (transientBuffered) {
          preparedTransientKey = {
            tenantId: actor.tenantId,
            messageId,
            sourceRevision,
          };
        }

        await this.deps.store.insertMessageMetadata(tx, {
          tenantId: actor.tenantId,
          messageId,
          conversationId: command.conversation_id,
          authorUserId: actor.userId,
          authorDeviceId: actor.deviceId,
          clientMessageId: command.client_message_id,
          messageSeq: allocation.messageSeq,
          replyToMessageId: command.reply_to_message_id ?? null,
          acceptedAt: now,
          clientAuthoredAt: command.client_authored_at ?? null,
        });

        await this.deps.store.insertMessageRevision(tx, {
          tenantId: actor.tenantId,
          conversationId: command.conversation_id,
          messageId,
          revision: sourceRevision,
          opSeq: allocation.opSeq,
          mutationType: "CREATED",
          actorUserId: actor.userId,
          sourceHash: sourceFingerprint,
          sourceLanguage: command.source.language_hint ?? null,
          createdAt: now,
        });

        for (const target of targets) {
          for (const device of target.devices) {
            const envelopeId = this.deps.ids.next("env");
            const protectedPayload =
              await this.deps.envelopeProtector.protect({
                tenantId: actor.tenantId,
                conversationId: command.conversation_id,
                messageId,
                sourceRevision,
                recipientUserId: target.userId,
                recipientDeviceId: device.deviceId,
                recipientCredentialVersion:
                  device.credentialVersion,
                recipientPublicMaterialRef:
                  device.publicMaterialRef,
                source: command.source,
              });

            await this.deps.store.insertDeliveryEnvelope(tx, {
              tenantId: actor.tenantId,
              envelopeId,
              conversationId: command.conversation_id,
              messageId,
              sourceRevision,
              recipientUserId: target.userId,
              recipientDeviceId: device.deviceId,
              credentialVersion: device.credentialVersion,
              protectedPayload,
              createdAt: now,
              expiresAt,
            });

            const inbox =
              await this.deps.store.allocateDeviceInboxOffset(
                tx,
                device.deviceId,
              );

            await this.deps.store.insertInboxEvent(tx, {
              deviceId: device.deviceId,
              inboxEpoch: inbox.inboxEpoch,
              offset: inbox.offset,
              eventId: this.deps.ids.next("evt"),
              eventType: "message.available",
              tenantId: actor.tenantId,
              conversationId: command.conversation_id,
              messageId,
              envelopeId,
              sourceRevision,
              createdAt: now,
            });
          }
        }

        const translationJobId = this.deps.ids.next("job");
        await this.deps.store.insertOutboxJob(tx, {
          jobId: translationJobId,
          tenantId: actor.tenantId,
          jobType: "translation.requested",
          businessKey:
            `translation:${messageId}:${sourceRevision}`,
          payloadRef: {
            message_id: messageId,
            source_revision: sourceRevision,
            membership_epoch: allocation.membershipEpoch,
            erasure_epoch: allocation.erasureEpoch,
            policy_version: allocation.policyVersion,
            source_buffered: transientBuffered,
          },
          priority: 10,
          availableAt: now,
        });

        const accepted: AcceptedMessage = {
          protocol_version: 1,
          status: "ACCEPTED",
          message_id: messageId,
          message_seq: allocation.messageSeq,
          source_revision: sourceRevision,
          accepted_at: now,
          translation_status: "PENDING",
        };

        await this.deps.store.insertCommandReceipt(tx, {
          tenantId: actor.tenantId,
          commandId: command.command_id,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          commandType: "message.send",
          commandFingerprint,
          result: accepted as unknown as Record<string, unknown>,
          now,
        });

        return accepted;
      });
    } catch (error) {
      if (preparedTransientKey) {
        try {
          await this.deps.transientSources?.remove(
            preparedTransientKey,
          );
        } catch {
          // Cleanup failure must not mask the transaction error.
        }
      }
      throw error;
    }
  }

  private async bestEffortBufferSource(
    tenantId: UUID,
    messageId: UUID,
    sourceRevision: number,
    acceptedAt: string,
    source: SourceContent,
  ): Promise<boolean> {
    if (!this.deps.transientSources) {
      return false;
    }

    const expiresAt = addSeconds(
      acceptedAt,
      this.transientSourceTtlSeconds,
    );

    try {
      return Boolean(
        await this.deps.transientSources.put({
          tenantId,
          messageId,
          sourceRevision,
          source: structuredClone(source),
          createdAt: acceptedAt,
          expiresAt,
        }),
      );
    } catch {
      return false;
    }
  }
}

function acceptedFromResult(
  result: Record<string, unknown>,
): AcceptedMessage {
  if (
    result.protocol_version !== 1 ||
    result.status !== "ACCEPTED" ||
    typeof result.message_id !== "string" ||
    typeof result.message_seq !== "number" ||
    typeof result.source_revision !== "number" ||
    typeof result.accepted_at !== "string" ||
    typeof result.translation_status !== "string"
  ) {
    throw new Error(
      "Invariant violation: invalid persistent ACCEPTED command result",
    );
  }

  const translationStatus = result.translation_status;
  if (
    ![
      "NOT_REQUESTED",
      "PENDING",
      "READY",
      "FAILED",
      "SOURCE_REQUIRED",
      "EXPIRED",
      "SUPERSEDED",
    ].includes(translationStatus)
  ) {
    throw new Error(
      "Invariant violation: invalid translation status in command result",
    );
  }

  return {
    protocol_version: 1,
    status: "ACCEPTED",
    message_id: result.message_id,
    message_seq: result.message_seq,
    source_revision: result.source_revision,
    accepted_at: result.accepted_at,
    translation_status:
      translationStatus as AcceptedMessage["translation_status"],
  };
}

function addSeconds(timestamp: string, seconds: number): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new Error("Clock returned an invalid timestamp");
  }
  return new Date(millis + seconds * 1000).toISOString();
}
