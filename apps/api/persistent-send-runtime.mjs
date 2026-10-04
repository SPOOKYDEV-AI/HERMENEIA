import { randomUUID } from "node:crypto";

import {
  PersistentDeliveryService,
} from "../../.build/packages/delivery-service/src/index.js";
import {
  PostgresMessagingRepository,
  PostgresSessionRepository,
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
  };
}

export async function createPersistentSendRuntime({
  env = process.env,
  envelopeProtector,
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
    const sessionRepository = new PostgresSessionRepository(transactions);

    const transientSources = new InMemoryTransientSourceStore({
      clock,
      maxEntries: config.transientSource.maxEntries,
      maxApproxBytes: config.transientSource.maxApproxBytes,
    });

    const deliveryService = new PersistentDeliveryService(
      repository,
      clock,
    );

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
      deliveryService,
      authenticate,
      repository,
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
