import type { ActorContext, UUID } from "../../domain/src/index.js";
import type {
  SqlExecutor,
  SqlQueryResult,
  SqlTransactionManager,
  SqlValue,
} from "../../persistence/src/index.js";

export interface ConversationAllocation {
  messageSeq: number;
  opSeq: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
}

export interface RecipientDevice {
  userId: UUID;
  deviceId: UUID;
  credentialVersion: number;
  publicMaterialRef: string;
}

export interface RecipientDeliveryTarget {
  userId: UUID;
  targetLanguageTag: string | null;
  targetProfileVersion: number;
  devices: RecipientDevice[];
}

export interface ExistingMessageAcceptance {
  messageId: UUID;
  conversationId: UUID;
  replyToMessageId: UUID | null;
  messageSeq: number;
  acceptedAt: string;
  clientAuthoredAt: string | null;
  originalSourceHash: string | null;
  acceptedResult: Record<string, unknown> | null;
}

export interface CommandReceiptRow {
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export type CommandClaimResult =
  | { claimed: true }
  | { claimed: false; existing: CommandReceiptRow };

export interface InboxEventRow {
  inboxEpoch: number;
  offset: number;
  eventId: UUID;
  eventType: "message.available" | "message.edited" | "message.deleted";
  tenantId: UUID;
  conversationId: UUID;
  messageId: UUID;
  envelopeId: UUID | null;
  sourceRevision: number;
  protectedPayload: string | null;
  renditionType: "ORIGINAL" | "TRANSLATION" | null;
  expiresAt: string | null;
  createdAt: string;
}

export {
  evaluateSyncCursor,
} from "../../delivery-service/src/index.js";
export type {
  SyncCursorDecision,
} from "../../delivery-service/src/index.js";

function first<Row extends Record<string, unknown>>(
  result: SqlQueryResult<Row>,
): Row | undefined {
  return result.rows[0];
}

export class PostgresMessagingRepository {
  constructor(private readonly transactions: SqlTransactionManager) {}

  withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async findCommandReceipt(
    tx: SqlExecutor,
    actor: ActorContext,
    commandId: UUID,
  ): Promise<CommandReceiptRow | undefined> {
    const result = await tx.query<{
      actor_user_id: UUID;
      actor_device_id: UUID;
      command_type: string;
      command_fingerprint: string | null;
      status: CommandReceiptRow["status"];
      result_ref: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, actor_device_id,
              command_type, command_fingerprint, status, result_ref
         FROM command_receipts
        WHERE tenant_id = $1
          AND command_id = $2
          AND actor_user_id = $3
          AND actor_device_id = $4`,
      [actor.tenantId, commandId, actor.userId, actor.deviceId],
    );
    const row = first(result);
    return row
      ? {
          actorUserId: row.actor_user_id,
          actorDeviceId: row.actor_device_id,
          commandType: row.command_type,
          commandFingerprint: row.command_fingerprint,
          status: row.status,
          result: row.result_ref,
        }
      : undefined;
  }

  async claimCommand(
    tx: SqlExecutor,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<CommandClaimResult> {
    const inserted = await tx.query<{ command_id: UUID }>(
      `INSERT INTO command_receipts(
         tenant_id, command_id, actor_user_id, actor_device_id,
         command_type, command_fingerprint, status,
         result_ref, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS','{}'::jsonb,$7,$7)
       ON CONFLICT (tenant_id, command_id) DO NOTHING
       RETURNING command_id`,
      [
        input.actor.tenantId,
        input.commandId,
        input.actor.userId,
        input.actor.deviceId,
        input.commandType,
        input.commandFingerprint,
        input.now,
      ],
    );

    if (inserted.rowCount === 1) {
      return { claimed: true };
    }

    const existing = await tx.query<{
      actor_user_id: UUID;
      actor_device_id: UUID;
      command_type: string;
      command_fingerprint: string | null;
      status: CommandReceiptRow["status"];
      result_ref: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, actor_device_id,
              command_type, command_fingerprint, status, result_ref
         FROM command_receipts
        WHERE tenant_id = $1
          AND command_id = $2
        FOR UPDATE`,
      [input.actor.tenantId, input.commandId],
    );
    const row = first(existing);
    if (!row) {
      throw new Error("Command conflict disappeared inside transaction");
    }

    return {
      claimed: false,
      existing: {
        actorUserId: row.actor_user_id,
        actorDeviceId: row.actor_device_id,
        commandType: row.command_type,
        commandFingerprint: row.command_fingerprint,
        status: row.status,
        result: row.result_ref,
      },
    };
  }

  async lockClientMessageKey(
    tx: SqlExecutor,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<void> {
    const lockKey = [
      actor.tenantId,
      actor.userId,
      clientMessageId,
    ].join(":");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );
  }

  async findAcceptedMessageByClientId(
    tx: SqlExecutor,
    actor: ActorContext,
    clientMessageId: UUID,
  ): Promise<ExistingMessageAcceptance | undefined> {
    const result = await tx.query<{
      message_id: UUID;
      conversation_id: UUID;
      reply_to_message_id: UUID | null;
      message_seq: number;
      accepted_at: string;
      client_authored_at: string | null;
      source_hash: string | null;
      accepted_result: Record<string, unknown> | null;
    }>(
      `SELECT mm.message_id,
              mm.conversation_id,
              mm.reply_to_message_id,
              mm.message_seq,
              mm.accepted_at::text AS accepted_at,
              mm.client_authored_at::text AS client_authored_at,
              mr.source_hash,
              original_receipt.result_ref AS accepted_result
         FROM message_metadata mm
         JOIN message_revisions mr
           ON mr.tenant_id = mm.tenant_id
          AND mr.message_id = mm.message_id
          AND mr.revision = 1
         LEFT JOIN LATERAL (
           SELECT cr.result_ref
             FROM command_receipts cr
            WHERE cr.tenant_id = mm.tenant_id
              AND cr.actor_user_id = mm.author_user_id
              AND cr.command_type = 'message.send'
              AND cr.status = 'SUCCEEDED'
              AND cr.result_ref->>'message_id' = mm.message_id::text
            ORDER BY cr.created_at
            LIMIT 1
         ) original_receipt ON TRUE
        WHERE mm.tenant_id = $1
          AND mm.author_user_id = $2
          AND mm.client_message_id = $3`,
      [actor.tenantId, actor.userId, clientMessageId],
    );
    const row = first(result);
    return row
      ? {
          messageId: row.message_id,
          conversationId: row.conversation_id,
          replyToMessageId: row.reply_to_message_id,
          messageSeq: Number(row.message_seq),
          acceptedAt: row.accepted_at,
          clientAuthoredAt: row.client_authored_at,
          originalSourceHash: row.source_hash,
          acceptedResult: row.accepted_result,
        }
      : undefined;
  }

  async allocateMessageAndOperationSequence(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<ConversationAllocation | undefined> {
    const result = await tx.query<{
      message_seq: number;
      op_seq: number;
      membership_epoch: number;
      erasure_epoch: number;
      policy_version: number;
    }>(
      `UPDATE conversations c
          SET next_message_seq = c.next_message_seq + 1,
              next_op_seq = c.next_op_seq + 1
         FROM conversation_members cm
         JOIN tenant_memberships tm
           ON tm.tenant_id = cm.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
         JOIN devices actor_device
           ON actor_device.device_id = $4
          AND actor_device.user_id = cm.user_id
          AND actor_device.status = 'ACTIVE'
        WHERE c.tenant_id = $1
          AND c.conversation_id = $2
          AND c.status = 'ACTIVE'
          AND cm.tenant_id = c.tenant_id
          AND cm.conversation_id = c.conversation_id
          AND cm.user_id = $3
          AND cm.status = 'ACTIVE'
      RETURNING c.next_message_seq - 1 AS message_seq,
                c.next_op_seq - 1 AS op_seq,
                c.membership_epoch,
                c.erasure_epoch,
                c.policy_version`,
      [actor.tenantId, conversationId, actor.userId, actor.deviceId],
    );
    const row = first(result);
    return row
      ? {
          messageSeq: Number(row.message_seq),
          opSeq: Number(row.op_seq),
          membershipEpoch: Number(row.membership_epoch),
          erasureEpoch: Number(row.erasure_epoch),
          policyVersion: Number(row.policy_version),
        }
      : undefined;
  }

  async listRecipientDeliveryTargets(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<RecipientDeliveryTarget[]> {
    const result = await tx.query<{
      user_id: UUID;
      device_id: UUID | null;
      credential_version: number | null;
      public_material_ref: string | null;
      target_language_tag: string | null;
      target_profile_version: number;
    }>(
      `SELECT cm.user_id,
              d.device_id,
              d.credential_version,
              d.public_material_ref,
              COALESCE(cm.target_language_tag, u.default_language_tag)
                AS target_language_tag,
              cm.target_profile_version
         FROM conversation_members cm
         JOIN tenant_memberships tm
           ON tm.tenant_id = cm.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
         JOIN users u
           ON u.user_id = cm.user_id
          AND u.status = 'ACTIVE'
         LEFT JOIN devices d
           ON d.user_id = cm.user_id
          AND d.status = 'ACTIVE'
          AND d.device_id <> $3
          AND length(d.public_material_ref) > 0
        WHERE cm.tenant_id = $1
          AND cm.conversation_id = $2
          AND cm.status = 'ACTIVE'
        ORDER BY cm.user_id, d.device_id`,
      [actor.tenantId, conversationId, actor.deviceId],
    );

    const targets = new Map<UUID, RecipientDeliveryTarget>();
    for (const row of result.rows) {
      const target = targets.get(row.user_id) ?? {
        userId: row.user_id,
        targetLanguageTag: row.target_language_tag,
        targetProfileVersion: Number(row.target_profile_version),
        devices: [],
      };
      if (
        row.device_id &&
        row.credential_version !== null &&
        row.public_material_ref
      ) {
        target.devices.push({
          userId: row.user_id,
          deviceId: row.device_id,
          credentialVersion: Number(row.credential_version),
          publicMaterialRef: row.public_material_ref,
        });
      }
      targets.set(row.user_id, target);
    }
    return [...targets.values()];
  }

  async listConversationEventDevices(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<Array<{ userId: UUID; deviceId: UUID }>> {
    const result = await tx.query<{
      user_id: UUID;
      device_id: UUID;
    }>(
      `SELECT cm.user_id,
              d.device_id
         FROM conversation_members cm
         JOIN tenant_memberships tm
           ON tm.tenant_id = cm.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
         JOIN devices d
           ON d.user_id = cm.user_id
          AND d.status = 'ACTIVE'
          AND d.device_id <> $3
        WHERE cm.tenant_id = $1
          AND cm.conversation_id = $2
          AND cm.status = 'ACTIVE'
        ORDER BY cm.user_id, d.device_id`,
      [actor.tenantId, conversationId, actor.deviceId],
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id,
    }));
  }

  async lockMessageForAuthorMutation(
    tx: SqlExecutor,
    actor: ActorContext,
    messageId: UUID,
  ): Promise<{
    conversationId: UUID;
    messageSeq: number;
    currentRevision: number;
    status: "ACTIVE" | "DELETED";
  } | undefined> {
    const result = await tx.query<{
      conversation_id: UUID;
      message_seq: number;
      current_revision: number;
      status: "ACTIVE" | "DELETED";
    }>(
      `SELECT mm.conversation_id,
              mm.message_seq,
              mm.current_revision,
              mm.status
         FROM message_metadata mm
         JOIN conversation_members cm
           ON cm.tenant_id = mm.tenant_id
          AND cm.conversation_id = mm.conversation_id
          AND cm.user_id = $3
          AND cm.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = mm.tenant_id
          AND tm.user_id = $3
          AND tm.status = 'ACTIVE'
         JOIN devices d
           ON d.device_id = $4
          AND d.user_id = $3
          AND d.status = 'ACTIVE'
        WHERE mm.tenant_id = $1
          AND mm.message_id = $2
          AND mm.author_user_id = $3
        FOR UPDATE OF mm`,
      [
        actor.tenantId,
        messageId,
        actor.userId,
        actor.deviceId,
      ],
    );
    const row = first(result);
    return row
      ? {
          conversationId: row.conversation_id,
          messageSeq: Number(row.message_seq),
          currentRevision: Number(row.current_revision),
          status: row.status,
        }
      : undefined;
  }

  async allocateOperationSequence(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: UUID,
  ): Promise<{
    opSeq: number;
    membershipEpoch: number;
    erasureEpoch: number;
    policyVersion: number;
  } | undefined> {
    const result = await tx.query<{
      op_seq: number;
      membership_epoch: number;
      erasure_epoch: number;
      policy_version: number;
    }>(
      `UPDATE conversations c
          SET next_op_seq = c.next_op_seq + 1
         FROM conversation_members cm
         JOIN tenant_memberships tm
           ON tm.tenant_id = cm.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
         JOIN devices actor_device
           ON actor_device.device_id = $4
          AND actor_device.user_id = cm.user_id
          AND actor_device.status = 'ACTIVE'
        WHERE c.tenant_id = $1
          AND c.conversation_id = $2
          AND c.status = 'ACTIVE'
          AND cm.tenant_id = c.tenant_id
          AND cm.conversation_id = c.conversation_id
          AND cm.user_id = $3
          AND cm.status = 'ACTIVE'
      RETURNING c.next_op_seq - 1 AS op_seq,
                c.membership_epoch,
                c.erasure_epoch,
                c.policy_version`,
      [
        actor.tenantId,
        conversationId,
        actor.userId,
        actor.deviceId,
      ],
    );
    const row = first(result);
    return row
      ? {
          opSeq: Number(row.op_seq),
          membershipEpoch: Number(row.membership_epoch),
          erasureEpoch: Number(row.erasure_epoch),
          policyVersion: Number(row.policy_version),
        }
      : undefined;
  }

  async updateMessageRevisionPointer(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      messageId: UUID;
      expectedRevision: number;
      newRevision: number;
      status: "ACTIVE" | "DELETED";
      deletedAt?: string | null;
    },
  ): Promise<void> {
    const result = await tx.query(
      `UPDATE message_metadata
          SET current_revision = $4,
              status = $5,
              deleted_at = $6
        WHERE tenant_id = $1
          AND message_id = $2
          AND current_revision = $3`,
      [
        input.tenantId,
        input.messageId,
        input.expectedRevision,
        input.newRevision,
        input.status,
        input.deletedAt ?? null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Message revision pointer changed despite mutation lock",
      );
    }
  }

  async revokePendingMessageEnvelopes(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE delivery_envelopes
          SET status = 'REVOKED',
              protected_payload = decode('', 'hex')
        WHERE tenant_id = $1
          AND message_id = $2
          AND source_revision <= $3
          AND status = 'PENDING'`,
      [
        input.tenantId,
        input.messageId,
        input.throughRevision,
      ],
    );
    return result.rowCount;
  }

  async supersedeTranslationJobs(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
      now: string;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE outbox_jobs
          SET status = 'SUPERSEDED',
              completed_at = $4,
              lease_until = NULL
        WHERE tenant_id = $1
          AND job_type = 'translation.request'
          AND payload_ref->>'message_id' = $2
          AND (payload_ref->>'source_revision')::integer <= $3
          AND status IN ('AVAILABLE','LEASED')`,
      [
        input.tenantId,
        input.messageId,
        input.throughRevision,
        input.now,
      ],
    );
    return result.rowCount;
  }

