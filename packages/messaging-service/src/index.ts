import type {
  AcceptedMessage,
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import { DomainError } from "../../domain/src/index.js";
import type {
  DeleteMessageCommand,
  EditMessageCommand,
  MessageRevisionResult,
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
  targetLanguageTag: string | null;
  targetProfileVersion: number;
  devices: PersistentRecipientDevice[];
}

export interface PersistentConversationEventDevice {
  userId: UUID;
  deviceId: UUID;
}

export interface PersistentExistingAcceptance {
  messageId: UUID;
  conversationId: UUID;
  replyToMessageId: UUID | null;
  messageSeq: number;
  acceptedAt: string;
  clientAuthoredAt: string | null;
  originalSourceHash: string | null;
  acceptedResult: Record<string, unknown> | null;
}

export interface PersistentCommandReceipt {
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export type PersistentCommandClaimResult =
  | { claimed: true }
  | { claimed: false; existing: PersistentCommandReceipt };

export interface PersistentMessagingStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  findCommandReceipt(
    tx: Tx,
    actor: ActorContext,
    commandId: UUID,
  ): Promise<PersistentCommandReceipt | undefined>;

  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<PersistentCommandClaimResult>;

  lockClientMessageKey(
    tx: Tx,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<void>;

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

  listConversationEventDevices(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<PersistentConversationEventDevice[]>;

  lockMessageForAuthorMutation(
    tx: Tx,
    actor: ActorContext,
    messageId: UUID,
  ): Promise<{
    conversationId: UUID;
    messageSeq: number;
    currentRevision: number;
    status: "ACTIVE" | "DELETED";
  } | undefined>;

  allocateOperationSequence(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<{
    opSeq: number;
    membershipEpoch: number;
    erasureEpoch: number;
    policyVersion: number;
  } | undefined>;

  updateMessageRevisionPointer(
    tx: Tx,
    input: {
      tenantId: UUID;
      messageId: UUID;
      expectedRevision: number;
      newRevision: number;
      status: "ACTIVE" | "DELETED";
      deletedAt?: string | null;
    },
  ): Promise<void>;

  revokePendingMessageEnvelopes(
    tx: Tx,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
    },
  ): Promise<number>;

  supersedeTranslationJobs(
    tx: Tx,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
      now: string;
    },
  ): Promise<number>;

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
    tenantId: UUID,
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

  markCommandSucceeded(
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
   * Returns the primary opaque fingerprint for a new durable record.
   * Production implementations must use a keyed construction.
   */
  fingerprint(source: SourceContent): string;

  /**
   * Verifies source against a previously stored fingerprint. This must support
   * the explicitly retained verification-key window during key rotation.
   */
  matches(source: SourceContent, storedFingerprint: string): boolean;
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

interface SendCommandFingerprintV1 {
  v: 1;
  type: "message.send";
  conversation_id: UUID;
  client_message_id: UUID;
  source_fingerprint: string;
  reply_to_message_id: UUID | null;
  client_authored_at: string | null;
}

interface EditCommandFingerprintV1 {
  v: 1;
  type: "message.edit";
  message_id: UUID;
  expected_revision: number;
  source_fingerprint: string;
}

interface DeleteCommandFingerprintV1 {
  v: 1;
  type: "message.delete";
  message_id: UUID;
  expected_revision: number;
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

  async getCommandStatus(
    actor: ActorContext,
    commandId: UUID,
  ): Promise<{
    command_id: UUID;
    status: "UNKNOWN" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result?: Record<string, unknown>;
  }> {
    if (typeof commandId !== "string" || !commandId) {
      throw new DomainError(
        "INVALID_COMMAND",
        "command_id is required",
      );
    }

    return this.deps.store.withTransaction(async (tx) => {
      const receipt = await this.deps.store.findCommandReceipt(
        tx,
        actor,
        commandId,
      );

      if (!receipt) {
        return {
          command_id: commandId,
          status: "UNKNOWN",
        };
      }

      return {
        command_id: commandId,
        status: receipt.status,
        ...(receipt.status === "SUCCEEDED" ||
        receipt.status === "FAILED"
          ? { result: structuredClone(receipt.result) }
          : {}),
      };
    });
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

    const now = this.deps.clock.now();
    const sourceFingerprint =
      this.deps.fingerprinter.fingerprint(command.source);

    if (
      !sourceFingerprint ||
      sourceFingerprint === command.source.text
    ) {
      throw new Error(
        "Source fingerprinter must return an opaque fingerprint",
      );
    }

    const commandFingerprint = serializeSendCommandFingerprint({
      v: 1,
      type: "message.send",
      conversation_id: command.conversation_id,
      client_message_id: command.client_message_id,
      source_fingerprint: sourceFingerprint,
      reply_to_message_id: command.reply_to_message_id ?? null,
      client_authored_at: command.client_authored_at ?? null,
    });

    const proposedMessageId = this.deps.ids.next("msg");
    let preparedTransientKey: TransientSourceKey | undefined;
    let committedNewMessage = false;

    try {
      const result = await this.deps.store.withTransaction(async (tx) => {
        const claim = await this.deps.store.claimCommand(tx, {
          actor,
          commandId: command.command_id,
          commandType: "message.send",
          commandFingerprint,
          now,
        });

        if (!claim.claimed) {
          const existing = claim.existing;
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
            existing.commandType !== "message.send" ||
            !commandFingerprintMatches(
              existing.commandFingerprint,
              command,
              this.deps.fingerprinter,
            )
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "command_id was already used for a different operation",
            );
          }

          if (existing.status !== "SUCCEEDED") {
            throw new Error(
              "Persistent command receipt is not terminal",
            );
          }

          return acceptedFromResult(existing.result);
        }

        await this.deps.store.lockClientMessageKey(
          tx,
          actor,
          command.client_message_id,
        );

        const existingMessage =
          await this.deps.store.findAcceptedMessageByClientId(
            tx,
            actor,
            command.client_message_id,
          );

        if (existingMessage) {
          if (
            existingMessage.conversationId !== command.conversation_id ||
            !sameNullable(
              existingMessage.replyToMessageId,
              command.reply_to_message_id,
            ) ||
            !sameTimestamp(
              existingMessage.clientAuthoredAt,
              command.client_authored_at,
            ) ||
            !existingMessage.originalSourceHash ||
            !this.deps.fingerprinter.matches(
              command.source,
              existingMessage.originalSourceHash,
            )
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "client_message_id was already used for a different logical message",
            );
          }

          const storedAccepted = existingMessage.acceptedResult
            ? acceptedFromResult(existingMessage.acceptedResult)
            : undefined;

          const accepted: AcceptedMessage =
            storedAccepted ?? {
              protocol_version: 1,
              status: "ACCEPTED",
              message_id: existingMessage.messageId,
              message_seq: existingMessage.messageSeq,
              source_revision: 1,
              accepted_at: existingMessage.acceptedAt,
              translation_status: "PENDING",
            };

          await this.deps.store.markCommandSucceeded(tx, {
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

        const translationTargets = externalRecipients.filter(
          (target) => Boolean(target.targetLanguageTag),
        );

        const sourceRevision = 1;
        let translationStatus:
          AcceptedMessage["translation_status"] =
          translationTargets.length > 0
            ? "SOURCE_REQUIRED"
            : "NOT_REQUESTED";

        const transientBuffered =
          await this.bestEffortBufferSource(
            actor.tenantId,
            proposedMessageId,
            sourceRevision,
            sourceFingerprint,
            now,
            command.source,
          );

        if (transientBuffered) {
          preparedTransientKey = {
            tenantId: actor.tenantId,
            messageId: proposedMessageId,
            sourceRevision,
          };
          if (translationTargets.length > 0) {
            translationStatus = "PENDING";
          }
        }

        await this.deps.store.insertMessageMetadata(tx, {
          tenantId: actor.tenantId,
          messageId: proposedMessageId,
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
          messageId: proposedMessageId,
          revision: sourceRevision,
          opSeq: allocation.opSeq,
          mutationType: "CREATED",
          actorUserId: actor.userId,
          sourceHash: sourceFingerprint,
          sourceLanguage: command.source.language_hint ?? null,
          createdAt: now,
        });

        const expiresAt = addSeconds(
          now,
          this.envelopeTtlSeconds,
        );

        for (const target of targets) {
          for (const device of target.devices) {
            const envelopeId = this.deps.ids.next("env");
            const protectedPayload =
              await this.deps.envelopeProtector.protect({
                tenantId: actor.tenantId,
                conversationId: command.conversation_id,
                messageId: proposedMessageId,
                sourceRevision,
                recipientUserId: target.userId,
                recipientDeviceId: device.deviceId,
                recipientCredentialVersion:
                  device.credentialVersion,
                recipientPublicMaterialRef:
                  device.publicMaterialRef,
                source: command.source,
              });

            if (!protectedPayload) {
              throw new Error(
                "Envelope protector returned an empty payload",
              );
            }

            await this.deps.store.insertDeliveryEnvelope(tx, {
              tenantId: actor.tenantId,
              envelopeId,
              conversationId: command.conversation_id,
              messageId: proposedMessageId,
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
                actor.tenantId,
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
              messageId: proposedMessageId,
              envelopeId,
              sourceRevision,
              createdAt: now,
            });
          }
        }

        for (const target of translationTargets) {
          await this.deps.store.insertOutboxJob(tx, {
            jobId: this.deps.ids.next("job"),
            tenantId: actor.tenantId,
            jobType: "translation.request",
            businessKey:
              `${proposedMessageId}:${sourceRevision}:${target.userId}:${target.targetProfileVersion}:t0-v1`,
            payloadRef: {
              message_id: proposedMessageId,
              source_revision: sourceRevision,
              source_hash: sourceFingerprint,
              source_buffer_key:
                `${actor.tenantId}:${proposedMessageId}:${sourceRevision}`,
              recipient_user_id: target.userId,
              target_language_tag: target.targetLanguageTag,
              target_profile_version: target.targetProfileVersion,
              strategy_version: "t0-v1",
              membership_epoch: allocation.membershipEpoch,
              erasure_epoch: allocation.erasureEpoch,
              policy_version: allocation.policyVersion,
            },
            priority: 10,
            availableAt: now,
          });
        }

        const accepted: AcceptedMessage = {
          protocol_version: 1,
          status: "ACCEPTED",
          message_id: proposedMessageId,
          message_seq: allocation.messageSeq,
          source_revision: sourceRevision,
          accepted_at: now,
          translation_status: translationStatus,
        };

        await this.deps.store.markCommandSucceeded(tx, {
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

      committedNewMessage = true;
      return result;
    } catch (error) {
      if (preparedTransientKey && !committedNewMessage) {
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

  async editMessage(
    actor: ActorContext,
    command: EditMessageCommand,
  ): Promise<MessageRevisionResult> {
    if (!command.source.text) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Source text is required",
      );
    }
    if (
      !Number.isInteger(command.expected_revision) ||
      command.expected_revision < 1
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "expected_revision must be a positive integer",
      );
    }

    const now = this.deps.clock.now();
    const sourceFingerprint =
      this.deps.fingerprinter.fingerprint(command.source);
    if (
      !sourceFingerprint ||
      sourceFingerprint === command.source.text
    ) {
      throw new Error(
        "Source fingerprinter must return an opaque fingerprint",
      );
    }

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "message.edit",
      message_id: command.message_id,
      expected_revision: command.expected_revision,
      source_fingerprint: sourceFingerprint,
    } satisfies EditCommandFingerprintV1);

    let preparedTransientKey: TransientSourceKey | undefined;
    let previousTransientKey: TransientSourceKey | undefined;
    let committed = false;

    try {
      const result = await this.deps.store.withTransaction(async (tx) => {
        const claim = await this.deps.store.claimCommand(tx, {
          actor,
          commandId: command.command_id,
          commandType: "message.edit",
          commandFingerprint,
          now,
        });

        if (!claim.claimed) {
          const existing = claim.existing;
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
            existing.commandType !== "message.edit" ||
            !editFingerprintMatches(
              existing.commandFingerprint,
              command,
              this.deps.fingerprinter,
            )
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "command_id was already used for a different operation",
            );
          }
          if (existing.status !== "SUCCEEDED") {
            throw new Error(
              "Persistent command receipt is not terminal",
            );
          }
          return mutationResultFromResult(existing.result);
        }

        const message =
          await this.deps.store.lockMessageForAuthorMutation(
            tx,
            actor,
            command.message_id,
          );
        if (!message) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Message is not available for mutation",
          );
        }
        if (
          message.status !== "ACTIVE" ||
          message.currentRevision !== command.expected_revision
        ) {
          throw new DomainError(
            "REVISION_CONFLICT",
            "Message revision is stale",
          );
        }

        const allocation =
          await this.deps.store.allocateOperationSequence(
            tx,
            actor,
            message.conversationId,
          );
        if (!allocation) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Conversation is not available to actor",
          );
        }

        const targets =
          await this.deps.store.listRecipientDeliveryTargets(
            tx,
            actor,
            message.conversationId,
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

        const previousRevision = message.currentRevision;
        const newRevision = previousRevision + 1;

        const transientBuffered =
          await this.bestEffortBufferSource(
            actor.tenantId,
            command.message_id,
            newRevision,
            sourceFingerprint,
            now,
            command.source,
          );
        if (transientBuffered) {
          preparedTransientKey = {
            tenantId: actor.tenantId,
            messageId: command.message_id,
            sourceRevision: newRevision,
          };
        }
        previousTransientKey = {
          tenantId: actor.tenantId,
          messageId: command.message_id,
          sourceRevision: previousRevision,
        };

        await this.deps.store.insertMessageRevision(tx, {
          tenantId: actor.tenantId,
          conversationId: message.conversationId,
          messageId: command.message_id,
          revision: newRevision,
          opSeq: allocation.opSeq,
          mutationType: "EDITED",
          actorUserId: actor.userId,
          sourceHash: sourceFingerprint,
          sourceLanguage: command.source.language_hint ?? null,
          createdAt: now,
        });

        await this.deps.store.updateMessageRevisionPointer(tx, {
          tenantId: actor.tenantId,
          messageId: command.message_id,
          expectedRevision: previousRevision,
          newRevision,
          status: "ACTIVE",
          deletedAt: null,
        });

        await this.deps.store.revokePendingMessageEnvelopes(tx, {
          tenantId: actor.tenantId,
          messageId: command.message_id,
          throughRevision: previousRevision,
        });

        await this.deps.store.supersedeTranslationJobs(tx, {
          tenantId: actor.tenantId,
          messageId: command.message_id,
          throughRevision: previousRevision,
          now,
        });

        const expiresAt = addSeconds(
          now,
          this.envelopeTtlSeconds,
        );

        for (const target of targets) {
          for (const device of target.devices) {
            const envelopeId = this.deps.ids.next("env");
            const protectedPayload =
              await this.deps.envelopeProtector.protect({
                tenantId: actor.tenantId,
                conversationId: message.conversationId,
                messageId: command.message_id,
                sourceRevision: newRevision,
                recipientUserId: target.userId,
                recipientDeviceId: device.deviceId,
                recipientCredentialVersion:
                  device.credentialVersion,
                recipientPublicMaterialRef:
                  device.publicMaterialRef,
                source: command.source,
              });
            if (!protectedPayload) {
              throw new Error(
                "Envelope protector returned an empty payload",
              );
            }

            await this.deps.store.insertDeliveryEnvelope(tx, {
              tenantId: actor.tenantId,
              envelopeId,
              conversationId: message.conversationId,
              messageId: command.message_id,
              sourceRevision: newRevision,
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
                actor.tenantId,
                device.deviceId,
              );
            await this.deps.store.insertInboxEvent(tx, {
              deviceId: device.deviceId,
              inboxEpoch: inbox.inboxEpoch,
              offset: inbox.offset,
              eventId: this.deps.ids.next("evt"),
              eventType: "message.edited",
              tenantId: actor.tenantId,
              conversationId: message.conversationId,
              messageId: command.message_id,
              envelopeId,
              sourceRevision: newRevision,
              createdAt: now,
            });
          }
        }

        const translationTargets = externalRecipients.filter(
          (target) => Boolean(target.targetLanguageTag),
        );

        for (const target of translationTargets) {
          await this.deps.store.insertOutboxJob(tx, {
            jobId: this.deps.ids.next("job"),
            tenantId: actor.tenantId,
            jobType: "translation.request",
            businessKey:
              `${command.message_id}:${newRevision}:${target.userId}:${target.targetProfileVersion}:t0-v1`,
            payloadRef: {
              message_id: command.message_id,
              source_revision: newRevision,
              source_hash: sourceFingerprint,
              source_buffer_key:
                `${actor.tenantId}:${command.message_id}:${newRevision}`,
              recipient_user_id: target.userId,
              target_language_tag: target.targetLanguageTag,
              target_profile_version: target.targetProfileVersion,
              strategy_version: "t0-v1",
              membership_epoch: allocation.membershipEpoch,
              erasure_epoch: allocation.erasureEpoch,
              policy_version: allocation.policyVersion,
            },
            priority: 10,
            availableAt: now,
          });
        }

        const mutationResult: MessageRevisionResult = {
          message_id: command.message_id,
          revision: newRevision,
          op_seq: allocation.opSeq,
          status: "ACTIVE",
        };

        await this.deps.store.markCommandSucceeded(tx, {
          tenantId: actor.tenantId,
          commandId: command.command_id,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          commandType: "message.edit",
          commandFingerprint,
          result: mutationResult as unknown as Record<string, unknown>,
          now,
        });

        return mutationResult;
      });

      committed = true;
      if (previousTransientKey) {
        try {
          await this.deps.transientSources?.remove(
            previousTransientKey,
          );
        } catch {
          // TTL remains the privacy fallback if post-commit cleanup fails.
        }
      }
      return result;
    } catch (error) {
      if (preparedTransientKey && !committed) {
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

  async deleteMessage(
    actor: ActorContext,
    command: DeleteMessageCommand,
  ): Promise<MessageRevisionResult> {
    if (
      !Number.isInteger(command.expected_revision) ||
      command.expected_revision < 1
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "expected_revision must be a positive integer",
      );
    }

    const now = this.deps.clock.now();
    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "message.delete",
      message_id: command.message_id,
      expected_revision: command.expected_revision,
    } satisfies DeleteCommandFingerprintV1);

    let previousTransientKey: TransientSourceKey | undefined;

    const result = await this.deps.store.withTransaction(async (tx) => {
      const claim = await this.deps.store.claimCommand(tx, {
        actor,
        commandId: command.command_id,
        commandType: "message.delete",
        commandFingerprint,
        now,
      });

      if (!claim.claimed) {
        const existing = claim.existing;
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
          existing.commandType !== "message.delete" ||
          !deleteFingerprintMatches(
            existing.commandFingerprint,
            command,
          )
        ) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "command_id was already used for a different operation",
          );
        }
        if (existing.status !== "SUCCEEDED") {
          throw new Error(
            "Persistent command receipt is not terminal",
          );
        }
        return mutationResultFromResult(existing.result);
      }

      const message =
        await this.deps.store.lockMessageForAuthorMutation(
          tx,
          actor,
          command.message_id,
        );
      if (!message) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Message is not available for mutation",
        );
      }
      if (
        message.status !== "ACTIVE" ||
        message.currentRevision !== command.expected_revision
      ) {
        throw new DomainError(
          "REVISION_CONFLICT",
          "Message revision is stale",
        );
      }

      const allocation =
        await this.deps.store.allocateOperationSequence(
          tx,
          actor,
          message.conversationId,
        );
      if (!allocation) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Conversation is not available to actor",
        );
      }

      const previousRevision = message.currentRevision;
      const newRevision = previousRevision + 1;
      previousTransientKey = {
        tenantId: actor.tenantId,
        messageId: command.message_id,
        sourceRevision: previousRevision,
      };

      await this.deps.store.insertMessageRevision(tx, {
        tenantId: actor.tenantId,
        conversationId: message.conversationId,
        messageId: command.message_id,
        revision: newRevision,
        opSeq: allocation.opSeq,
        mutationType: "DELETED",
        actorUserId: actor.userId,
        sourceHash: null,
        sourceLanguage: null,
        createdAt: now,
      });

      await this.deps.store.updateMessageRevisionPointer(tx, {
        tenantId: actor.tenantId,
        messageId: command.message_id,
        expectedRevision: previousRevision,
        newRevision,
        status: "DELETED",
        deletedAt: now,
      });

      await this.deps.store.revokePendingMessageEnvelopes(tx, {
        tenantId: actor.tenantId,
        messageId: command.message_id,
        throughRevision: previousRevision,
      });

      await this.deps.store.supersedeTranslationJobs(tx, {
        tenantId: actor.tenantId,
        messageId: command.message_id,
        throughRevision: previousRevision,
        now,
      });

      const eventDevices =
        await this.deps.store.listConversationEventDevices(
          tx,
          actor,
          message.conversationId,
        );

      for (const device of eventDevices) {
        const inbox =
          await this.deps.store.allocateDeviceInboxOffset(
            tx,
            actor.tenantId,
            device.deviceId,
          );
        await this.deps.store.insertInboxEvent(tx, {
          deviceId: device.deviceId,
          inboxEpoch: inbox.inboxEpoch,
          offset: inbox.offset,
          eventId: this.deps.ids.next("evt"),
          eventType: "message.deleted",
          tenantId: actor.tenantId,
          conversationId: message.conversationId,
          messageId: command.message_id,
          envelopeId: null,
          sourceRevision: newRevision,
          createdAt: now,
        });
      }

      const mutationResult: MessageRevisionResult = {
        message_id: command.message_id,
        revision: newRevision,
        op_seq: allocation.opSeq,
        status: "DELETED",
      };

      await this.deps.store.markCommandSucceeded(tx, {
        tenantId: actor.tenantId,
        commandId: command.command_id,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        commandType: "message.delete",
        commandFingerprint,
        result: mutationResult as unknown as Record<string, unknown>,
        now,
      });

      return mutationResult;
    });

    if (previousTransientKey) {
      try {
        await this.deps.transientSources?.remove(
          previousTransientKey,
        );
      } catch {
        // TTL remains the privacy fallback if post-commit cleanup fails.
      }
    }
    return result;
  }

  private async bestEffortBufferSource(
    tenantId: UUID,
    messageId: UUID,
    sourceRevision: number,
    sourceHash: string,
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
          sourceHash,
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

function serializeSendCommandFingerprint(
  fingerprint: SendCommandFingerprintV1,
): string {
  return JSON.stringify(fingerprint);
}

function parseSendCommandFingerprint(
  value: string | null,
): SendCommandFingerprintV1 | undefined {
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.type !== "message.send" ||
      typeof parsed.conversation_id !== "string" ||
      typeof parsed.client_message_id !== "string" ||
      typeof parsed.source_fingerprint !== "string" ||
      !(
        parsed.reply_to_message_id === null ||
        typeof parsed.reply_to_message_id === "string"
      ) ||
      !(
        parsed.client_authored_at === null ||
        typeof parsed.client_authored_at === "string"
      )
    ) {
      return undefined;
    }

    return parsed as unknown as SendCommandFingerprintV1;
  } catch {
    return undefined;
  }
}

