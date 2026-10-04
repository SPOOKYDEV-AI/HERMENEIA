import type { SqlExecutor } from "../../persistence/src/index.js";
import type {
  PostgresMessagingRepository,
  PostgresOutboxRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresTranslationRepository,
} from "../../persistence-postgres/src/translation.js";
import type {
  PersistentOutboxService,
} from "../../outbox-service/src/index.js";
import type {
  InMemoryTransientSourceStore,
} from "../../transient-source/src/index.js";
import type {
  TranslationExecutionService,
} from "../../translation-service/src/index.js";
import {
  TranslationWorkerService,
  type TranslationEnvelopeProtector,
  type TranslationWorkerClock,
  type TranslationWorkerContextBridge,
  type TranslationWorkerIds,
  type TranslationWorkerProvider,
} from "../../translation-worker/src/index.js";

export interface PostgresTranslationWorkerDependencies {
  messagingRepository: PostgresMessagingRepository;
  outboxRepository: PostgresOutboxRepository;
  translationRepository: PostgresTranslationRepository;
  outboxService: PersistentOutboxService<SqlExecutor>;
  translationService: TranslationExecutionService<SqlExecutor>;
  transientSources: InMemoryTransientSourceStore;
  provider: TranslationWorkerProvider;
  envelopeProtector: TranslationEnvelopeProtector;
  contextBridge?: TranslationWorkerContextBridge;
  ids: TranslationWorkerIds;
  clock: TranslationWorkerClock;
  strategyVersion?: string;
  envelopeTtlSeconds?: number;
  maxProviderAttempts?: number;
  retryBaseSeconds?: number;
}

export function createPostgresTranslationWorker(
  deps: PostgresTranslationWorkerDependencies,
): TranslationWorkerService<SqlExecutor> {
  const store = {
    withTransaction: <T>(
      work: (tx: SqlExecutor) => Promise<T>,
    ) => deps.translationRepository.withTransaction(work),

    loadFanoutPlan: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["loadFanoutPlan"]
      >[1],
    ) => deps.translationRepository.loadFanoutPlan(tx, input),

    insertOutboxJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresMessagingRepository["insertOutboxJob"]
      >[1],
    ) => deps.messagingRepository.insertOutboxJob(tx, input),

    lockTranslationExecution: (
      tx: SqlExecutor,
      tenantId: string,
      translationId: string,
    ) =>
      deps.translationRepository.lockTranslationExecution(
        tx,
        tenantId,
        translationId,
      ),

    lockCurrentTranslationForPublish: (
      tx: SqlExecutor,
      tenantId: string,
      translationId: string,
    ) =>
      deps.translationRepository.lockCurrentTranslationForPublish(
        tx,
        tenantId,
        translationId,
      ),

    listRecipientControlDevices: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["listRecipientControlDevices"]
      >[1],
    ) =>
      deps.translationRepository.listRecipientControlDevices(
        tx,
        input,
      ),

    listRecipientDevicesForPublish: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["listRecipientDevicesForPublish"]
      >[1],
    ) =>
      deps.translationRepository.listRecipientDevicesForPublish(
        tx,
        input,
      ),

    markSourceRequired: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["markSourceRequired"]
      >[1],
    ) => deps.translationRepository.markSourceRequired(tx, input),

    scheduleRetry: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["scheduleRetry"]
      >[1],
    ) => deps.translationRepository.scheduleRetry(tx, input),

    markFailed: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["markFailed"]
      >[1],
    ) => deps.translationRepository.markFailed(tx, input),

    markReady: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["markReady"]
      >[1],
    ) => deps.translationRepository.markReady(tx, input),

    markSuperseded: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresTranslationRepository["markSuperseded"]
      >[1],
    ) => deps.translationRepository.markSuperseded(tx, input),

    insertTranslationDeliveryEnvelope: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresMessagingRepository["insertTranslationDeliveryEnvelope"]
      >[1],
    ) =>
      deps.messagingRepository.insertTranslationDeliveryEnvelope(
        tx,
        input,
      ),

    allocateDeviceInboxOffset: (
      tx: SqlExecutor,
      tenantId: string,
      deviceId: string,
    ) =>
      deps.messagingRepository.allocateDeviceInboxOffset(
        tx,
        tenantId,
        deviceId,
      ),

    insertInboxEvent: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresMessagingRepository["insertInboxEvent"]
      >[1],
    ) => deps.messagingRepository.insertInboxEvent(tx, input),

    completeJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["completeJob"]
      >[1],
    ) => deps.outboxRepository.completeJob(tx, input),

    retryJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["retryJob"]
      >[1],
    ) => deps.outboxRepository.retryJob(tx, input),

    deadLetterJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["deadLetterJob"]
      >[1],
    ) => deps.outboxRepository.deadLetterJob(tx, input),
  };

  return new TranslationWorkerService<SqlExecutor>({
    store,
    outbox: deps.outboxService,
    executions: deps.translationService,
    transientSources: deps.transientSources,
    provider: deps.provider,
    envelopeProtector: deps.envelopeProtector,
    contextBridge: deps.contextBridge,
    ids: deps.ids,
    clock: deps.clock,
    strategyVersion: deps.strategyVersion,
    envelopeTtlSeconds: deps.envelopeTtlSeconds,
    maxProviderAttempts: deps.maxProviderAttempts,
    retryBaseSeconds: deps.retryBaseSeconds,
  });
}
