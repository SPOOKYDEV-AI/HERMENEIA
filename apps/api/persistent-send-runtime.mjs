import { randomUUID } from "node:crypto";

import {
  PostgresMessagingRepository,
  PostgresOutboxRepository,
  PostgresSessionRepository,
  PostgresTranslationRepository,
} from "../../.build/packages/persistence-postgres/src/index.js";
import {
  SqlTransactionManager,
} from "../../.build/packages/persistence/src/index.js";
import {
  createPostgresMessagingService,
} from "../../.build/packages/runtime/src/persistent-messaging.js";
import {
  createPostgresDeliveryService,
} from "../../.build/packages/runtime/src/persistent-delivery.js";
import {
  createPostgresOutboxService,
} from "../../.build/packages/runtime/src/persistent-outbox.js";
import {
  createPostgresTranslationExecutionService,
} from "../../.build/packages/runtime/src/persistent-translation.js";
import {
  createPostgresTranslationWorker,
} from "../../.build/packages/runtime/src/persistent-translation-worker.js";
import {
  createPostgresTranslationRecoveryService,
} from "../../.build/packages/runtime/src/persistent-translation-recovery.js";
import {
  InMemoryTransientSourceStore,
} from "../../.build/packages/transient-source/src/index.js";
import { createBearerAuthenticator } from "./session-auth.mjs";
import { sha256CredentialReference } from "./session-credential.mjs";
import {
  createHmacSourceFingerprinter,
} from "./source-fingerprint.mjs";
import {
  createNodePostgresPool,
  postgresPoolConfigFromEnv,
} from "./postgres-pool.mjs";

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function canonicalBase64(value) {
  return value.replace(/=+$/, "");
}

function decodeBase64Key(value, label) {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`${label} is required`);
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError(`${label} must be valid base64`);
  }

  const key = Buffer.from(value, "base64");
  if (
    canonicalBase64(key.toString("base64")) !== canonicalBase64(value)
  ) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  if (key.length < 32) {
    throw new TypeError(`${label} must decode to at least 32 bytes`);
  }
  return key;
}

function parseVerificationKeys(value) {
  if (!value) return [];

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(
      "SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON must be valid JSON",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError(
      "SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON must be an array",
    );
  }

  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError(
        `SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON[${index}] must be an object`,
      );
    }
    const keyVersion = candidate.key_version;
    if (typeof keyVersion !== "string" || !keyVersion) {
      throw new TypeError(
        `SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON[${index}].key_version is required`,
      );
    }
    return {
      keyVersion,
      key: decodeBase64Key(
        candidate.key_base64,
        `SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON[${index}].key_base64`,
      ),
    };
  });
}

export function persistentSendConfigFromEnv(env = process.env) {
  const postgres = postgresPoolConfigFromEnv(env);

  return {
    postgres,
    sourceFingerprint: {
      keyVersion: required(
        env,
        "SOURCE_FINGERPRINT_HMAC_KEY_VERSION",
      ),
      key: decodeBase64Key(
        required(env, "SOURCE_FINGERPRINT_HMAC_KEY_BASE64"),
        "SOURCE_FINGERPRINT_HMAC_KEY_BASE64",
      ),
      verificationKeys: parseVerificationKeys(
        env.SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON,
      ),
    },
    transientSource: {
      ttlSeconds: positiveInteger(
        env.TRANSIENT_SOURCE_TTL_SECONDS,
        300,
        "TRANSIENT_SOURCE_TTL_SECONDS",
      ),
      maxEntries: positiveInteger(
        env.TRANSIENT_SOURCE_MAX_ENTRIES,
        1_000,
        "TRANSIENT_SOURCE_MAX_ENTRIES",
      ),
      maxApproxBytes: positiveInteger(
        env.TRANSIENT_SOURCE_MAX_APPROX_BYTES,
        8 * 1024 * 1024,
        "TRANSIENT_SOURCE_MAX_APPROX_BYTES",
      ),
    },
    envelopeTtlSeconds: positiveInteger(
      env.DELIVERY_ENVELOPE_TTL_SECONDS,
      7 * 24 * 60 * 60,
      "DELIVERY_ENVELOPE_TTL_SECONDS",
    ),
    outboxLeaseSeconds: positiveInteger(
      env.OUTBOX_LEASE_SECONDS,
      30,
      "OUTBOX_LEASE_SECONDS",
    ),
    translation: {
      strategyVersion:
        env.TRANSLATION_STRATEGY_VERSION || "t0-v1",
      maxProviderAttempts: positiveInteger(
        env.TRANSLATION_MAX_PROVIDER_ATTEMPTS,
        3,
        "TRANSLATION_MAX_PROVIDER_ATTEMPTS",
      ),
      retryBaseSeconds: positiveInteger(
        env.TRANSLATION_RETRY_BASE_SECONDS,
        5,
        "TRANSLATION_RETRY_BASE_SECONDS",
      ),
    },
  };
}

