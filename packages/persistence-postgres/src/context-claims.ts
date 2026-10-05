import type { UUID } from "../../domain/src/index.js";
import type {
  CandidateClaimRecord,
} from "../../context-claim-candidates/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

interface ContextClaimRow extends Record<string, unknown> {
  claim_id: UUID;
  claim_version: number;
  conversation_id: UUID | null;
  subject_user_id: UUID | null;
  proposition_ref: unknown;
  modality: "ASSERTION" | "CORRECTION";
  authority_class:
    | "POLICY"
    | "APPROVED_GLOSSARY"
    | "CONFIRMED_CORRECTION"
    | "EXPLICIT_PREFERENCE";
  retention_class:
    | "CORRECTIVE_DURABLE"
    | "POLICY_REFERENCE";
  sensitivity_class: "NORMAL" | "RESTRICTED";
  confidence: string | number | null;
  scope_kind: "TENANT" | "CONVERSATION";
  scope_conversation_id: UUID | null;
  trigger_kind:
    | "EXPLICIT_UI_CORRECTION"
    | "EXPLICIT_TEXTUAL_CORRECTION"
    | "APPROVED_GLOSSARY_CHANGE"
    | "TENANT_POLICY_CHANGE"
    | null;
  valid_from: string | null;
  valid_until: string | null;
  status: "ACTIVE";
}

export class PostgresContextClaimRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadTenantPolicyClaims(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      asOf: string;
    },
  ): Promise<CandidateClaimRecord[]> {
    if (!Number.isFinite(Date.parse(input.asOf))) {
      throw new TypeError("asOf must be a valid timestamp");
    }

    const result = await tx.query<ContextClaimRow>(
      `SELECT DISTINCT ON (claim_id)
              claim_id,
              claim_version,
              conversation_id,
              subject_user_id,
              proposition_ref,
              modality,
              authority_class,
              retention_class,
              sensitivity_class,
              confidence,
              scope_kind,
              scope_conversation_id,
              trigger_kind,
              valid_from::text AS valid_from,
              valid_until::text AS valid_until,
              status
         FROM context_claims
        WHERE tenant_id = $1
          AND conversation_id IS NULL
          AND subject_user_id IS NULL
          AND scope_kind = 'TENANT'
          AND scope_conversation_id IS NULL
          AND status = 'ACTIVE'
          AND sensitivity_class = 'NORMAL'
          AND retention_class = 'POLICY_REFERENCE'
          AND modality = 'ASSERTION'
          AND (valid_from IS NULL OR valid_from < $2)
          AND (valid_until IS NULL OR valid_until > $2)
          AND (
            (
              authority_class = 'APPROVED_GLOSSARY'
              AND trigger_kind = 'APPROVED_GLOSSARY_CHANGE'
            )
            OR (
              authority_class = 'POLICY'
              AND trigger_kind = 'TENANT_POLICY_CHANGE'
            )
          )
        ORDER BY claim_id, claim_version DESC
        LIMIT 129`,
      [
        input.tenantId,
        input.asOf,
      ],
    );

    if (result.rows.length > 128) {
      throw new Error(
        "Active tenant policy claim overlay exceeds bounded limit",
      );
    }

    return result.rows.map(mapClaimRow);
  }

  async loadReferencedClaims(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      claimIds: UUID[];
      asOf: string;
    },
  ): Promise<CandidateClaimRecord[]> {
    if (!Number.isFinite(Date.parse(input.asOf))) {
      throw new TypeError("asOf must be a valid timestamp");
    }

    const claimIds = [...new Set(input.claimIds)];
    if (claimIds.length === 0) return [];
    if (claimIds.length > 384) {
      throw new TypeError(
        "claimIds exceeds the bounded referenced-claim limit",
      );
    }
    if (claimIds.some((claimId) => !isUuid(claimId))) {
      throw new TypeError(
        "claimIds must contain canonical UUID values",
      );
    }

    const result = await tx.query<ContextClaimRow>(
      `SELECT DISTINCT ON (claim_id)
              claim_id,
              claim_version,
              conversation_id,
              subject_user_id,
              proposition_ref,
              modality,
              authority_class,
              retention_class,
              sensitivity_class,
              confidence,
              scope_kind,
              scope_conversation_id,
              trigger_kind,
              valid_from::text AS valid_from,
              valid_until::text AS valid_until,
              status
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id IN (
            SELECT value::uuid
              FROM jsonb_array_elements_text($2::jsonb)
          )
          AND status = 'ACTIVE'
          AND sensitivity_class = 'NORMAL'
          AND (
            scope_kind = 'TENANT'
            OR (
              scope_kind = 'CONVERSATION'
              AND scope_conversation_id = $3
            )
          )
          AND (valid_from IS NULL OR valid_from < $4)
          AND (valid_until IS NULL OR valid_until > $4)
          AND (
            (
              authority_class = 'CONFIRMED_CORRECTION'
              AND retention_class = 'CORRECTIVE_DURABLE'
              AND modality = 'CORRECTION'
              AND trigger_kind IN (
                'EXPLICIT_UI_CORRECTION',
                'EXPLICIT_TEXTUAL_CORRECTION'
              )
            )
            OR (
              authority_class = 'APPROVED_GLOSSARY'
              AND retention_class = 'POLICY_REFERENCE'
              AND modality = 'ASSERTION'
              AND trigger_kind = 'APPROVED_GLOSSARY_CHANGE'
            )
            OR (
              authority_class = 'POLICY'
              AND retention_class = 'POLICY_REFERENCE'
              AND modality = 'ASSERTION'
              AND trigger_kind = 'TENANT_POLICY_CHANGE'
            )
            OR (
              authority_class = 'EXPLICIT_PREFERENCE'
              AND retention_class = 'POLICY_REFERENCE'
              AND modality = 'ASSERTION'
              AND trigger_kind = 'EXPLICIT_UI_CORRECTION'
              AND subject_user_id IS NOT NULL
              AND scope_kind = 'CONVERSATION'
              AND scope_conversation_id = $3
            )
          )
        ORDER BY claim_id, claim_version DESC`,
      [
        input.tenantId,
        JSON.stringify(claimIds),
        input.conversationId,
        input.asOf,
      ],
    );

    return result.rows.map(mapClaimRow);
  }
}

function mapClaimRow(
  row: ContextClaimRow,
): CandidateClaimRecord {
  if (
    !row.proposition_ref ||
    typeof row.proposition_ref !== "object" ||
    Array.isArray(row.proposition_ref)
  ) {
    throw new Error(
      "Invalid context claim proposition_ref",
    );
  }

  const confidence =
    row.confidence === null
      ? null
      : Number(row.confidence);
  if (
    confidence !== null &&
    (!Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw new Error(
      "Invalid context claim confidence",
    );
  }

  return {
    claimId: row.claim_id,
    claimVersion: Number(row.claim_version),
    conversationId: row.conversation_id,
    subjectUserId: row.subject_user_id,
    propositionRef: structuredClone(
      row.proposition_ref as Record<string, unknown>,
    ),
    modality: row.modality,
    authorityClass: row.authority_class,
    retentionClass: row.retention_class,
    sensitivityClass: row.sensitivity_class,
    confidence,
    scopeKind: row.scope_kind,
    scopeConversationId: row.scope_conversation_id,
    triggerKind: row.trigger_kind,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
  };
}


function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
