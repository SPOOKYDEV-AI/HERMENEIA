export type EpisodeSemanticDecision =
  | "CONTINUE_ACTIVE"
  | "START_NEW"
  | "UNCERTAIN";

export interface EpisodeSemanticEvidence {
  text: string;
  languageTag: string | null;
  createdAt: string;
}

export interface EpisodeSemanticInput {
  current: EpisodeSemanticEvidence;
  priorSources: EpisodeSemanticEvidence[];
  previousLastActivityAt: string;
}

export interface EpisodeSemanticResult {
  decision: EpisodeSemanticDecision;
  confidence: number;
  lexicalScore: number;
  temporalScore: number;
  languageScore: number;
}

const MAX_PRIOR_SOURCES = 8;

const STOPWORDS = new Set([
  "the","and","for","with","that","this","you","your","are","was","were",
  "les","des","une","un","dans","pour","avec","que","qui","sur","est","sont",
  "los","las","una","uno","para","con","que","por","del","está","esta",
  "os","as","uma","um","para","com","que","por","dos","das","está","esta",
]);

/**
 * Bounded semantic enrichment for an already-active structural episode.
 *
 * Raw source text is input-only and never returned. Callers may therefore use
 * transient plaintext to make a continuity decision without persisting a
 * transcript, summary or source-reference list in ConversationState.
 */
export function deriveSemanticEpisodeContinuity(
  input: EpisodeSemanticInput,
): EpisodeSemanticResult {
  validateEvidence(input.current, "current");
  if (!Number.isFinite(Date.parse(input.previousLastActivityAt))) {
    throw new TypeError(
      "previousLastActivityAt must be a valid timestamp",
    );
  }
  if (
    !Array.isArray(input.priorSources) ||
    input.priorSources.length > MAX_PRIOR_SOURCES
  ) {
    throw new TypeError(
      `priorSources exceeds bounded size ${MAX_PRIOR_SOURCES}`,
    );
  }
  for (const [index, source] of input.priorSources.entries()) {
    validateEvidence(source, `priorSources[${index}]`);
  }

  if (input.priorSources.length === 0) {
    return {
      decision: "UNCERTAIN",
      confidence: 0,
      lexicalScore: 0,
      temporalScore: timeContinuityScore(
        input.previousLastActivityAt,
        input.current.createdAt,
      ),
      languageScore: 0.5,
    };
  }

  const lexicalScore = lexicalContinuityScore(
    input.current.text,
    input.priorSources.map((source) => source.text),
  );
  const temporalScore = timeContinuityScore(
    input.previousLastActivityAt,
    input.current.createdAt,
  );
  const priorLanguage =
    [...input.priorSources]
      .reverse()
      .find((source) => normaliseLanguageTag(source.languageTag))
      ?.languageTag ?? null;
  const languageScore = languageContinuityScore(
    priorLanguage,
    input.current.languageTag,
  );

  const confidence = clamp01(
    lexicalScore * 0.6 +
      temporalScore * 0.25 +
      languageScore * 0.15,
  );

  if (
    lexicalScore >= 0.35 ||
    (lexicalScore >= 0.16 && confidence >= 0.46)
  ) {
    return {
      decision: "CONTINUE_ACTIVE",
      confidence,
      lexicalScore,
      temporalScore,
      languageScore,
    };
  }

  if (
    lexicalScore <= 0.05 &&
    temporalScore <= 0.15
  ) {
    return {
      decision: "START_NEW",
      confidence: clamp01(1 - confidence),
      lexicalScore,
      temporalScore,
      languageScore,
    };
  }

  return {
    decision: "UNCERTAIN",
    confidence,
    lexicalScore,
    temporalScore,
    languageScore,
  };
}

function lexicalContinuityScore(
  currentText: string,
  priorTexts: string[],
): number {
  const current = tokenSet(currentText);
  if (current.size === 0) return 0;

  const prior = new Set<string>();
  for (const text of priorTexts) {
    for (const token of tokenSet(text)) {
      prior.add(token);
    }
  }
  if (prior.size === 0) return 0;

  let intersection = 0;
  for (const token of current) {
    if (prior.has(token)) intersection += 1;
  }
  const union =
    current.size + prior.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function tokenSet(text: string): Set<string> {
  const normalised = text
    .normalize("NFKC")
    .toLowerCase();

  const tokens =
    normalised.match(
      /[\p{L}\p{N}][\p{L}\p{N}'’-]{1,47}/gu,
    ) ?? [];

  return new Set(
    tokens
      .map((token) =>
        token.replace(/^['’-]+|['’-]+$/g, ""),
      )
      .filter(
        (token) =>
          token.length >= 3 &&
          !STOPWORDS.has(token),
      )
      .slice(0, 64),
  );
}

function timeContinuityScore(
  previousAt: string,
  currentAt: string,
): number {
  const previous = Date.parse(previousAt);
  const current = Date.parse(currentAt);
  if (
    !Number.isFinite(previous) ||
    !Number.isFinite(current) ||
    current < previous
  ) {
    return 0;
  }

  const minutes = (current - previous) / 60_000;
  if (minutes <= 5) return 1;
  if (minutes <= 30) return 0.8;
  if (minutes <= 240) return 0.45;
  if (minutes <= 1_440) return 0.15;
  return 0;
}

function languageContinuityScore(
  previous: string | null,
  current: string | null,
): number {
  const left = normaliseLanguageTag(previous);
  const right = normaliseLanguageTag(current);
  if (!left || !right) return 0.5;
  return left === right ? 1 : 0;
}

function normaliseLanguageTag(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function validateEvidence(
  source: EpisodeSemanticEvidence,
  label: string,
): void {
  if (
    typeof source.text !== "string" ||
    source.text.length > 8_192
  ) {
    throw new TypeError(
      `${label}.text must be a bounded string`,
    );
  }
  if (!Number.isFinite(Date.parse(source.createdAt))) {
    throw new TypeError(
      `${label}.createdAt must be a timestamp`,
    );
  }
  if (
    source.languageTag !== null &&
    typeof source.languageTag !== "string"
  ) {
    throw new TypeError(
      `${label}.languageTag must be a string or null`,
    );
  }
}

function clamp01(value: number): number {
  return Math.max(
    0,
    Math.min(1, Number(value.toFixed(6))),
  );
}
