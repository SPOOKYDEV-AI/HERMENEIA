import type { UUID } from "../../domain/src/index.js";
import type {
  ActiveEpisodeState,
} from "../../context-state/src/index.js";

export type EpisodeContinuityDecision =
  | "CONTINUE_ACTIVE"
  | "START_NEW"
  | "UNCERTAIN";

export interface EpisodeSourceEvidence {
  messageId: UUID;
  sourceRevision: number;
  text: string;
  languageTag: string | null;
  createdAt: string;
}

export interface EpisodeDerivationInput {
  operationId: UUID;
  current: EpisodeSourceEvidence;
  activeEpisode?: ActiveEpisodeState;
  priorSources: EpisodeSourceEvidence[];
}

export interface EpisodeDerivationResult {
  decision: EpisodeContinuityDecision;
  confidence: number;
  lexicalScore: number;
  temporalScore: number;
  languageScore: number;
  activeEpisode?: ActiveEpisodeState;
}

const MAX_EPISODE_REFS = 8;
const MAX_PRIOR_SOURCES = 8;

const STOPWORDS = new Set([
  "the","and","for","with","that","this","you","your","are","was","were",
  "les","des","une","un","dans","pour","avec","que","qui","sur","est","sont",
  "los","las","una","uno","para","con","que","por","del","está","esta",
  "os","as","uma","um","para","com","que","por","dos","das","está","esta",
]);

export function deriveActiveEpisode(
  input: EpisodeDerivationInput,
): EpisodeDerivationResult {
  validateSource(input.current, "current");
  if (input.priorSources.length > MAX_PRIOR_SOURCES) {
    throw new TypeError(
      `priorSources exceeds bounded size ${MAX_PRIOR_SOURCES}`,
    );
  }
  for (const [index, source] of input.priorSources.entries()) {
    validateSource(source, `priorSources[${index}]`);
  }

  if (!input.activeEpisode) {
    return {
      decision: "START_NEW",
      confidence: 1,
      lexicalScore: 0,
      temporalScore: 1,
      languageScore: 1,
      activeEpisode: newEpisode(
        input.operationId,
        input.current,
        1,
      ),
    };
  }

  const active = input.activeEpisode;
  const temporalScore = timeContinuityScore(
    active.lastActivityAt,
    input.current.createdAt,
  );
  const languageScore = languageContinuityScore(
    active.sourceLanguageTag,
    input.current.languageTag,
  );
  const lexicalScore = lexicalContinuityScore(
    input.current.text,
    input.priorSources.map((source) => source.text),
  );

  const confidence = clamp01(
    lexicalScore * 0.6 +
      temporalScore * 0.25 +
      languageScore * 0.15,
  );

  if (
    lexicalScore >= 0.35 ||
    (
      lexicalScore >= 0.16 &&
      confidence >= 0.46
    )
  ) {
    return {
      decision: "CONTINUE_ACTIVE",
      confidence,
      lexicalScore,
      temporalScore,
      languageScore,
      activeEpisode: continueEpisode(
        active,
        input.current,
        confidence,
      ),
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
      activeEpisode: newEpisode(
        input.operationId,
        input.current,
        clamp01(1 - confidence),
      ),
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

export function episodeSourceRef(
  source: Pick<
    EpisodeSourceEvidence,
    "messageId" | "sourceRevision"
  >,
): string {
  return `${source.messageId}:${source.sourceRevision}`;
}

export function parseEpisodeSourceRef(
  value: string,
): {
  messageId: UUID;
  sourceRevision: number;
} | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.lastIndexOf(":");
  if (separator < 1) return undefined;
  const messageId = value.slice(0, separator);
  const sourceRevision = Number(
    value.slice(separator + 1),
  );
  if (
    !messageId ||
    !Number.isInteger(sourceRevision) ||
    sourceRevision < 1
  ) {
    return undefined;
  }
  return {
    messageId,
    sourceRevision,
  };
}

function newEpisode(
  episodeId: UUID,
  source: EpisodeSourceEvidence,
  confidence: number,
): ActiveEpisodeState {
  return {
    episodeId,
    episodeVersion: 1,
    continuityConfidence: clamp01(confidence),
    continuityStrategy: "heuristic-v1",
    startedAt: source.createdAt,
    lastActivityAt: source.createdAt,
    sourceLanguageTag:
      normaliseLanguageTag(source.languageTag),
    sourceRevisionRefs: [
      episodeSourceRef(source),
    ],
  };
}

function continueEpisode(
  active: ActiveEpisodeState,
  source: EpisodeSourceEvidence,
  confidence: number,
): ActiveEpisodeState {
  const currentRef = episodeSourceRef(source);
  const refs = [
    ...active.sourceRevisionRefs.filter(
      (ref) => ref !== currentRef,
    ),
    currentRef,
  ].slice(-MAX_EPISODE_REFS);

  return {
    ...active,
    episodeVersion: active.episodeVersion + 1,
    continuityConfidence: clamp01(confidence),
    lastActivityAt: source.createdAt,
    sourceLanguageTag:
      normaliseLanguageTag(source.languageTag) ??
      active.sourceLanguageTag,
    sourceRevisionRefs: refs,
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

function validateSource(
  source: EpisodeSourceEvidence,
  label: string,
): void {
  if (
    typeof source.messageId !== "string" ||
    !source.messageId
  ) {
    throw new TypeError(
      `${label}.messageId is required`,
    );
  }
  if (
    !Number.isInteger(source.sourceRevision) ||
    source.sourceRevision < 1
  ) {
    throw new TypeError(
      `${label}.sourceRevision must be positive`,
    );
  }
  if (typeof source.text !== "string") {
    throw new TypeError(
      `${label}.text must be a string`,
    );
  }
  if (!Number.isFinite(Date.parse(source.createdAt))) {
    throw new TypeError(
      `${label}.createdAt must be a timestamp`,
    );
  }
}

function clamp01(value: number): number {
  return Math.max(
    0,
    Math.min(1, Number(value.toFixed(6))),
  );
}
