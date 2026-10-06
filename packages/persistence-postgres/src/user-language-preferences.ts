import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  UserLanguagePreferenceRecord,
} from "../../user-language-preference-service/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export class PostgresUserLanguagePreferenceRepository {
  constructor(
    private readonly transactions:
      SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(
      work,
    );
  }

  async lockActiveActor(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1
         FROM tenant_memberships tm
         JOIN devices d
           ON d.device_id = $3
          AND d.user_id = tm.user_id
          AND d.status = 'ACTIVE'
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND tm.status = 'ACTIVE'
        FOR UPDATE OF tm
        FOR SHARE OF d`,
      [
        actor.tenantId,
        actor.userId,
        actor.deviceId,
      ],
    );
    return result.rowCount === 1;
  }

  async loadForUpdate(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      userId: UUID;
    },
  ): Promise<UserLanguagePreferenceRecord | undefined> {
    const result = await tx.query<{
      tenant_id: UUID;
      user_id: UUID;
      target_language_tag: string;
      target_locale_override: string | null;
      preference_version: number;
      updated_at: string;
    }>(
      `SELECT tenant_id,
              user_id,
              target_language_tag,
              target_locale_override,
              preference_version,
              updated_at::text AS updated_at
         FROM user_language_preferences
        WHERE tenant_id = $1
          AND user_id = $2
        FOR UPDATE`,
      [input.tenantId, input.userId],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          userId: row.user_id,
          targetLanguageTag:
            row.target_language_tag,
          targetLocaleOverride:
            row.target_locale_override,
          preferenceVersion:
            Number(row.preference_version),
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async write(
    tx: SqlExecutor,
    input: UserLanguagePreferenceRecord,
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO user_language_preferences(
         tenant_id,
         user_id,
         target_language_tag,
         target_locale_override,
         preference_version,
         updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET
         target_language_tag = EXCLUDED.target_language_tag,
         target_locale_override = EXCLUDED.target_locale_override,
         preference_version = EXCLUDED.preference_version,
         updated_at = EXCLUDED.updated_at`,
      [
        input.tenantId,
        input.userId,
        input.targetLanguageTag,
        input.targetLocaleOverride,
        input.preferenceVersion,
        input.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Language preference row was not written",
      );
    }
  }

  async bumpActiveMembershipProfiles(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      userId: UUID;
    },
  ): Promise<number> {
    const result = await tx.query(
      `UPDATE conversation_members
          SET membership_version =
                membership_version + 1
        WHERE tenant_id = $1
          AND user_id = $2
          AND status = 'ACTIVE'`,
      [
        input.tenantId,
        input.userId,
      ],
    );
    return result.rowCount;
  }
}
