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
import type { SqlExecutor } from "../../persistence/src/index.js";
import type {
  CommandClaimResult,
  ExistingMessageAcceptance,
  RecipientDeliveryTarget,
} from "../../persistence-postgres/src/index.js";

export interface PersistentSendClock {
  now(): string;
}

export interface PersistentSendIds {
  next(prefix: string): UUID;
}

export interface SourceDigester {
  digest(source: SourceContent): string;
}

export interface PersistentEnvelopeProtector {
  protect(input: {
    tenantId: UUID;
    conversationId: UUID;
    messageId: UUID;
    sourceRevision: number;
    recipientDeviceId: UUID;
    recipientCredentialVersion: number;
    recipientPublicMaterialRef: string;
    source: SourceContent;
  }): string;
}

export interface TransientSourceRecord {
  messageId: UUID;
  sourceRevision: number;
  sourceHash: string;
  source: SourceContent;
  storedAt: string;
  expiresAt: string;
}

export interface TransientSourceStore {
  put(record: TransientSourceRecord): void;
  get(messageId: UUID, sourceRevision: number): TransientSourceRecord | undefined;
  delete(messageId: UUID, sourceRevision: number): void;
}

export interface PersistentSendRepository {
  withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  claimCommand(
    tx: SqlExecutor,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<CommandClaimResult>;
  lockClientMessageKey(
    tx: SqlExecutor,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<void>;
  findAcceptedMessageByClientId(
    tx: SqlExecutor,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<ExistingMessageAcceptance | undefined>;
  allocateMessageAndOperationSequence(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<{
    messageSeq: number;
    opSeq: number;
    membershipEpoch: number;
    erasureEpoch: number;
    policyVersion: number;
  } | undefined>;
  listRecipientDeliveryTargets(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<RecipientDeliveryTarget[]>;
  replyTargetExists(
    tx: SqlExecutor,
    tenantId: UUID,
    conversationId: UUID,
    messageId: UUID,
  ): Promise<boolean>;
  insertMessageMetadata(
    tx: SqlExecutor,
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
    tx: SqlExecutor,
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
    tx: SqlExecutor,
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
    tx: SqlExecutor,
    deviceId: UUID,
  ): Promise<{ inboxEpoch: number; offset: number }>;
  insertInboxEvent(
    tx: SqlExecutor,
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
    tx: SqlExecutor,
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
    tx: SqlExecutor,
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

export interface PersistentSendDependencies {
  repository: PersistentSendRepository;
  clock: PersistentSendClock;
  ids: PersistentSendIds;
  sourceDigester: SourceDigester;
  envelopeProtector: PersistentEnvelopeProtector;
  transientSources: TransientSourceStore;
  sourceTtlSeconds?: number;
  envelopeTtlSeconds?: number;
}

function sameNullable(a: UUID | null | undefined, b: UUID | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function acceptedFromStoredResult(
  result: Record<string, unknown>,
): AcceptedMessage | undefined {
  if (
    result.protocol_version !== 1 ||
    result.status !== "ACCEPTED" ||
    typeof result.message_id !== "string" ||
    typeof result.message_seq !== "number" ||
    typeof result.source_revision !== "number" ||
    typeof result.accepted_at !== "string" ||
    typeof result.translation_status !== "string"
  ) {
    return undefined;
  }

  const allowed = new Set([
    "NOT_REQUESTED",
    "PENDING",
    "READY",
    "FAILED",
    "SOURCE_REQUIRED",
    "EXPIRED",
    "SUPERSEDED",
  ]);
  if (!allowed.has(result.translation_status)) {
    return undefined;
  }

  return result as unknown as AcceptedMessage;
}

export class PersistentSendService {
  private readonly sourceTtlSeconds: number;
  private readonly envelopeTtlSeconds: number;

  constructor(private readonly deps: PersistentSendDependencies) {
    this.sourceTtlSeconds = deps.sourceTtlSeconds ?? 5 * 60;
    this.envelopeTtlSeconds = deps.envelopeTtlSeconds ?? 7 * 24 * 60 * 60;
  }

  async sendMessage(
    actor: ActorContext,
    command: SendMessageCommand,
  ): Promise<AcceptedMessage> {
    if (!command.source.text) {
      throw new DomainError("INVALID_COMMAND", "Source text is required");
    }

    const now = this.deps.clock.now();
    const sourceHash = this.deps.sourceDigester.digest(command.source);
    if (
      !sourceHash ||
      sourceHash === command.source.text ||
      sourceHash.length < 16
    ) {
      throw new Error("Source digester must return a non-plaintext digest");
    }

    const commandFingerprint = [
      "v1",
      "message.send",
      command.conversation_id,
      command.client_message_id,
      sourceHash,
      command.reply_to_message_id ?? "",
    ].join("|");

    const proposedMessageId = this.deps.ids.next("msg");
    let bufferedNewSource = false;
    let committedNewMessage = false;

    try {
      const result = await this.deps.repository.withTransaction(async (tx) => {
        const claim = await this.deps.repository.claimCommand(tx, {
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
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "command_id was already used for a different operation",
            );
          }
          if (existing.status !== "SUCCEEDED") {
            throw new Error("Persistent command receipt is not terminal");
          }

          const accepted = acceptedFromStoredResult(existing.result);
          if (!accepted) {
            throw new Error("Persistent command receipt has an invalid result");
          }
          return accepted;
        }

        await this.deps.repository.lockClientMessageKey(
          tx,
          actor,
          command.client_message_id,
        );

        const prior = await this.deps.repository.findAcceptedMessageByClientId(
          tx,
          actor,
          command.client_message_id,
        );

        if (prior) {
          if (
            prior.conversationId !== command.conversation_id ||
            prior.originalSourceHash !== sourceHash ||
            !sameNullable(prior.replyToMessageId, command.reply_to_message_id)
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "client_message_id was already used for a different logical message",
            );
          }

          const storedAccepted = prior.acceptedResult
            ? acceptedFromStoredResult(prior.acceptedResult)
            : undefined;
          if (prior.acceptedResult && !storedAccepted) {
            throw new Error("Stored original Send acceptance is invalid");
          }

          const accepted: AcceptedMessage =
            storedAccepted ?? {
              protocol_version: 1,
              status: "ACCEPTED",
              message_id: prior.messageId,
              message_seq: prior.messageSeq,
              source_revision: 1,
              accepted_at: prior.acceptedAt,
              translation_status: "PENDING",
            };

          await this.deps.repository.markCommandSucceeded(tx, {
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
          await this.deps.repository.allocateMessageAndOperationSequence(
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
          const replyExists = await this.deps.repository.replyTargetExists(
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
          await this.deps.repository.listRecipientDeliveryTargets(
            tx,
            actor,
            command.conversation_id,
          );

        const otherUsers = targets.filter(
          (target) => target.userId !== actor.userId,
        );
        if (
          otherUsers.length < 1 ||
          otherUsers.some((target) => target.devices.length < 1)
        ) {
          throw new DomainError(
            "RECIPIENT_UNAVAILABLE",
            "At least one active recipient has no deliverable device",
          );
        }

        let translationStatus: AcceptedMessage["translation_status"] =
          "SOURCE_REQUIRED";
        const storedAt = now;
        const sourceExpiresAt = new Date(
          Date.parse(now) + this.sourceTtlSeconds * 1000,
        ).toISOString();

        try {
          this.deps.transientSources.put({
            messageId: proposedMessageId,
            sourceRevision: 1,
            sourceHash,
            source: {
              text: command.source.text,
              ...(command.source.language_hint
                ? { language_hint: command.source.language_hint }
                : {}),
            },
            storedAt,
            expiresAt: sourceExpiresAt,
          });
          bufferedNewSource = true;
          translationStatus = "PENDING";
        } catch {
          // Translation is allowed to degrade without rejecting original delivery.
        }

        await this.deps.repository.insertMessageMetadata(tx, {
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

        await this.deps.repository.insertMessageRevision(tx, {
          tenantId: actor.tenantId,
          conversationId: command.conversation_id,
          messageId: proposedMessageId,
          revision: 1,
          opSeq: allocation.opSeq,
          mutationType: "CREATED",
          actorUserId: actor.userId,
          sourceHash,
          sourceLanguage: command.source.language_hint ?? null,
          createdAt: now,
        });

        const expiresAt = new Date(
          Date.parse(now) + this.envelopeTtlSeconds * 1000,
        ).toISOString();

        for (const target of targets) {
          for (const device of target.devices) {
            const envelopeId = this.deps.ids.next("env");
            const protectedPayload = this.deps.envelopeProtector.protect({
              tenantId: actor.tenantId,
              conversationId: command.conversation_id,
              messageId: proposedMessageId,
              sourceRevision: 1,
              recipientDeviceId: device.deviceId,
              recipientCredentialVersion: device.credentialVersion,
              recipientPublicMaterialRef: device.publicMaterialRef,
              source: command.source,
            });
            if (!protectedPayload) {
              throw new Error("Envelope protector returned an empty payload");
            }

            await this.deps.repository.insertDeliveryEnvelope(tx, {
              tenantId: actor.tenantId,
              envelopeId,
              conversationId: command.conversation_id,
              messageId: proposedMessageId,
              sourceRevision: 1,
              recipientUserId: device.userId,
              recipientDeviceId: device.deviceId,
              credentialVersion: device.credentialVersion,
              protectedPayload,
              createdAt: now,
              expiresAt,
            });

            const position =
              await this.deps.repository.allocateDeviceInboxOffset(
                tx,
                device.deviceId,
              );

            await this.deps.repository.insertInboxEvent(tx, {
              deviceId: device.deviceId,
              inboxEpoch: position.inboxEpoch,
              offset: position.offset,
              eventId: this.deps.ids.next("evt"),
              eventType: "message.available",
              tenantId: actor.tenantId,
              conversationId: command.conversation_id,
              messageId: proposedMessageId,
              envelopeId,
              sourceRevision: 1,
              createdAt: now,
            });
          }
        }

        await this.deps.repository.insertOutboxJob(tx, {
          jobId: this.deps.ids.next("job"),
          tenantId: actor.tenantId,
          jobType: "translation.request",
          businessKey: `${proposedMessageId}:1`,
          payloadRef: {
            message_id: proposedMessageId,
            source_revision: 1,
            source_hash: sourceHash,
            source_buffer_key: `${proposedMessageId}:1`,
            membership_epoch: allocation.membershipEpoch,
            erasure_epoch: allocation.erasureEpoch,
            policy_version: allocation.policyVersion,
          },
          priority: 10,
          availableAt: now,
        });

        const accepted: AcceptedMessage = {
          protocol_version: 1,
          status: "ACCEPTED",
          message_id: proposedMessageId,
          message_seq: allocation.messageSeq,
          source_revision: 1,
          accepted_at: now,
          translation_status: translationStatus,
        };

        await this.deps.repository.markCommandSucceeded(tx, {
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
      if (bufferedNewSource && !committedNewMessage) {
        this.deps.transientSources.delete(proposedMessageId, 1);
      }
      throw error;
    }
  }
}

interface BoundedTransientSourceStoreOptions {
  clock: PersistentSendClock;
  maxEntries?: number;
  maxTotalChars?: number;
}

export class BoundedTransientSourceStore implements TransientSourceStore {
  private readonly records = new Map<string, TransientSourceRecord>();
  private readonly maxEntries: number;
  private readonly maxTotalChars: number;
  private totalChars = 0;

  constructor(private readonly options: BoundedTransientSourceStoreOptions) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxTotalChars = options.maxTotalChars ?? 5_000_000;
    if (this.maxEntries < 1 || this.maxTotalChars < 1) {
      throw new Error("Transient source limits must be positive");
    }
  }

  put(record: TransientSourceRecord): void {
    this.purgeExpired();

    const chars = record.source.text.length;
    if (chars > this.maxTotalChars) {
      throw new Error("Transient source exceeds total character budget");
    }

    const key = this.key(record.messageId, record.sourceRevision);
    const existing = this.records.get(key);
    if (existing) {
      throw new Error("Transient source key already exists");
    }

    const projectedEntries = this.records.size + 1;
    const projectedChars = this.totalChars + chars;

    if (
      projectedEntries > this.maxEntries ||
      projectedChars > this.maxTotalChars
    ) {
      throw new Error("Transient source capacity is exhausted");
    }

    this.records.set(key, {
      ...record,
      source: { ...record.source },
    });
    this.totalChars += chars;
  }

  get(
    messageId: UUID,
    sourceRevision: number,
  ): TransientSourceRecord | undefined {
    this.purgeExpired();
    const record = this.records.get(this.key(messageId, sourceRevision));
    return record
      ? {
          ...record,
          source: { ...record.source },
        }
      : undefined;
  }

  delete(messageId: UUID, sourceRevision: number): void {
    const key = this.key(messageId, sourceRevision);
    const existing = this.records.get(key);
    if (existing) {
      this.totalChars -= existing.source.text.length;
      this.records.delete(key);
    }
  }

  stats(): { entries: number; totalChars: number } {
    this.purgeExpired();
    return {
      entries: this.records.size,
      totalChars: this.totalChars,
    };
  }

  private purgeExpired(): void {
    const now = Date.parse(this.options.clock.now());
    for (const [key, record] of this.records.entries()) {
      if (Date.parse(record.expiresAt) <= now) {
        this.totalChars -= record.source.text.length;
        this.records.delete(key);
      }
    }
  }

  private key(messageId: UUID, sourceRevision: number): string {
    return `${messageId}:${sourceRevision}`;
  }
}