function commandFingerprintMatches(
  stored: string | null,
  command: SendMessageCommand,
  fingerprinter: PersistentSourceFingerprinter,
): boolean {
  const parsed = parseSendCommandFingerprint(stored);
  if (!parsed) return false;

  return (
    parsed.conversation_id === command.conversation_id &&
    parsed.client_message_id === command.client_message_id &&
    sameNullable(
      parsed.reply_to_message_id,
      command.reply_to_message_id,
    ) &&
    sameTimestamp(
      parsed.client_authored_at,
      command.client_authored_at,
    ) &&
    fingerprinter.matches(
      command.source,
      parsed.source_fingerprint,
    )
  );
}

function parseEditCommandFingerprint(
  value: string | null,
): EditCommandFingerprintV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.type !== "message.edit" ||
      typeof parsed.message_id !== "string" ||
      typeof parsed.expected_revision !== "number" ||
      typeof parsed.source_fingerprint !== "string"
    ) {
      return undefined;
    }
    return parsed as unknown as EditCommandFingerprintV1;
  } catch {
    return undefined;
  }
}

function editFingerprintMatches(
  stored: string | null,
  command: EditMessageCommand,
  fingerprinter: PersistentSourceFingerprinter,
): boolean {
  const parsed = parseEditCommandFingerprint(stored);
  return Boolean(
    parsed &&
    parsed.message_id === command.message_id &&
    parsed.expected_revision === command.expected_revision &&
    fingerprinter.matches(
      command.source,
      parsed.source_fingerprint,
    ),
  );
}

