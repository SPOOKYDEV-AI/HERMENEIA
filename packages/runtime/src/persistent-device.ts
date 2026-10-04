import type { SqlExecutor } from "../../persistence/src/index.js";
import type { PostgresMessagingRepository } from "../../persistence-postgres/src/index.js";
import {
  PersistentDeviceService,
  type DeviceClock,
  type DeviceMaterialFingerprinter,
} from "../../device-service/src/index.js";

export interface PostgresDeviceApplicationDependencies {
  repository: PostgresMessagingRepository;
  clock: DeviceClock;
  materialFingerprinter: DeviceMaterialFingerprinter;
}

export function createPostgresDeviceService(
  deps: PostgresDeviceApplicationDependencies,
): PersistentDeviceService<SqlExecutor> {
  return new PersistentDeviceService<SqlExecutor>({
    store: deps.repository,
    clock: deps.clock,
    materialFingerprinter: deps.materialFingerprinter,
  });
}
