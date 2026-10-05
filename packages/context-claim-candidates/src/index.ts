import {
  arbitrateCandidateClaims,
  type ParsedCandidateClaim,
} from "./arbitration.js";
import type { UUID } from "../../domain/src/index.js";
import type {
  ContextCandidate,
  ConversationContextState,
  CorrectionTrigger,
} from "../../context-engine/src/index.js";

export type CandidateClaimAuthority =
  | "POLICY"
  | "APPROVED_GLOSSARY"
  | "EXPLICIT_PREFERENCE"
  | "CONFIRMED_CORRECTION";

export type CandidateClaimRetention =
  | "CORRECTIVE_DURABLE"
  | "POLICY_REFERENCE"
  | "PREFERENCE_REFERENCE";

export type CandidateClaimTrigger =
  | "EXPLICIT_UI_CORRECTION"
  | "EXPLICIT_TEXTUAL_CORRECTION"
  | "APPROVED_GLOSSARY_CHANGE"
  | "TENANT_POLICY_CHANGE"
  | "EXPLICIT_STYLE_PREFERENCE";

export interface CandidateClaimRecord {
  claimId: UUID;
  claimVersion: number;
  conversationId: UUID | null;
  subjectUserId: UUID | null;
  propositionRef: Record<string, unknown>;
  modality: "ASSERTION" | "CORRECTION";
  authorityClass: CandidateClaimAuthority;
  retentionClass: CandidateClaimRetention;
  sensitivityClass: "NORMAL" | "RESTRICTED";
  confidence: number | null;
  scopeKind: "TENANT" | "CONVERSATION";
  scopeConversationId: UUID | null;
  triggerKind: CandidateClaimTrigger | null;
  validFrom: string | null;
  validUntil: string | null;
  status: "ACTIVE";
}

export interface MaterializeReferencedClaimsInput {
  claims: CandidateClaimRecord[];
  referencedClaimIds: UUID[];
  conversationId: UUID;
  currentSourceAuthorUserId: UUID;
  recipientUserId: UUID;
  currentSourceLanguageTag: string | null;
  targetLanguageTag: string;
  state: ConversationContextState;
  now: string;
}

export type SupportedProposition =
  | {
      schemaVersion: 1;
      kind: "TERM_MEANING";
      surfaceForm: string;
      meaning: string;
      sourceLanguageTag: string | null;
      targetLanguageTag: string | null;
    }
  | {
      schemaVersion: 1;
      kind: "PREFERRED_RENDERING";
      sourceForm: string;
      targetForm: string;
      sourceLanguageTag: string | null;
      targetLanguageTag: string;
    }
  | {
      schemaVersion: 1;
      kind: "STYLE_PREFERENCE";
      preferredRegister:
        | "NEUTRAL"
        | "FORMAL"
        | "INFORMAL";
      sourceLanguageTag: null;
      targetLanguageTag: string | null;
    };