function parseDeleteCommandFingerprint(
  value: string | null,
): DeleteCommandFingerprintV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.type !== "message.delete" ||
      typeof parsed.message_id !== "string" ||
      typeof parsed.expected_revision !== "number"
    ) {
      return undefined;
    }
    return parsed as unknown as DeleteCommandFingerprintV1;
  } catch {
    return undefined;
  }
}

function deleteFingerprintMatches(
  stored: string | null,
  command: DeleteMessageCommand,
): boolean {
  const parsed = parseDeleteCommandFingerprint(stored);
  return Boolean(
    parsed &&
    parsed.message_id === command.message_id &&
    parsed.expected_revision === command.expected_revision,
  );
}

function mutationResultFromResult(
  result: Record<string, unknown>,
): MessageRevisionResult {
  if (
    typeof result.message_id !== "string" ||
    typeof result.revision !== "number" ||
    typeof result.op_seq !== "number" ||
    (result.status !== "ACTIVE" && result.status !== "DELETED")
  ) {
    throw new Error(
      "Invariant violation: invalid persistent mutation command result",
    );
  }
  return {
    message_id: result.message_id,
    revision: result.revision,
    op_seq: result.op_seq,
    status: result.status,
  };
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

function sameNullable(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

function sameTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  return (
    Number.isFinite(leftMillis) &&
    Number.isFinite(rightMillis) &&
    leftMillis === rightMillis
  );
}

function addSeconds(timestamp: string, seconds: number): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new Error("Clock returned an invalid timestamp");
  }
  return new Date(millis + seconds * 1000).toISOString();
}
