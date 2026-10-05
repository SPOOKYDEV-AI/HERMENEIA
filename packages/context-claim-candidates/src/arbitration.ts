import type {
  CandidateClaimRecord,
  SupportedProposition,
} from "./index.js";

export interface ParsedCandidateClaim {
  claim: CandidateClaimRecord;
  proposition: SupportedProposition;
}

export interface ArbitratedCandidateClaim {
  primary: ParsedCandidateClaim;
  supportingClaimRefs: string[];
  confidence: number;
  validUntil: string | null;
}

/**
 * Resolves already-admissible structured claims before ContextCandidates are
 * created. This is intentionally not a global numeric authority ranking.
 *
 * Resolution order for one semantic key:
 * 1. approved control-plane evidence (POLICY / APPROVED_GLOSSARY), if present;
 * 2. otherwise speaker-scoped confirmed correction;
 * 3. otherwise generic confirmed correction.
 *
 * If the applicable level contains contradictory values, the semantic key is
 * dropped completely. The provider must never be asked to choose between two
 * contradictory authoritative values.
 */
export function arbitrateCandidateClaims(
  values: ParsedCandidateClaim[],
): ArbitratedCandidateClaim[] {
  const groups = new Map<
    string,
    ParsedCandidateClaim[]
  >();

  for (const value of values) {
    const key = semanticKey(value.proposition);
    const group = groups.get(key);
    if (group) {
      group.push(value);
    } else {
      groups.set(key, [value]);
    }
  }

  const resolved: ArbitratedCandidateClaim[] = [];

  for (const group of groups.values()) {
    const controlPlane = group.filter(
      ({ claim }) =>
        claim.authorityClass === "POLICY" ||
        claim.authorityClass ===
          "APPROVED_GLOSSARY",
    );

    if (controlPlane.length > 0) {
      const winner = resolveConsensus(controlPlane);
      if (winner) resolved.push(winner);
      continue;
    }

    const speakerScoped = group.filter(
      ({ claim }) =>
        claim.authorityClass ===
          "CONFIRMED_CORRECTION" &&
        claim.subjectUserId !== null,
    );

    if (speakerScoped.length > 0) {
      const winner =
        resolveConsensus(speakerScoped);
      if (winner) resolved.push(winner);
      continue;
    }

    const genericCorrections = group.filter(
      ({ claim }) =>
        claim.authorityClass ===
          "CONFIRMED_CORRECTION" &&
        claim.subjectUserId === null,
    );

    const winner =
      resolveConsensus(genericCorrections);
    if (winner) resolved.push(winner);
  }

  return resolved.sort((left, right) =>
    candidateIdentity(left.primary).localeCompare(
      candidateIdentity(right.primary),
    ),
  );
}

function resolveConsensus(
  values: ParsedCandidateClaim[],
): ArbitratedCandidateClaim | null {
  if (values.length === 0) return null;

  const ordered = [...values].sort(
    (left, right) =>
      candidateIdentity(left).localeCompare(
        candidateIdentity(right),
      ),
  );

  const expected =
    propositionValueKey(
      ordered[0].proposition,
    );

  if (
    ordered.some(
      ({ proposition }) =>
        propositionValueKey(proposition) !==
        expected,
    )
  ) {
    return null;
  }

  return {
    primary: ordered[0],
    supportingClaimRefs: ordered.map(
      ({ claim }) =>
        `${claim.claimId}:${claim.claimVersion}`,
    ),
    confidence: Math.min(
      ...ordered.map(
        ({ claim }) =>
          claim.confidence ?? 1,
      ),
    ),
    validUntil:
      earliestFiniteValidity(
        ordered.map(
          ({ claim }) => claim.validUntil,
        ),
      ),
  };
}

function semanticKey(
  proposition: SupportedProposition,
): string {
  if (proposition.kind === "TERM_MEANING") {
    return JSON.stringify([
      proposition.kind,
      proposition.surfaceForm,
      normaliseLanguageTag(
        proposition.sourceLanguageTag,
      ),
      normaliseLanguageTag(
        proposition.targetLanguageTag,
      ),
    ]);
  }

  return JSON.stringify([
    proposition.kind,
    proposition.sourceForm,
    normaliseLanguageTag(
      proposition.sourceLanguageTag,
    ),
    normaliseLanguageTag(
      proposition.targetLanguageTag,
    ),
  ]);
}

function propositionValueKey(
  proposition: SupportedProposition,
): string {
  if (proposition.kind === "TERM_MEANING") {
    return JSON.stringify([
      semanticKey(proposition),
      proposition.meaning,
    ]);
  }

  return JSON.stringify([
    semanticKey(proposition),
    proposition.targetForm,
  ]);
}

function candidateIdentity(
  value: ParsedCandidateClaim,
): string {
  return (
    `${value.claim.claimId}:` +
    `${value.claim.claimVersion}`
  );
}

function earliestFiniteValidity(
  values: Array<string | null>,
): string | null {
  const finite = values
    .filter(
      (value): value is string =>
        value !== null,
    )
    .sort(
      (left, right) =>
        Date.parse(left) -
        Date.parse(right),
    );

  return finite[0] ?? null;
}

function normaliseLanguageTag(
  value: string | null,
): string {
  return value?.trim().toLowerCase() ?? "";
}
