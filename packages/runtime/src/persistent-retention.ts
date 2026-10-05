import type { SqlExecutor } from "../../persistence/src/index.js";
import type { PostgresMessagingRepository } from "../../persistence-postgres/src/index.js";
import {
  PersistentRetentionService,
  type RetentionClock,
  type TransientRetentionStore,
} from "../../retention-service/src/index.js";

export interface PostgresRetentionDependencies {
  repository: PostgresMessagingRepository;
  transientSources: TransientRetentionStore;
  clock: RetentionClock;
  batchSize?: number;
}

export function createPostgresRetentionService(
  deps: PostgresRetentionDependencies,
): PersistentRetentionService<SqlExecutor> {
  return new PersistentRetentionService<SqlExecutor>(
    deps.repository,
    deps.transientSources,
    deps.clock,
    {
      batchSize: deps.batchSize,
    },
  );
}
