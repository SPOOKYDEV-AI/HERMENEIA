import type { SqlExecutor } from "../../persistence/src/index.js";
import type { PostgresMessagingRepository } from "../../persistence-postgres/src/index.js";
import type { TransientSourceStore } from "../../transient-source/src/index.js";
import {
  PersistentMessagingService,
  type PersistentEnvelopeProtector,
  type PersistentMessagingClock,
  type PersistentMessagingIdFactory,
  type PersistentSourceFingerprinter,
  type PersistentContextOperationRecorder,
} from "../../messaging-service/src/index.js";

export interface PostgresMessagingApplicationDependencies {
  repository: PostgresMessagingRepository;
  ids: PersistentMessagingIdFactory;
  clock: PersistentMessagingClock;
  fingerprinter: PersistentSourceFingerprinter;
  envelopeProtector: PersistentEnvelopeProtector;
  transientSources?: TransientSourceStore;
  contextOperations?: PersistentContextOperationRecorder<SqlExecutor>;
  envelopeTtlSeconds?: number;
  transientSourceTtlSeconds?: number;
}

export function createPostgresMessagingService(
  deps: PostgresMessagingApplicationDependencies,
): PersistentMessagingService<SqlExecutor> {
  return new PersistentMessagingService<SqlExecutor>({
    store: deps.repository,
    ids: deps.ids,
    clock: deps.clock,
    fingerprinter: deps.fingerprinter,
    envelopeProtector: deps.envelopeProtector,
    transientSources: deps.transientSources,
    contextOperations: deps.contextOperations,
    envelopeTtlSeconds: deps.envelopeTtlSeconds,
    transientSourceTtlSeconds: deps.transientSourceTtlSeconds,
  });
}
