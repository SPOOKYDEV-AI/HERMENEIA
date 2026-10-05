import type {
  PersistentOutboxService,
} from "../../outbox-service/src/index.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import type {
  PostgresOutboxRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresConversationContextStateRepository,
} from "../../persistence-postgres/src/context-state.js";
import {
  ContextStateWorkerService,
  type ContextStateWorkerClock,
} from "../../context-state-worker/src/index.js";

export interface PostgresContextStateWorkerDependencies {
  stateRepository: PostgresConversationContextStateRepository;
  outboxRepository: PostgresOutboxRepository;
  outboxService: PersistentOutboxService<SqlExecutor>;
  clock: ContextStateWorkerClock;
  retryBaseSeconds?: number;
  maxAttempts?: number;
}

export function createPostgresContextStateWorker(
  deps: PostgresContextStateWorkerDependencies,
): ContextStateWorkerService<SqlExecutor> {
  const store = {
    withTransaction: <T>(
      work: (tx: SqlExecutor) => Promise<T>,
    ) => deps.stateRepository.withTransaction(work),

    loadState: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresConversationContextStateRepository["loadState"]
      >[1],
    ) => deps.stateRepository.loadState(tx, input),

    updateState: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresConversationContextStateRepository["updateState"]
      >[1],
    ) => deps.stateRepository.updateState(tx, input),

    completeJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["completeJob"]
      >[1],
    ) => deps.outboxRepository.completeJob(tx, input),
  };

  return new ContextStateWorkerService<SqlExecutor>({
    store,
    outbox: deps.outboxService,
    clock: deps.clock,
    retryBaseSeconds: deps.retryBaseSeconds,
    maxAttempts: deps.maxAttempts,
  });
}
