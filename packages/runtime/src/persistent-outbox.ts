import type { SqlExecutor } from "../../persistence/src/index.js";
import {
  PersistentOutboxService,
  type PersistentOutboxClock,
} from "../../outbox-service/src/index.js";
import type {
  PostgresOutboxRepository,
} from "../../persistence-postgres/src/index.js";

export interface PostgresOutboxApplicationDependencies {
  repository: PostgresOutboxRepository;
  clock: PersistentOutboxClock;
  leaseSeconds?: number;
}

export function createPostgresOutboxService(
  deps: PostgresOutboxApplicationDependencies,
): PersistentOutboxService<SqlExecutor> {
  return new PersistentOutboxService<SqlExecutor>(
    deps.repository,
    deps.clock,
    { leaseSeconds: deps.leaseSeconds },
  );
}
