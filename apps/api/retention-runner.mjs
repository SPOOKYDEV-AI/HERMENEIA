import { setTimeout as sleep } from "node:timers/promises";

function integer(
  value,
  fallback,
  name,
  { min = 1, max = 300_000 } = {},
) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

export function retentionRunnerConfigFromEnv(env = process.env) {
  return {
    intervalMs: integer(
      env.RETENTION_SWEEPER_INTERVAL_MS,
      30_000,
      "RETENTION_SWEEPER_INTERVAL_MS",
      { min: 1_000, max: 300_000 },
    ),
    errorBackoffMs: integer(
      env.RETENTION_SWEEPER_ERROR_BACKOFF_MS,
      5_000,
      "RETENTION_SWEEPER_ERROR_BACKOFF_MS",
      { min: 100, max: 300_000 },
    ),
  };
}

export function createRetentionRunner({
  service,
  config = {},
  onError = null,
}) {
  if (!service || typeof service.runOnce !== "function") {
    throw new TypeError("retention service.runOnce is required");
  }
  if (onError !== null && typeof onError !== "function") {
    throw new TypeError("onError must be a function when provided");
  }

  const settings = {
    intervalMs: integer(
      config.intervalMs,
      30_000,
      "intervalMs",
      { min: 1_000, max: 300_000 },
    ),
    errorBackoffMs: integer(
      config.errorBackoffMs,
      5_000,
      "errorBackoffMs",
      { min: 100, max: 300_000 },
    ),
  };

  let controller = null;
  let loopPromise = null;
  let cyclePromise = null;
  let cycles = 0;
  let purgedTransientSources = 0;
  let expiredDeliveryEnvelopes = 0;
  let consecutiveErrors = 0;
  let lastCycleAt = null;
  let lastSuccessAt = null;
  let lastErrorAt = null;
  let lastErrorName = null;

  function timestamp() {
    return new Date().toISOString();
  }

  function status() {
    return {
      running: Boolean(loopPromise),
      cycles,
      purgedTransientSources,
      expiredDeliveryEnvelopes,
      consecutiveErrors,
      lastCycleAt,
      lastSuccessAt,
      lastErrorAt,
      lastErrorName,
    };
  }

  async function runCycle() {
    if (cyclePromise) return cyclePromise;

    cyclePromise = (async () => {
      const result = await service.runOnce();
      const now = timestamp();
      cycles += 1;
      purgedTransientSources += result.purgedTransientSources;
      expiredDeliveryEnvelopes += result.expiredDeliveryEnvelopes;
      consecutiveErrors = 0;
      lastCycleAt = now;
      lastSuccessAt = now;
      lastErrorName = null;
      return result;
    })();

    try {
      return await cyclePromise;
    } catch (error) {
      const now = timestamp();
      consecutiveErrors += 1;
      lastCycleAt = now;
      lastErrorAt = now;
      lastErrorName =
        error instanceof Error
          ? error.name || "Error"
          : "UnknownError";

      if (onError) {
        try {
          await onError(error, status());
        } catch {
          // Observability must never break retention.
        }
      }
      throw error;
    } finally {
      cyclePromise = null;
    }
  }

  async function loop(signal) {
    while (!signal.aborted) {
      let delay = settings.intervalMs;
      try {
        await runCycle();
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") {
          break;
        }
        delay = settings.errorBackoffMs;
      }

      try {
        await sleep(delay, undefined, { signal });
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") {
          break;
        }
        throw error;
      }
    }
  }

  return {
    runOnce: runCycle,

    start() {
      if (loopPromise) return loopPromise;
      controller = new AbortController();
      const signal = controller.signal;
      loopPromise = loop(signal).finally(() => {
        loopPromise = null;
        controller = null;
      });
      return loopPromise;
    },

    async stop() {
      if (!loopPromise) return;
      controller?.abort();
      await loopPromise;
    },

    status,

    get running() {
      return Boolean(loopPromise);
    },
  };
}
