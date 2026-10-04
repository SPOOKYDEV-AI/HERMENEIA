import type { SqlExecutor } from "../../persistence/src/index.js";
import type {
  PostgresMessagingRepository,
  PostgresOutboxRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresTranslationRepository,
} from "../../persistence-postgres/src/translation.js";
import {
  TranslationRecoveryService,
  type TranslationRecoveryClock,
  type TranslationRecoveryFingerprinter,
} from "../../translation-service/src/index.js";
import type {
  TransientSourceStore,
} from "../../transient-source/src/index.js";

export interface PostgresTranslationRecoveryDependencies {
  messagingRepository: PostgresMessagingRepository;
  outboxRepository: PostgresOutboxRepository;
  translationRepository: PostgresTranslationRepository;
  transientSources: TransientSourceStore;
  fingerprinter: TranslationRecoveryFingerprinter;
  clock: TranslationRecoveryClock;
  transientSourceTtlSeconds?: number;
}

export function createPostgresTranslationRecoveryService(
  deps: PostgresTranslationRecoveryDependencies,
): TranslationRecoveryService<SqlExecutor> {
  const store = {
    withTransaction: <T>(
      work: (tx: SqlExecutor) => Promise<T>,
    ) => deps.translationRepository.withTransaction(work),

    claimCommand: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresMessagingRepository["claimCommand"]
      >[1],
    ) => deps.messagingRepository.claimCommand(tx, input),

    markCommandSucceeded: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresMessagingRepository["markCommandSucceeded"]
      >[1],
    ) => deps.messagingRepository.markCommandSucceeded(tx, input),

    lockTranslationForRecovery: (
      tx: SqlExecutor,
      actor: Parameters<
        PostgresTranslationRepository["lockTranslationForRecovery"]
      >[1],
      translationId: string,
    ) =>
      deps.translationRepository.lockTranslationForRecovery(
        tx,
        actor,
        translationId,
      ),

    resumeSourceRequired: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["resumeSourceRequired"]
      >[1],
    ) => deps.translationRepository.resumeSourceRequired(tx, input),

    resumeFailed: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["resumeFailed"]
      >[1],
    ) => deps.translationRepository.resumeFailed(tx, input),

    markSuperseded: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["markSuperseded"]
      >[1],
    ) => deps.translationRepository.markSuperseded(tx, input),

    reactivateTranslationExecuteJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["reactivateTranslationExecuteJob"]
      >[1],
    ) =>
      deps.outboxRepository.reactivateTranslationExecuteJob(
        tx,
        input,
      ),
  };

  return new TranslationRecoveryService<SqlExecutor>({
    store,
    transientSources: deps.transientSources,
    fingerprinter: deps.fingerprinter,
    clock: deps.clock,
    transientSourceTtlSeconds: deps.transientSourceTtlSeconds,
  });
}
