import type { ActorContext, UUID } from "../../domain/src/index.js";
import type { OutboxJobLease } from "../../outbox-service/src/index.js";
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
  devices: RecipientDevice[];
}

export interface ManagedDeviceRecord {
  deviceId: UUID;
  userId: UUID;
  status: "ACTIVE" | "REVOKED" | "LOST";
  credentialVersion: number;
  publicMaterialRef: string;
  platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
  revocationEpoch: number;
  registeredAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
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

export {
  evaluateSyncCursor,
} from "../../delivery-service/src/index.js";
export type {
  SyncCursorDecision,
} from "../../delivery-service/src/index.js";

function managedDevice(row: {
  device_id: UUID;
  user_id: UUID;
  status: "ACTIVE" | "REVOKED" | "LOST";
  credential_version: number;
  public_material_ref: string;
  platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
  revocation_epoch: number;
  registered_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
}): ManagedDeviceRecord {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    status: row.status,
    credentialVersion: Number(row.credential_version),
    publicMaterialRef: row.public_material_ref,
    platform: row.platform,
    revocationEpoch: Number(row.revocation_epoch),
    registeredAt: row.registered_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
  };
}

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

  async actorCanManageDevices(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<boolean> {
    const result = await tx.query<{ found: boolean }>(
      `SELECT TRUE AS found
         FROM tenant_memberships tm
         JOIN devices d
           ON d.user_id = tm.user_id
          AND d.device_id = $3
          AND d.status = 'ACTIVE'
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND tm.status = 'ACTIVE'
        LIMIT 1`,
      [actor.tenantId, actor.userId, actor.deviceId],
    );
    return Boolean(first(result)?.found);
  }

  async lockDeviceForUser(
    tx: SqlExecutor,
    actor: ActorContext,
    deviceId: UUID,
  ): Promise<ManagedDeviceRecord | undefined> {
    const result = await tx.query<{
      device_id: UUID;
      user_id: UUID;
      status: "ACTIVE" | "REVOKED" | "LOST";
      credential_version: number;
      public_material_ref: string;
      platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
      revocation_epoch: number;
      registered_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT target.device_id,
              target.user_id,
              target.status,
              target.credential_version,
              target.public_material_ref,
              target.platform,
              target.revocation_epoch,
              target.registered_at::text AS registered_at,
              target.revoked_at::text AS revoked_at,
              target.last_seen_at::text AS last_seen_at
         FROM devices target
         JOIN tenant_memberships tm
           ON tm.tenant_id = $1
          AND tm.user_id = $2
          AND tm.status = 'ACTIVE'
         JOIN devices actor_device
           ON actor_device.device_id = $3
          AND actor_device.user_id = $2
          AND actor_device.status = 'ACTIVE'
        WHERE target.device_id = $4
          AND target.user_id = $2
        FOR UPDATE OF target`,
      [actor.tenantId, actor.userId, actor.deviceId, deviceId],
    );
    const row = first(result);
    return row ? managedDevice(row) : undefined;
  }

  async insertDevice(
    tx: SqlExecutor,
    input: {
      deviceId: UUID;
      userId: UUID;
      publicMaterialRef: string;
      platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
      registeredAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query<{ device_id: UUID }>(
      `INSERT INTO devices(
         device_id, user_id, status, credential_version,
         public_material_ref, platform, revocation_epoch,
         registered_at
       ) VALUES ($1,$2,'ACTIVE',1,$3,$4,0,$5)
       ON CONFLICT (device_id) DO NOTHING
       RETURNING device_id`,
      [
        input.deviceId,
        input.userId,
        input.publicMaterialRef,
        input.platform,
        input.registeredAt,
      ],
    );
    return result.rowCount === 1;
  }

  async insertDeviceSyncState(
    tx: SqlExecutor,
    deviceId: UUID,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO device_sync_states(device_id)
       VALUES ($1)
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId],
    );
  }

  async listUserDevices(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<ManagedDeviceRecord[]> {
    const result = await tx.query<{
      device_id: UUID;
      user_id: UUID;
      status: "ACTIVE" | "REVOKED" | "LOST";
      credential_version: number;
      public_material_ref: string;
      platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
      revocation_epoch: number;
      registered_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT target.device_id,
              target.user_id,
              target.status,
              target.credential_version,
              target.public_material_ref,
              target.platform,
              target.revocation_epoch,
              target.registered_at::text AS registered_at,
              target.revoked_at::text AS revoked_at,
              target.last_seen_at::text AS last_seen_at
         FROM tenant_memberships tm
         JOIN devices actor_device
           ON actor_device.user_id = tm.user_id
          AND actor_device.device_id = $3
          AND actor_device.status = 'ACTIVE'
         JOIN devices target
           ON target.user_id = tm.user_id
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND tm.status = 'ACTIVE'
        ORDER BY target.registered_at, target.device_id`,
      [actor.tenantId, actor.userId, actor.deviceId],
    );
    return result.rows.map(managedDevice);
  }

  async rotateDeviceMaterial(
    tx: SqlExecutor,
    input: {
      deviceId: UUID;
      userId: UUID;
      expectedCredentialVersion: number;
      publicMaterialRef: string;
      now: string;
    },
  ): Promise<ManagedDeviceRecord | undefined> {
    const result = await tx.query<{
      device_id: UUID;
      user_id: UUID;
      status: "ACTIVE" | "REVOKED" | "LOST";
      credential_version: number;
      public_material_ref: string;
      platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
      revocation_epoch: number;
      registered_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
    }>(
      `UPDATE devices
          SET credential_version = credential_version + 1,
              public_material_ref = $4,
              last_seen_at = $5
        WHERE device_id = $1
          AND user_id = $2
          AND status = 'ACTIVE'
          AND credential_version = $3
      RETURNING device_id,
                user_id,
                status,
                credential_version,
                public_material_ref,
                platform,
                revocation_epoch,
                registered_at::text AS registered_at,
                revoked_at::text AS revoked_at,
                last_seen_at::text AS last_seen_at`,
      [
        input.deviceId,
        input.userId,
        input.expectedCredentialVersion,
        input.publicMaterialRef,
        input.now,
      ],
    );
    const row = first(result);
    return row ? managedDevice(row) : undefined;
  }

  async revokeDevice(
    tx: SqlExecutor,
    input: {
      deviceId: UUID;
      userId: UUID;
      now: string;
    },
  ): Promise<ManagedDeviceRecord | undefined> {
    const result = await tx.query<{
      device_id: UUID;
      user_id: UUID;
      status: "ACTIVE" | "REVOKED" | "LOST";
      credential_version: number;
      public_material_ref: string;
      platform: "WEB" | "ANDROID" | "IOS" | "DESKTOP" | "OTHER";
      revocation_epoch: number;
      registered_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
    }>(
      `UPDATE devices
          SET status = 'REVOKED',
              revocation_epoch = revocation_epoch + 1,
              revoked_at = $3
        WHERE device_id = $1
          AND user_id = $2
          AND status <> 'REVOKED'
      RETURNING device_id,
                user_id,
                status,
                credential_version,
                public_material_ref,
                platform,
                revocation_epoch,
                registered_at::text AS registered_at,
                revoked_at::text AS revoked_at,
                last_seen_at::text AS last_seen_at`,
      [input.deviceId, input.userId, input.now],
    );
    const row = first(result);
    return row ? managedDevice(row) : undefined;
  }

  async revokeActiveSessionsForDevice(
    tx: SqlExecutor,
    input: {
      userId: UUID;
      deviceId: UUID;
      now: string;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE sessions
          SET status = 'REVOKED',
              revoked_at = $3
        WHERE user_id = $1
          AND device_id = $2
          AND status = 'ACTIVE'`,
      [input.userId, input.deviceId, input.now],
    );
    return result.rowCount;
  }

  async revokePendingDeviceEnvelopes(
    tx: SqlExecutor,
    input: {
      deviceId: UUID;
      throughCredentialVersion: number;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE delivery_envelopes
          SET status = 'REVOKED',
              protected_payload = decode('', 'hex')
        WHERE recipient_device_id = $1
          AND recipient_credential_version <= $2
          AND status = 'PENDING'`,
      [input.deviceId, input.throughCredentialVersion],
    );
    return result.rowCount;
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
    }>(
      `SELECT cm.user_id,
              d.device_id,
              d.credential_version,
              d.public_material_ref
         FROM conversation_members cm
         JOIN tenant_memberships tm
           ON tm.tenant_id = cm.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
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

  async listMessageEditDeliveryTargets(
    tx: SqlExecutor,
    actor: ActorContext,
    messageId: UUID,
  ): Promise<RecipientDeliveryTarget[]> {
    const result = await tx.query<{
      user_id: UUID;
      device_id: UUID;
      credential_version: number;
      public_material_ref: string;
    }>(
      `SELECT DISTINCT d.user_id,
                       de.recipient_device_id AS device_id,
                       d.credential_version,
                       d.public_material_ref
         FROM delivery_envelopes de
         JOIN devices d
           ON d.device_id = de.recipient_device_id
          AND d.status = 'ACTIVE'
          AND length(d.public_material_ref) > 0
         JOIN message_metadata mm
           ON mm.tenant_id = de.tenant_id
          AND mm.message_id = de.message_id
         JOIN conversation_members cm
           ON cm.tenant_id = mm.tenant_id
          AND cm.conversation_id = mm.conversation_id
          AND cm.user_id = d.user_id
          AND cm.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = mm.tenant_id
          AND tm.user_id = d.user_id
          AND tm.status = 'ACTIVE'
        WHERE de.tenant_id = $1
          AND de.message_id = $2
          AND de.recipient_device_id <> $3
          AND de.rendition_type = 'ORIGINAL'
        ORDER BY d.user_id, de.recipient_device_id`,
      [actor.tenantId, messageId, actor.deviceId],
    );

    const targets = new Map<UUID, RecipientDeliveryTarget>();
    for (const row of result.rows) {
      const target = targets.get(row.user_id) ?? {
        userId: row.user_id,
        devices: [],
      };
      target.devices.push({
        userId: row.user_id,
        deviceId: row.device_id,
        credentialVersion: Number(row.credential_version),
        publicMaterialRef: row.public_material_ref,
      });
      targets.set(row.user_id, target);
    }
    return [...targets.values()];
  }

  async listMessageDeletionEventDevices(
    tx: SqlExecutor,
    actor: ActorContext,
    messageId: UUID,
  ): Promise<Array<{ userId: UUID; deviceId: UUID }>> {
    const result = await tx.query<{
      user_id: UUID;
      device_id: UUID;
    }>(
      `SELECT DISTINCT d.user_id,
                       de.recipient_device_id AS device_id
         FROM delivery_envelopes de
         JOIN devices d
           ON d.device_id = de.recipient_device_id
          AND d.status = 'ACTIVE'
        WHERE de.tenant_id = $1
          AND de.message_id = $2
          AND de.recipient_device_id <> $3
          AND de.rendition_type = 'ORIGINAL'
        ORDER BY d.user_id, de.recipient_device_id`,
      [actor.tenantId, messageId, actor.deviceId],
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
              lease_until = NULL,
              fencing_token = fencing_token + 1
        WHERE tenant_id = $1
          AND job_type IN ('translation.request','translation.execute')
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

  async cancelStartedProviderAttempts(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
      now: string;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE provider_executions pe
          SET status = 'CANCELLED_LOGICALLY',
              completed_at = $4,
              error_class = COALESCE(
                pe.error_class,
                'SOURCE_REVISION_SUPERSEDED'
              )
         FROM translation_executions te
        WHERE pe.tenant_id = te.tenant_id
          AND pe.translation_id = te.translation_id
          AND te.tenant_id = $1
          AND te.source_message_id = $2
          AND te.source_revision <= $3
          AND pe.status = 'STARTED'`,
      [
        input.tenantId,
        input.messageId,
        input.throughRevision,
        input.now,
      ],
    );
    return result.rowCount;
  }

  async supersedeTranslationExecutions(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      messageId: UUID;
      throughRevision: number;
      now: string;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'SUPERSEDED',
              next_attempt_at = NULL,
              superseded_at = $4
        WHERE tenant_id = $1
          AND source_message_id = $2
          AND source_revision <= $3
          AND status IN (
            'PENDING',
            'SOURCE_REQUIRED',
            'READY',
            'FAILED',
            'EXPIRED'
          )`,
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
    const result = await tx.query(
      `WITH eligible_target AS (
         SELECT d.device_id
           FROM devices d
           JOIN conversation_members cm
             ON cm.tenant_id = $1
            AND cm.conversation_id = $3
            AND cm.user_id = $6
            AND cm.status = 'ACTIVE'
           JOIN tenant_memberships tm
             ON tm.tenant_id = $1
            AND tm.user_id = $6
            AND tm.status = 'ACTIVE'
          WHERE d.device_id = $7
            AND d.user_id = $6
            AND d.status = 'ACTIVE'
            AND d.credential_version = $8
          FOR UPDATE OF d, cm, tm
       )
       INSERT INTO delivery_envelopes(
         tenant_id, envelope_id, conversation_id, message_id,
         source_revision, recipient_user_id, recipient_device_id,
         recipient_credential_version, rendition_type,
         protected_payload, status, created_at, expires_at
       )
       SELECT
         $1,$2,$3,$4,$5,$6,$7,$8,'ORIGINAL',
         decode($9,'base64'),'PENDING',$10,$11
         FROM eligible_target`,
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

    if (result.rowCount !== 1) {
      throw new Error(
        "Delivery target changed before ORIGINAL envelope persistence",
      );
    }
  }

  async insertTranslationDeliveryEnvelope(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      envelopeId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
      translationId: UUID;
      recipientUserId: UUID;
      recipientDeviceId: UUID;
      credentialVersion: number;
      protectedPayload: string;
      createdAt: string;
      expiresAt: string;
    },
  ): Promise<void> {
    const result = await tx.query(
      `WITH eligible_device AS (
         SELECT d.device_id
           FROM devices d
          WHERE d.device_id = $8
            AND d.user_id = $7
            AND d.status = 'ACTIVE'
            AND d.credential_version = $9
          FOR UPDATE OF d
       )
       INSERT INTO delivery_envelopes(
         tenant_id, envelope_id, conversation_id, message_id,
         source_revision, translation_id,
         recipient_user_id, recipient_device_id,
         recipient_credential_version, rendition_type,
         protected_payload, status, created_at, expires_at
       )
       SELECT
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'TRANSLATION',
         decode($10,'base64'),'PENDING',$11,$12
         FROM eligible_device`,
      [
        input.tenantId,
        input.envelopeId,
        input.conversationId,
        input.messageId,
        input.sourceRevision,
        input.translationId,
        input.recipientUserId,
        input.recipientDeviceId,
        input.credentialVersion,
        input.protectedPayload,
        input.createdAt,
        input.expiresAt,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        "Delivery target changed before TRANSLATION envelope persistence",
      );
    }
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
      `WITH eligible_device AS (
         SELECT d.device_id
           FROM devices d
          WHERE d.device_id = $2
            AND d.status = 'ACTIVE'
          FOR UPDATE OF d
       )
       INSERT INTO tenant_device_sync_states(
         tenant_id, device_id, inbox_epoch,
         next_offset, last_acked_offset, updated_at
       )
       SELECT $1, eligible_device.device_id, 1, 2, 0, now()
         FROM eligible_device
       ON CONFLICT (tenant_id, device_id)
       DO UPDATE SET
         next_offset = tenant_device_sync_states.next_offset + 1,
         updated_at = now()
       RETURNING inbox_epoch,
                 next_offset - 1 AS offset_value`,
      [tenantId, deviceId],
    );
    const row = first(result);
    if (!row) {
      throw new Error(
        "Device is not active for tenant-local inbox allocation",
      );
    }

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
      eventType:
        | "message.available"
        | "message.edited"
        | "message.deleted"
        | "translation.source_required";
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      envelopeId?: UUID | null;
      sourceRevision: number;
      translationId?: UUID | null;
      sourceRef?: string | null;
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
         jsonb_strip_nulls(
           jsonb_build_object(
             'source_revision',$10,
             'translation_id',$11,
             'source_ref',$12
           )
         ),
         $13
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
        input.translationId ?? null,
        input.sourceRef ?? null,
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
      `INSERT INTO tenant_device_sync_states(
         tenant_id, device_id, inbox_epoch,
         next_offset, last_acked_offset, updated_at
       )
       SELECT $1, d.device_id, 1, 1, 0, now()
         FROM devices d
         JOIN tenant_memberships tm
           ON tm.tenant_id = $1
          AND tm.user_id = d.user_id
          AND tm.status = 'ACTIVE'
        WHERE d.device_id = $3
          AND d.user_id = $2
          AND d.status = 'ACTIVE'
       ON CONFLICT (tenant_id, device_id)
       DO UPDATE SET
         updated_at = tenant_device_sync_states.updated_at
       RETURNING inbox_epoch,
                 next_offset,
                 last_acked_offset`,
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

  async expireDeliveryEnvelopesBatch(
    tx: SqlExecutor,
    input: {
      now: string;
      limit: number;
    },
  ): Promise<number> {
    const result = await tx.query(
      `WITH candidates AS (
         SELECT tenant_id, envelope_id
           FROM delivery_envelopes
          WHERE status = 'PENDING'
            AND expires_at <= $1
          ORDER BY expires_at, tenant_id, envelope_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE delivery_envelopes de
          SET status = 'EXPIRED',
              protected_payload = decode('', 'hex')
         FROM candidates c
        WHERE de.tenant_id = c.tenant_id
          AND de.envelope_id = c.envelope_id`,
      [input.now, input.limit],
    );
    return result.rowCount;
  }

  async expirePendingDeviceEnvelopes(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      deviceId: UUID;
      now: string;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE delivery_envelopes
          SET status = 'EXPIRED',
              protected_payload = decode('', 'hex')
        WHERE tenant_id = $1
          AND recipient_device_id = $2
          AND status = 'PENDING'
          AND expires_at <= $3`,
      [
        input.tenantId,
        input.deviceId,
        input.now,
      ],
    );
    return result.rowCount;
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
      envelope_status:
        | "PENDING"
        | "ACKED"
        | "EXPIRED"
        | "REVOKED"
        | null;
      expires_at: string | null;
      translation_id: UUID | null;
      source_ref: string | null;
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
              de.status AS envelope_status,
              CASE
                WHEN de.status = 'PENDING'
                THEN de.expires_at::text
                ELSE NULL
              END AS expires_at,
              die.metadata->>'translation_id' AS translation_id,
              die.metadata->>'source_ref' AS source_ref,
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
      envelopeStatus: row.envelope_status,
      expiresAt: row.expires_at,
      translationId: row.translation_id,
      sourceRef: row.source_ref,
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
      expires_at: string;
    }>(
      `SELECT de.status,
              die.inbox_epoch,
              die.offset_value,
              de.expires_at::text AS expires_at
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

    if (Date.parse(row.expires_at) <= Date.parse(input.ackedAt)) {
      await tx.query(
        `UPDATE delivery_envelopes
            SET status = 'EXPIRED',
                protected_payload = decode('', 'hex')
          WHERE tenant_id = $1
            AND envelope_id = $2
            AND recipient_device_id = $3
            AND status = 'PENDING'`,
        [input.tenantId, input.envelopeId, input.deviceId],
      );
      return "EXPIRED";
    }

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
      `SELECT inbox_epoch,
              next_offset,
              last_acked_offset
         FROM tenant_device_sync_states
        WHERE tenant_id = $1
          AND device_id = $2
        FOR UPDATE`,
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

export class PostgresOutboxRepository {
  constructor(private readonly transactions: SqlTransactionManager) {}

  withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async leaseNextJob(
    tx: SqlExecutor,
    input: {
      jobType: string;
      now: string;
      leaseUntil: string;
    },
  ): Promise<OutboxJobLease | undefined> {
    const result = await tx.query<{
      job_id: UUID;
      tenant_id: UUID;
      job_type: string;
      business_key: string;
      payload_ref: Record<string, unknown>;
      priority: number;
      fencing_token: number;
      attempt_count: number;
      lease_until: string;
    }>(
      `WITH candidate AS (
         SELECT job_id
           FROM outbox_jobs
          WHERE job_type = $1
            AND (
              (status = 'AVAILABLE' AND available_at <= $2)
              OR
              (status = 'LEASED' AND lease_until <= $2)
            )
          ORDER BY priority, available_at, created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE outbox_jobs j
          SET status = 'LEASED',
              lease_until = $3,
              fencing_token = j.fencing_token + 1,
              attempt_count = j.attempt_count + 1,
              completed_at = NULL
         FROM candidate
        WHERE j.job_id = candidate.job_id
      RETURNING j.job_id,
                j.tenant_id,
                j.job_type,
                j.business_key,
                j.payload_ref,
                j.priority,
                j.fencing_token,
                j.attempt_count,
                j.lease_until::text AS lease_until`,
      [input.jobType, input.now, input.leaseUntil],
    );
    const row = first(result);
    return row
      ? {
          jobId: row.job_id,
          tenantId: row.tenant_id,
          jobType: row.job_type,
          businessKey: row.business_key,
          payloadRef: row.payload_ref,
          priority: Number(row.priority),
          fencingToken: Number(row.fencing_token),
          attemptCount: Number(row.attempt_count),
          leaseUntil: row.lease_until,
        }
      : undefined;
  }

  async reactivateTranslationExecuteJob(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
      availableAt: string;
    },
  ): Promise<
    "REACTIVATED" | "ACTIVE" | "SUPERSEDED" | "NOT_FOUND"
  > {
    const lookup = await tx.query<{
      job_id: UUID;
      status:
        | "AVAILABLE"
        | "LEASED"
        | "DONE"
        | "DEAD"
        | "SUPERSEDED";
    }>(
      `SELECT job_id, status
         FROM outbox_jobs
        WHERE tenant_id = $1
          AND job_type = 'translation.execute'
          AND business_key = $2
        FOR UPDATE`,
      [input.tenantId, input.translationId],
    );
    const row = first(lookup);
    if (!row) return "NOT_FOUND";
    if (row.status === "AVAILABLE" || row.status === "LEASED") {
      return "ACTIVE";
    }
    if (row.status === "SUPERSEDED") {
      return "SUPERSEDED";
    }

    const updated = await tx.query(
      `UPDATE outbox_jobs
          SET status = 'AVAILABLE',
              available_at = $3,
              lease_until = NULL,
              attempt_count = 0,
              completed_at = NULL
        WHERE tenant_id = $1
          AND job_id = $2
          AND status IN ('DONE','DEAD')`,
      [input.tenantId, row.job_id, input.availableAt],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        "Invariant violation: terminal translation job was not reactivated",
      );
    }
    return "REACTIVATED";
  }

  async completeJob(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE outbox_jobs
          SET status = 'DONE',
              lease_until = NULL,
              completed_at = $4
        WHERE tenant_id = $1
          AND job_id = $2
          AND status = 'LEASED'
          AND fencing_token = $3
          AND lease_until > $4`,
      [
        input.tenantId,
        input.jobId,
        input.fencingToken,
        input.now,
      ],
    );
    return result.rowCount === 1;
  }

  async retryJob(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
      availableAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE outbox_jobs
          SET status = 'AVAILABLE',
              available_at = $5,
              lease_until = NULL,
              completed_at = NULL
        WHERE tenant_id = $1
          AND job_id = $2
          AND status = 'LEASED'
          AND fencing_token = $3
          AND lease_until > $4`,
      [
        input.tenantId,
        input.jobId,
        input.fencingToken,
        input.now,
        input.availableAt,
      ],
    );
    return result.rowCount === 1;
  }

  async deadLetterJob(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE outbox_jobs
          SET status = 'DEAD',
              lease_until = NULL,
              completed_at = $4
        WHERE tenant_id = $1
          AND job_id = $2
          AND status = 'LEASED'
          AND fencing_token = $3
          AND lease_until > $4`,
      [
        input.tenantId,
        input.jobId,
        input.fencingToken,
        input.now,
      ],
    );
    return result.rowCount === 1;
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


export { PostgresTranslationRepository } from "./translation.js";