export async function createPersistentSendRuntime({
  env = process.env,
  envelopeProtector,
  translationProvider = null,
  translationEnvelopeProtector = null,
  pgModule,
  clock = {
    now() {
      return new Date().toISOString();
    },
  },
  ids = {
    next() {
      return randomUUID();
    },
  },
} = {}) {
  if (
    !envelopeProtector ||
    typeof envelopeProtector.protect !== "function"
  ) {
    throw new TypeError(
      "A reviewed envelopeProtector.protect implementation is required",
    );
  }

  const hasTranslationProvider = Boolean(translationProvider);
  const hasTranslationProtector = Boolean(
    translationEnvelopeProtector &&
    typeof translationEnvelopeProtector.protect === "function",
  );
  if (hasTranslationProvider !== hasTranslationProtector) {
    throw new TypeError(
      "translationProvider and translationEnvelopeProtector must be configured together",
    );
  }

  const config = persistentSendConfigFromEnv(env);
  const fingerprinter = createHmacSourceFingerprinter({
    key: config.sourceFingerprint.key,
    keyVersion: config.sourceFingerprint.keyVersion,
    verificationKeys: config.sourceFingerprint.verificationKeys,
  });

  const sqlPool = await createNodePostgresPool({
    ...config.postgres,
    pgModule,
  });

  try {
    const transactions = new SqlTransactionManager(sqlPool);
    const repository = new PostgresMessagingRepository(transactions);
    const outboxRepository = new PostgresOutboxRepository(transactions);
    const sessionRepository = new PostgresSessionRepository(transactions);
    const translationRepository =
      new PostgresTranslationRepository(transactions);

    const transientSources = new InMemoryTransientSourceStore({
      clock,
      maxEntries: config.transientSource.maxEntries,
      maxApproxBytes: config.transientSource.maxApproxBytes,
    });

    const sendService = createPostgresMessagingService({
      repository,
      ids,
      clock,
      fingerprinter,
      envelopeProtector,
      transientSources,
      envelopeTtlSeconds: config.envelopeTtlSeconds,
      transientSourceTtlSeconds: config.transientSource.ttlSeconds,
    });

    const deliveryService = createPostgresDeliveryService({
      repository,
      clock,
    });

    const outboxService = createPostgresOutboxService({
      repository: outboxRepository,
      clock,
      leaseSeconds: config.outboxLeaseSeconds,
    });

    const translationService =
      createPostgresTranslationExecutionService({
        repository: translationRepository,
        ids,
        clock,
      });

    const translationRecoveryService =
      createPostgresTranslationRecoveryService({
        messagingRepository: repository,
        outboxRepository,
        translationRepository,
        transientSources,
        fingerprinter,
        clock,
        transientSourceTtlSeconds:
          config.transientSource.ttlSeconds,
      });

    const translationWorker = hasTranslationProvider
      ? createPostgresTranslationWorker({
          messagingRepository: repository,
          outboxRepository,
          translationRepository,
          outboxService,
          translationService,
          transientSources,
          provider: translationProvider,
          envelopeProtector: translationEnvelopeProtector,
          ids,
          clock,
          strategyVersion:
            config.translation.strategyVersion,
          envelopeTtlSeconds: config.envelopeTtlSeconds,
          maxProviderAttempts:
            config.translation.maxProviderAttempts,
          retryBaseSeconds:
            config.translation.retryBaseSeconds,
        })
      : null;

    const readinessService = {
      async check() {
        let connection;
        try {
          connection = await sqlPool.connect();
          const result = await connection.query(
            `SELECT
               to_regclass('public.message_metadata') IS NOT NULL
                 AS has_message_metadata,
               to_regclass('public.tenant_device_sync_states') IS NOT NULL
                 AS has_tenant_sync,
               to_regclass('public.translation_executions') IS NOT NULL
                 AS has_translation_executions,
               to_regclass('public.provider_executions') IS NOT NULL
                 AS has_provider_executions,
               EXISTS (
                 SELECT 1
                   FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND table_name = 'command_receipts'
                    AND column_name = 'command_fingerprint'
               ) AS has_command_fingerprint,
               EXISTS (
                 SELECT 1
                   FROM pg_constraint
                  WHERE conname =
                    'device_inbox_events_translation_source_required_check'
               ) AS has_source_required_constraint`,
          );

          const row = result.rows[0];
          return Boolean(
            result.rowCount === 1 &&
            row?.has_message_metadata &&
            row?.has_tenant_sync &&
            row?.has_translation_executions &&
            row?.has_provider_executions &&
            row?.has_command_fingerprint &&
            row?.has_source_required_constraint
          );
        } catch {
          return false;
        } finally {
          connection?.release();
        }
      },
    };

    const authenticate = createBearerAuthenticator({
      sessionRegistry: {
        authenticateCredential(reference) {
          return sessionRepository.findActiveActorByCredentialReference(
            reference,
            clock.now(),
          );
        },
      },
      credentialReference: sha256CredentialReference,
    });

    return {
      sendService,
      commandService: sendService,
      mutationService: sendService,
      deliveryService,
      outboxService,
      translationService,
      translationRecoveryService,
      translationWorker,
      readinessService,
      authenticate,
      repository,
      outboxRepository,
      translationRepository,
      sessionRepository,
      transientSources,
      sqlPool,
      async close() {
        await sqlPool.close();
      },
    };
  } catch (error) {
    await sqlPool.close();
    throw error;
  }
}
