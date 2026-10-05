import type {
  PostgresMessagingRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresTranslationFeedbackRepository,
} from "../../persistence-postgres/src/translation-feedback.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import {
  TranslationFeedbackService,
  type TranslationFeedbackFingerprinter,
} from "../../translation-feedback-service/src/index.js";

export interface PostgresTranslationFeedbackServiceDependencies {
  messagingRepository: PostgresMessagingRepository;
  feedbackRepository: PostgresTranslationFeedbackRepository;
  ids: {
    next(prefix: string): string;
  };
  clock: {
    now(): string;
  };
  noteFingerprinter: TranslationFeedbackFingerprinter;
}

export function createPostgresTranslationFeedbackService(
  deps: PostgresTranslationFeedbackServiceDependencies,
): TranslationFeedbackService<SqlExecutor> {
  return new TranslationFeedbackService<SqlExecutor>({
    transactions: deps.feedbackRepository,
    commands: deps.messagingRepository,
    feedbacks: deps.feedbackRepository,
    ids: deps.ids,
    clock: deps.clock,
    noteFingerprinter: deps.noteFingerprinter,
  });
}
