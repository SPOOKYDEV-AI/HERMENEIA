import type { SqlExecutor } from "../../persistence/src/index.js";
import type { PostgresMessagingRepository } from "../../persistence-postgres/src/index.js";
import {
  PersistentDeliveryService,
  type PersistentDeliveryClock,
} from "../../delivery-service/src/index.js";

export interface PostgresDeliveryApplicationDependencies {
  repository: PostgresMessagingRepository;
  clock: PersistentDeliveryClock;
}

export function createPostgresDeliveryService(
  deps: PostgresDeliveryApplicationDependencies,
): PersistentDeliveryService<SqlExecutor> {
  return new PersistentDeliveryService<SqlExecutor>(
    deps.repository,
    deps.clock,
  );
}