  async replyTargetExists(
    tx: SqlExecutor,
    tenantId: UUID,
    conversationId: UUID,
    messageId: UUID,
  ): Promise<boolean> {
    const result = await tx.query<{ found: boolean }>(
      `SELECT TRUE AS found
         FROM message_metadata
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND message_id = $3
        LIMIT 1`,
      [tenantId, conversationId, messageId],
    );
    return Boolean(first(result)?.found);
  }

  async insertMessageMetadata(
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
  ): Promise<void> {
    await tx.query(
      `INSERT INTO message_metadata(
         tenant_id, message_id, conversation_id,
         author_user_id, author_device_id, client_message_id,
         message_seq, current_revision, status,
         reply_to_message_id, accepted_at, client_authored_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,1,'ACTIVE',$8,$9,$10
       )`,
      [
        input.tenantId,
        input.messageId,
        input.conversationId,
        input.authorUserId,
        input.authorDeviceId,
        input.clientMessageId,
        input.messageSeq,
        input.replyToMessageId ?? null,
        input.acceptedAt,
        input.clientAuthoredAt ?? null,
      ],
    );
  }

  async insertMessageRevision(
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
  ): Promise<void> {
    await tx.query(
      `INSERT INTO message_revisions(
         tenant_id, conversation_id, message_id, revision, op_seq,
         mutation_type, actor_user_id, source_hash,
         declared_source_language, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.tenantId,
        input.conversationId,
        input.messageId,
        input.revision,
        input.opSeq,
        input.mutationType,
        input.actorUserId,
        input.sourceHash ?? null,
        input.sourceLanguage ?? null,
        input.createdAt,
      ],
    );
  }

  async insertDeliveryEnvelope(
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
  ): Promise<void> {
    await tx.query(
      `INSERT INTO delivery_envelopes(
         tenant_id, envelope_id, conversation_id, message_id,
         source_revision, recipient_user_id, recipient_device_id,
         recipient_credential_version, rendition_type,
         protected_payload, status, created_at, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'ORIGINAL',
         decode($9,'base64'),'PENDING',$10,$11
       )`,
      [
        input.tenantId,
        input.envelopeId,
        input.conversationId,
        input.messageId,
        input.sourceRevision,
        input.recipientUserId,
        input.recipientDeviceId,
        input.credentialVersion,
        input.protectedPayload,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  async allocateDeviceInboxOffset(
    tx: SqlExecutor,
    tenantId: UUID,
    deviceId: UUID,
  ): Promise<{ inboxEpoch: number; offset: number }> {
    const result = await tx.query<{
      inbox_epoch: number;
      offset_value: number;
    }>(
      `UPDATE device_sync_states
          SET next_offset = next_offset + 1,
              updated_at = now()
        WHERE device_id = $1
      RETURNING inbox_epoch,
                next_offset - 1 AS offset_value`,
      [deviceId],
    );
    const row = first(result);
    if (!row) {
      throw new Error("Missing device_sync_states row");
    }

    await tx.query(
      `INSERT INTO tenant_device_sync_states(
         tenant_id, device_id, inbox_epoch,
         last_acked_offset, updated_at
       ) VALUES ($1,$2,$3,0,now())
       ON CONFLICT (tenant_id, device_id)
       DO UPDATE SET
         inbox_epoch = EXCLUDED.inbox_epoch,
         last_acked_offset = CASE
           WHEN tenant_device_sync_states.inbox_epoch = EXCLUDED.inbox_epoch
           THEN tenant_device_sync_states.last_acked_offset
           ELSE 0
         END,
         updated_at = CASE
           WHEN tenant_device_sync_states.inbox_epoch = EXCLUDED.inbox_epoch
           THEN tenant_device_sync_states.updated_at
           ELSE now()
         END`,
      [tenantId, deviceId, Number(row.inbox_epoch)],
    );

    return {
      inboxEpoch: Number(row.inbox_epoch),
      offset: Number(row.offset_value),
    };
  }

  async insertInboxEvent(
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
  ): Promise<void> {
    await tx.query(
      `INSERT INTO device_inbox_events(
         device_id, inbox_epoch, offset_value, event_id, event_type,
         tenant_id, conversation_id, message_id, envelope_id,
         metadata, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,
         jsonb_build_object('source_revision',$10),$11
       )`,
      [
        input.deviceId,
        input.inboxEpoch,
        input.offset,
        input.eventId,
        input.eventType,
        input.tenantId,
        input.conversationId,
        input.messageId,
        input.envelopeId ?? null,
        input.sourceRevision,
        input.createdAt,
      ],
    );
  }

  async insertOutboxJob(
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
  ): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_jobs(
         job_id, tenant_id, job_type, business_key,
         payload_ref, priority, status, available_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'AVAILABLE',$7)
       ON CONFLICT (tenant_id, job_type, business_key) DO NOTHING`,
      [
        input.jobId,
        input.tenantId,
        input.jobType,
        input.businessKey,
        JSON.stringify(input.payloadRef),
        input.priority,
        input.availableAt,
      ],
    );
  }

