import type {
  PostgresMessagingRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresContextCorrectionRepository,
} from "../../persistence-postgres/src/context-corrections.js";
import type {
  PostgresConversationContextStateRepository,
} from "../../persistence-postgres/src/context-state.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import {
  ContextCorrectionService,
  type ContextCorrectionClock,
  type ContextCorrectionIds,
} from "../../context-correction-service/src/index.js";

export interface PostgresContextCorrectionServiceDependencies {
  messagingRepository: PostgresMessagingRepository;
  correctionRepository: PostgresContextCorrectionRepository;
  stateRepository: PostgresConversationContextStateRepository;
  ids: ContextCorrectionIds;
  clock: ContextCorrectionClock;
  strategyVersion?: string;
}

export function createPostgresContextCorrectionService(
  deps: PostgresContextCorrectionServiceDependencies,
): ContextCorrectionService<SqlExecutor> {
  return new ContextCorrectionService<SqlExecutor>({
    transactions: deps.correctionRepository,
    commands: deps.messagingRepository,
    corrections: deps.correctionRepository,
    state: deps.stateRepository,
    ids: deps.ids,
    clock: deps.clock,
    strategyVersion: deps.strategyVersion,
  });
}
