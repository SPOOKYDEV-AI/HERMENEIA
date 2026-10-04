import type { SqlExecutor } from "../../persistence/src/index.js";
import {
  TranslationExecutionService,
  type TranslationExecutionClock,
  type TranslationExecutionIdFactory,
} from "../../translation-service/src/index.js";
import type {
  PostgresTranslationRepository,
} from "../../persistence-postgres/src/translation.js";

export interface PostgresTranslationApplicationDependencies {
  repository: PostgresTranslationRepository;
  ids: TranslationExecutionIdFactory;
  clock: TranslationExecutionClock;
}

export function createPostgresTranslationExecutionService(
  deps: PostgresTranslationApplicationDependencies,
): TranslationExecutionService<SqlExecutor> {
  return new TranslationExecutionService<SqlExecutor>(
    deps.repository,
    deps.ids,
    deps.clock,
  );
}