export function materializeReferencedClaimCandidates(
  input: MaterializeReferencedClaimsInput,
): ContextCandidate[] {
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("now must be a valid timestamp");
  }

  const referenced = new Set(input.referencedClaimIds);
  const seen = new Set<string>();
  const parsed: ParsedCandidateClaim[] = [];

  for (const claim of input.claims) {
    if (!referenced.has(claim.claimId)) continue;
    if (!isAdmissibleClaim(claim, input)) continue;

    const proposition = parseSupportedClaimProposition(
      claim.propositionRef,
    );
    if (!proposition) continue;

    if (
      proposition.sourceLanguageTag &&
      (
        !input.currentSourceLanguageTag ||
        normaliseLanguageTag(
          proposition.sourceLanguageTag,
        ) !==
          normaliseLanguageTag(
            input.currentSourceLanguageTag,
          )
      )
    ) {
      continue;
    }

    if (
      proposition.targetLanguageTag &&
      normaliseLanguageTag(proposition.targetLanguageTag) !==
        normaliseLanguageTag(input.targetLanguageTag)
    ) {
      continue;
    }

    const identity =
      `${claim.claimId}:${claim.claimVersion}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    parsed.push({
      claim,
      proposition,
    });
  }

  const candidates: ContextCandidate[] = [];

  for (
    const arbitrated of arbitrateCandidateClaims(
      parsed,
    )
  ) {
    const { claim, proposition } =
      arbitrated.primary;
    const candidateId =
      `claim:${claim.claimId}:${claim.claimVersion}`;

    const correctionTrigger =
      claim.authorityClass === "CONFIRMED_CORRECTION"
        ? toCorrectionTrigger(claim.triggerKind)
        : null;
    if (
      claim.authorityClass === "CONFIRMED_CORRECTION" &&
      !correctionTrigger
    ) {
      continue;
    }

    candidates.push({
      candidateId,
      candidateType:
        claim.authorityClass === "CONFIRMED_CORRECTION"
          ? "CORRECTION_MEMORY"
          : claim.authorityClass === "EXPLICIT_PREFERENCE"
            ? "EXPLICIT_PREFERENCE"
            : "APPROVED_POLICY",
      content: renderProposition(proposition),
      causalThroughOperationSequence:
        input.state.processedPrefixOperationSequence,
      sourceRevisionRefs: [],
      claimRefs:
        arbitrated.supportingClaimRefs,
      semanticScore: 1,
      temporalScore: 1,
      confidence: arbitrated.confidence,
      importance: 1,
      explicitReference: false,
      activeEpisode: false,
      privacyScope:
        claim.authorityClass === "CONFIRMED_CORRECTION"
          ? "CORRECTION"
          : claim.authorityClass === "EXPLICIT_PREFERENCE"
            ? "PREFERENCE"
            : "POLICY",
      erasureEpoch: input.state.erasureEpoch,
      validUntil: arbitrated.validUntil,
      correctionTrigger,
    });
  }

  return candidates.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
}

function isAdmissibleClaim(
  claim: CandidateClaimRecord,
  input: MaterializeReferencedClaimsInput,
): boolean {
  if (
    claim.status !== "ACTIVE" ||
    claim.sensitivityClass !== "NORMAL" ||
    !Number.isInteger(claim.claimVersion) ||
    claim.claimVersion < 1
  ) {
    return false;
  }

  const confidence = claim.confidence ?? 1;
  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return false;
  }

  if (
    claim.scopeKind === "CONVERSATION" &&
    claim.scopeConversationId !== input.conversationId
  ) {
    return false;
  }

  if (claim.subjectUserId !== null) {
    const expectedSubject =
      claim.authorityClass === "EXPLICIT_PREFERENCE"
        ? input.recipientUserId
        : input.currentSourceAuthorUserId;
    if (claim.subjectUserId !== expectedSubject) {
      return false;
    }
  }

  const now = Date.parse(input.now);
  if (
    claim.validFrom &&
    (!Number.isFinite(Date.parse(claim.validFrom)) ||
      Date.parse(claim.validFrom) >= now)
  ) {
    return false;
  }
  if (
    claim.validUntil &&
    (!Number.isFinite(Date.parse(claim.validUntil)) ||
      Date.parse(claim.validUntil) <= now)
  ) {
    return false;
  }

  if (claim.authorityClass === "CONFIRMED_CORRECTION") {
    return (
      claim.retentionClass === "CORRECTIVE_DURABLE" &&
      claim.modality === "CORRECTION" &&
      (claim.triggerKind === "EXPLICIT_UI_CORRECTION" ||
        claim.triggerKind === "EXPLICIT_TEXTUAL_CORRECTION")
    );
  }

  if (claim.authorityClass === "APPROVED_GLOSSARY") {
    return (
      claim.retentionClass === "POLICY_REFERENCE" &&
      claim.modality === "ASSERTION" &&
      claim.triggerKind === "APPROVED_GLOSSARY_CHANGE"
    );
  }

  if (claim.authorityClass === "EXPLICIT_PREFERENCE") {
    return (
      claim.retentionClass === "PREFERENCE_REFERENCE" &&
      claim.modality === "ASSERTION" &&
      claim.triggerKind === "EXPLICIT_STYLE_PREFERENCE" &&
      claim.subjectUserId !== null &&
      claim.scopeKind === "CONVERSATION" &&
      claim.scopeConversationId === input.conversationId
    );
  }

  return (
    claim.authorityClass === "POLICY" &&
    claim.retentionClass === "POLICY_REFERENCE" &&
    claim.modality === "ASSERTION" &&
    claim.triggerKind === "TENANT_POLICY_CHANGE"
  );
}

export function parseSupportedClaimProposition(
  value: Record<string, unknown>,
): SupportedProposition | null {
  if (!isPlainObject(value) || value.schema_version !== 1) {
    return null;
  }

  if (value.kind === "TERM_MEANING") {
    const surfaceForm = boundedString(
      value.surface_form,
      128,
    );
    const meaning = boundedString(value.meaning, 512);
    if (!surfaceForm || !meaning) return null;

    return {
      schemaVersion: 1,
      kind: "TERM_MEANING",
      surfaceForm,
      meaning,
      sourceLanguageTag: optionalLanguageTag(
        value.source_language_tag,
      ),
      targetLanguageTag: optionalLanguageTag(
        value.target_language_tag,
      ),
    };
  }

  if (value.kind === "STYLE_PREFERENCE") {
    const preferredRegister = String(
      value.preferred_register ?? "",
    );
    if (
      !["NEUTRAL", "FORMAL", "INFORMAL"].includes(
        preferredRegister,
      )
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      kind: "STYLE_PREFERENCE",
      preferredRegister:
        preferredRegister as
          | "NEUTRAL"
          | "FORMAL"
          | "INFORMAL",
      sourceLanguageTag: null,
      targetLanguageTag: optionalLanguageTag(
        value.target_language_tag,
      ),
    };
  }

  if (value.kind === "PREFERRED_RENDERING") {
    const sourceForm = boundedString(
      value.source_form,
      128,
    );
    const targetForm = boundedString(
      value.target_form,
      256,
    );
    const targetLanguageTag = requiredLanguageTag(
      value.target_language_tag,
    );
    if (!sourceForm || !targetForm || !targetLanguageTag) {
      return null;
    }

    return {
      schemaVersion: 1,
      kind: "PREFERRED_RENDERING",
      sourceForm,
      targetForm,
      sourceLanguageTag: optionalLanguageTag(
        value.source_language_tag,
      ),
      targetLanguageTag,
    };
  }

  return null;
}

export function storedClaimProposition(
  proposition: SupportedProposition,
): Record<string, unknown> {
  if (proposition.kind === "TERM_MEANING") {
    return {
      schema_version: 1,
      kind: proposition.kind,
      surface_form: proposition.surfaceForm,
      meaning: proposition.meaning,
      ...(proposition.sourceLanguageTag
        ? { source_language_tag: proposition.sourceLanguageTag }
        : {}),
      ...(proposition.targetLanguageTag
        ? { target_language_tag: proposition.targetLanguageTag }
        : {}),
    };
  }

  if (proposition.kind === "STYLE_PREFERENCE") {
    return {
      schema_version: 1,
      kind: proposition.kind,
      preferred_register:
        proposition.preferredRegister,
      ...(proposition.targetLanguageTag
        ? {
            target_language_tag:
              proposition.targetLanguageTag,
          }
        : {}),
    };
  }

  return {
    schema_version: 1,
    kind: proposition.kind,
    source_form: proposition.sourceForm,
    target_form: proposition.targetForm,
    ...(proposition.sourceLanguageTag
      ? { source_language_tag: proposition.sourceLanguageTag }
      : {}),
    target_language_tag: proposition.targetLanguageTag,
  };
}

function renderProposition(
  proposition: SupportedProposition,
): string {
  if (proposition.kind === "TERM_MEANING") {
    return JSON.stringify({
      kind: "trusted_term_meaning",
      surface_form: proposition.surfaceForm,
      meaning: proposition.meaning,
      ...(proposition.sourceLanguageTag
        ? {
            source_language_tag:
              proposition.sourceLanguageTag,
          }
        : {}),
      ...(proposition.targetLanguageTag
        ? {
            target_language_tag:
              proposition.targetLanguageTag,
          }
        : {}),
    });
  }

  if (proposition.kind === "STYLE_PREFERENCE") {
    return JSON.stringify({
      kind: "trusted_style_preference",
      preferred_register:
        proposition.preferredRegister,
      ...(proposition.targetLanguageTag
        ? {
            target_language_tag:
              proposition.targetLanguageTag,
          }
        : {}),
    });
  }

  return JSON.stringify({
    kind: "trusted_preferred_rendering",
    source_form: proposition.sourceForm,
    target_form: proposition.targetForm,
    ...(proposition.sourceLanguageTag
      ? {
          source_language_tag:
            proposition.sourceLanguageTag,
        }
      : {}),
    target_language_tag: proposition.targetLanguageTag,
  });
}

function toCorrectionTrigger(
  trigger: CandidateClaimTrigger | null,
): CorrectionTrigger | null {
  if (trigger === "EXPLICIT_UI_CORRECTION") {
    return "EXPLICIT_UI";
  }
  if (trigger === "EXPLICIT_TEXTUAL_CORRECTION") {
    return "EXPLICIT_REPAIR";
  }
  return null;
}

function boundedString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function optionalLanguageTag(
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredLanguageTag(value);
}

function requiredLanguageTag(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 35 ||
    !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function normaliseLanguageTag(value: string): string {
  return value.trim().toLowerCase();
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}