  async markCommandSucceeded(
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
  ): Promise<void> {
    const updated = await tx.query(
      `UPDATE command_receipts
          SET status = 'SUCCEEDED',
              result_ref = $7::jsonb,
              updated_at = $8
        WHERE tenant_id = $1
          AND command_id = $2
          AND actor_user_id = $3
          AND actor_device_id = $4
          AND command_type = $5
          AND command_fingerprint = $6
          AND status = 'IN_PROGRESS'`,
      [
        input.tenantId,
        input.commandId,
        input.actorUserId,
        input.actorDeviceId,
        input.commandType,
        input.commandFingerprint,
        JSON.stringify(input.result),
        input.now,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("Command receipt was not claimable as succeeded");
    }
  }

  async getDeviceSyncState(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<{
    inboxEpoch: number;
    nextOffset: number;
    lastAckedOffset: number;
  } | undefined> {
    const result = await tx.query<{
      inbox_epoch: number;
      next_offset: number;
      last_acked_offset: number;
    }>(
      `SELECT dss.inbox_epoch,
              dss.next_offset,
              COALESCE(tds.last_acked_offset, 0) AS last_acked_offset
         FROM device_sync_states dss
         JOIN devices d
           ON d.device_id = dss.device_id
          AND d.user_id = $2
          AND d.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = $1
          AND tm.user_id = d.user_id
          AND tm.status = 'ACTIVE'
         LEFT JOIN tenant_device_sync_states tds
           ON tds.tenant_id = $1
          AND tds.device_id = dss.device_id
          AND tds.inbox_epoch = dss.inbox_epoch
        WHERE dss.device_id = $3`,
      [actor.tenantId, actor.userId, actor.deviceId],
    );
    const row = first(result);
    return row
      ? {
          inboxEpoch: Number(row.inbox_epoch),
          nextOffset: Number(row.next_offset),
          lastAckedOffset: Number(row.last_acked_offset),
        }
      : undefined;
  }

  async listInboxEvents(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      deviceId: UUID;
      inboxEpoch: number;
      afterOffset: number;
      limit: number;
    },
  ): Promise<InboxEventRow[]> {
    const result = await tx.query<{
      inbox_epoch: number;
      offset_value: number;
      event_id: UUID;
      event_type: InboxEventRow["eventType"];
      tenant_id: UUID;
      conversation_id: UUID;
      message_id: UUID;
      envelope_id: UUID | null;
      source_revision: number;
      protected_payload_b64: string | null;
      rendition_type: "ORIGINAL" | "TRANSLATION" | null;
      expires_at: string | null;
      created_at: string;
    }>(
      `SELECT die.inbox_epoch,
              die.offset_value,
              die.event_id,
              die.event_type,
              die.tenant_id,
              die.conversation_id,
              die.message_id,
              die.envelope_id,
              COALESCE(
                de.source_revision,
                (die.metadata->>'source_revision')::integer
              ) AS source_revision,
              CASE
                WHEN de.status = 'PENDING'
                THEN encode(de.protected_payload,'base64')
                ELSE NULL
              END AS protected_payload_b64,
              CASE
                WHEN de.status = 'PENDING'
                THEN de.rendition_type
                ELSE NULL
              END AS rendition_type,
              CASE
                WHEN de.status = 'PENDING'
                THEN de.expires_at::text
                ELSE NULL
              END AS expires_at,
              die.created_at::text AS created_at
         FROM device_inbox_events die
         LEFT JOIN delivery_envelopes de
           ON de.tenant_id = die.tenant_id
          AND de.envelope_id = die.envelope_id
          AND de.recipient_device_id = die.device_id
        WHERE die.tenant_id = $1
          AND die.device_id = $2
          AND die.inbox_epoch = $3
          AND die.offset_value > $4
        ORDER BY die.offset_value
        LIMIT $5`,
      [
        input.tenantId,
        input.deviceId,
        input.inboxEpoch,
        input.afterOffset,
        input.limit,
      ],
    );

    return result.rows.map((row) => ({
      inboxEpoch: Number(row.inbox_epoch),
      offset: Number(row.offset_value),
      eventId: row.event_id,
      eventType: row.event_type,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      envelopeId: row.envelope_id,
      sourceRevision: Number(row.source_revision),
      protectedPayload: row.protected_payload_b64,
      renditionType: row.rendition_type,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  async acknowledgeEnvelope(
    tx: SqlExecutor,
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
  > {
    const lookup = await tx.query<{
      status: "PENDING" | "ACKED" | "EXPIRED" | "REVOKED";
      inbox_epoch: number;
      offset_value: number;
    }>(
      `SELECT de.status,
              die.inbox_epoch,
              die.offset_value
         FROM delivery_envelopes de
         JOIN device_inbox_events die
           ON die.tenant_id = de.tenant_id
          AND die.envelope_id = de.envelope_id
          AND die.device_id = de.recipient_device_id
        WHERE de.tenant_id = $1
          AND de.envelope_id = $2
          AND de.recipient_device_id = $3
        FOR UPDATE`,
      [input.tenantId, input.envelopeId, input.deviceId],
    );
    const row = first(lookup);
    if (!row) return "NOT_FOUND";
    if (row.status === "ACKED") return "ALREADY_ACKED";
    if (row.status === "EXPIRED") return "EXPIRED";
    if (row.status === "REVOKED") return "REVOKED";

    await tx.query(
      `UPDATE delivery_envelopes
          SET status = 'ACKED',
              acked_at = $4,
              protected_payload = decode('', 'hex')
        WHERE tenant_id = $1
          AND envelope_id = $2
          AND recipient_device_id = $3
          AND status = 'PENDING'`,
      [input.tenantId, input.envelopeId, input.deviceId, input.ackedAt],
    );

    const syncState = await tx.query<{
      inbox_epoch: number;
      next_offset: number;
      last_acked_offset: number;
    }>(
      `SELECT dss.inbox_epoch,
              dss.next_offset,
              tds.last_acked_offset
         FROM device_sync_states dss
         JOIN tenant_device_sync_states tds
           ON tds.tenant_id = $1
          AND tds.device_id = dss.device_id
          AND tds.inbox_epoch = dss.inbox_epoch
        WHERE dss.device_id = $2
        FOR UPDATE OF tds`,
      [input.tenantId, input.deviceId],
    );
    const state = first(syncState);
    if (!state || Number(state.inbox_epoch) !== Number(row.inbox_epoch)) {
      throw new Error(
        "Invariant violation: missing or mismatched device sync state",
      );
    }

    const blocker = await tx.query<{
      first_blocking_offset: number | null;
    }>(
      `SELECT MIN(die.offset_value) AS first_blocking_offset
         FROM device_inbox_events die
         LEFT JOIN delivery_envelopes de
           ON de.tenant_id = die.tenant_id
          AND de.envelope_id = die.envelope_id
          AND de.recipient_device_id = die.device_id
        WHERE die.tenant_id = $1
          AND die.device_id = $2
          AND die.inbox_epoch = $3
          AND die.offset_value > $4
          AND die.envelope_id IS NOT NULL
          AND (
            de.envelope_id IS NULL
            OR de.status = 'PENDING'
          )`,
      [
        input.tenantId,
        input.deviceId,
        Number(state.inbox_epoch),
        Number(state.last_acked_offset),
      ],
    );

    const firstBlockingOffset =
      first(blocker)?.first_blocking_offset;
    const terminalPrefix =
      firstBlockingOffset === null ||
      firstBlockingOffset === undefined
        ? Number(state.next_offset) - 1
        : Number(firstBlockingOffset) - 1;

    await tx.query(
      `UPDATE tenant_device_sync_states
          SET last_acked_offset = GREATEST(last_acked_offset, $3),
              updated_at = $4
        WHERE tenant_id = $1
          AND device_id = $2
          AND inbox_epoch = $5`,
      [
        input.tenantId,
        input.deviceId,
        terminalPrefix,
        input.ackedAt,
        Number(state.inbox_epoch),
      ],
    );

    return "ACKED";
  }
}

export class PostgresSessionRepository {
  constructor(private readonly transactions: SqlTransactionManager) {}

  async findActiveActorByCredentialReference(
    reference: string,
    now: string,
  ): Promise<ActorContext | undefined> {
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<{
        tenant_id: UUID;
        user_id: UUID;
        device_id: UUID;
      }>(
        `SELECT s.tenant_id, s.user_id, s.device_id
           FROM sessions s
           JOIN devices d
             ON d.device_id = s.device_id
            AND d.user_id = s.user_id
            AND d.status = 'ACTIVE'
           JOIN tenant_memberships tm
             ON tm.tenant_id = s.tenant_id
            AND tm.user_id = s.user_id
            AND tm.status = 'ACTIVE'
          WHERE s.access_credential_ref = $1
            AND s.tenant_id IS NOT NULL
            AND s.status = 'ACTIVE'
            AND s.expires_at > $2
          LIMIT 1`,
        [reference, now],
      );
      const row = first(result);
      return row
        ? {
            tenantId: row.tenant_id,
            userId: row.user_id,
            deviceId: row.device_id,
          }
        : undefined;
    });
  }
}
