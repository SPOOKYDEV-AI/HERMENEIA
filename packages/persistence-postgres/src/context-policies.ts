import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export class PostgresTenantContextPolicyRepository {
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

  async lockTenantAuthority(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<{
    tenantRole: "MEMBER" | "ADMIN" | "OWNER";
    tenantPolicyVersion: number;
  } | undefined> {
    const result = await tx.query<{
      tenant_role:
        | "MEMBER"
        | "ADMIN"
        | "OWNER";
      policy_version: number;
    }>(
      `SELECT tm.role AS tenant_role,
              t.policy_version
         FROM tenants t
         JOIN tenant_memberships tm
           ON tm.tenant_id = t.tenant_id
          AND tm.user_id = $2
          AND tm.status = 'ACTIVE'
         JOIN devices d
           ON d.device_id = $3
          AND d.user_id = tm.user_id
          AND d.status = 'ACTIVE'
        WHERE t.tenant_id = $1
          AND t.status = 'ACTIVE'
        FOR UPDATE OF t`,
      [
        actor.tenantId,
        actor.userId,
        actor.deviceId,
      ],
    );

    const row = result.rows[0];
    return row
      ? {
          tenantRole: row.tenant_role,
          tenantPolicyVersion: Number(
            row.policy_version,
          ),
        }
      : undefined;
  }

  async invalidateSupersededTenantClaims(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      authorityClass:
        | "APPROVED_GLOSSARY"
        | "POLICY";
      propositionRef: Record<
        string,
        unknown
      >;
      invalidatedAt: string;
    },
  ): Promise<Array<{
    claimId: UUID;
    claimVersion: number;
  }>> {
    const result = await tx.query<{
      claim_id: UUID;
      claim_version: number;
    }>(
      `UPDATE context_claims
          SET status = 'INVALIDATED',
              valid_until = CASE
                WHEN valid_from IS NULL
                  OR valid_from < $4
                THEN $4
                ELSE valid_from
                  + interval '1 microsecond'
              END
        WHERE tenant_id = $1
          AND conversation_id IS NULL
          AND message_id IS NULL
          AND subject_user_id IS NULL
          AND scope_kind = 'TENANT'
          AND scope_conversation_id IS NULL
          AND status = 'ACTIVE'
          AND authority_class = $2
          AND retention_class = 'POLICY_REFERENCE'
          AND modality = 'ASSERTION'
          AND (
            (
              ($3::jsonb ->> 'kind')
                = 'TERM_MEANING'
              AND proposition_ref ->> 'kind'
                = 'TERM_MEANING'
              AND proposition_ref
                    ->> 'surface_form'
                  =
                  ($3::jsonb
                    ->> 'surface_form')
              AND COALESCE(
                    proposition_ref
                      ->> 'source_language_tag',
                    ''
                  )
                  =
                  COALESCE(
                    $3::jsonb
                      ->> 'source_language_tag',
                    ''
                  )
              AND COALESCE(
                    proposition_ref
                      ->> 'target_language_tag',
                    ''
                  )
                  =
                  COALESCE(
                    $3::jsonb
                      ->> 'target_language_tag',
                    ''
                  )
            )
            OR
            (
              ($3::jsonb ->> 'kind')
                = 'PREFERRED_RENDERING'
              AND proposition_ref ->> 'kind'
                = 'PREFERRED_RENDERING'
              AND proposition_ref
                    ->> 'source_form'
                  =
                  ($3::jsonb
                    ->> 'source_form')
              AND COALESCE(
                    proposition_ref
                      ->> 'source_language_tag',
                    ''
                  )
                  =
                  COALESCE(
                    $3::jsonb
                      ->> 'source_language_tag',
                    ''
                  )
              AND proposition_ref
                    ->> 'target_language_tag'
                  =
                  ($3::jsonb
                    ->> 'target_language_tag')
            )
          )
      RETURNING claim_id, claim_version`,
      [
        input.tenantId,
        input.authorityClass,
        JSON.stringify(
          input.propositionRef,
        ),
        input.invalidatedAt,
      ],
    );

    return result.rows.map((row) => ({
      claimId: row.claim_id,
      claimVersion: Number(
        row.claim_version,
      ),
    }));
  }

  async insertTenantPolicyClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      claimId: UUID;
      claimType:
        | "TERMINOLOGY"
        | "LEXICAL_PREFERENCE";
      propositionRef: Record<
        string,
        unknown
      >;
      authorityClass:
        | "APPROVED_GLOSSARY"
        | "POLICY";
      triggerKind:
        | "APPROVED_GLOSSARY_CHANGE"
        | "TENANT_POLICY_CHANGE";
      createdAt: string;
    },
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO context_claims(
         tenant_id,
         claim_id,
         claim_version,
         conversation_id,
         message_id,
         subject_user_id,
         claim_type,
         proposition_ref,
         modality,
         authority_class,
         retention_class,
         sensitivity_class,
         confidence,
         scope_kind,
         scope_conversation_id,
         trigger_kind,
         valid_from,
         valid_until,
         status,
         created_at
       ) VALUES (
         $1,$2,1,NULL,NULL,NULL,$3,
         $4::jsonb,'ASSERTION',$5,
         'POLICY_REFERENCE','NORMAL',1,
         'TENANT',NULL,$6,
         $7,NULL,'ACTIVE',$7
       )`,
      [
        input.tenantId,
        input.claimId,
        input.claimType,
        JSON.stringify(
          input.propositionRef,
        ),
        input.authorityClass,
        input.triggerKind,
        input.createdAt,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        "Tenant context policy claim was not inserted",
      );
    }
  }

  async insertOverrideProvenance(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      overriddenClaimId: UUID;
      overriddenClaimVersion: number;
      replacementClaimId: UUID;
      replacementClaimVersion: number;
      strategyVersion: string;
      createdAt: string;
    },
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO provenance_edges(
         tenant_id,
         provenance_edge_id,
         derived_claim_id,
         derived_claim_version,
         relation,
         source_claim_id,
         source_claim_version,
         strategy_version,
         created_at
       ) VALUES (
         $1,$2,$3,$4,'OVERRIDDEN_BY',
         $5,$6,$7,$8
       )`,
      [
        input.tenantId,
        input.provenanceEdgeId,
        input.overriddenClaimId,
        input.overriddenClaimVersion,
        input.replacementClaimId,
        input.replacementClaimVersion,
        input.strategyVersion,
        input.createdAt,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        "Tenant context policy override provenance was not inserted",
      );
    }
  }

  async bumpTenantPolicyVersion(
    tx: SqlExecutor,
    tenantId: UUID,
  ): Promise<number> {
    const result = await tx.query<{
      policy_version: number;
    }>(
      `UPDATE tenants
          SET policy_version =
                policy_version + 1
        WHERE tenant_id = $1
          AND status = 'ACTIVE'
      RETURNING policy_version`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row || result.rowCount !== 1) {
      throw new Error(
        "Tenant policy version was not advanced",
      );
    }
    return Number(row.policy_version);
  }

  async loadRevocableTenantClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      claimId: UUID;
    },
  ): Promise<{
    claimId: UUID;
    claimVersion: number;
    authorityClass:
      | "APPROVED_GLOSSARY"
      | "POLICY";
  } | undefined> {
    const result = await tx.query<{
      claim_id: UUID;
      claim_version: number;
      authority_class:
        | "APPROVED_GLOSSARY"
        | "POLICY";
    }>(
      `SELECT claim_id,
              claim_version,
              authority_class
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND conversation_id IS NULL
          AND message_id IS NULL
          AND subject_user_id IS NULL
          AND scope_kind = 'TENANT'
          AND scope_conversation_id IS NULL
          AND status = 'ACTIVE'
          AND authority_class IN (
            'APPROVED_GLOSSARY',
            'POLICY'
          )
          AND retention_class =
                'POLICY_REFERENCE'
          AND modality = 'ASSERTION'
        ORDER BY claim_version DESC
        LIMIT 1
        FOR UPDATE`,
      [
        input.tenantId,
        input.claimId,
      ],
    );

    const row = result.rows[0];
    return row
      ? {
          claimId: row.claim_id,
          claimVersion: Number(
            row.claim_version,
          ),
          authorityClass:
            row.authority_class,
        }
      : undefined;
  }

  async revokeTenantClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      claimId: UUID;
      claimVersion: number;
      revokedAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE context_claims
          SET status = 'REVOKED',
              valid_until = CASE
                WHEN valid_from IS NULL
                  OR valid_from < $4
                THEN $4
                ELSE valid_from
                  + interval '1 microsecond'
              END
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = $3
          AND conversation_id IS NULL
          AND message_id IS NULL
          AND subject_user_id IS NULL
          AND scope_kind = 'TENANT'
          AND scope_conversation_id IS NULL
          AND status = 'ACTIVE'
          AND authority_class IN (
            'APPROVED_GLOSSARY',
            'POLICY'
          )
          AND retention_class =
                'POLICY_REFERENCE'
          AND modality = 'ASSERTION'`,
      [
        input.tenantId,
        input.claimId,
        input.claimVersion,
        input.revokedAt,
      ],
    );
    return result.rowCount === 1;
  }
}
