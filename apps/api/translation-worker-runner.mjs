import { setTimeout as sleep } from "node:timers/promises";

function integer(
  value,
  fallback,
  name,
  { min = 0, max = 60_000 } = {},
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

export function translationWorkerRunnerConfigFromEnv(
  env = process.env,
) {
  const mode = env.TRANSLATION_WORKER_MODE || "embedded";
  if (mode === "external") {
    throw new TypeError(
      "TRANSLATION_WORKER_MODE=external is not supported: raw source is process-local transient state; use embedded until a reviewed cross-process transient source transport exists",
    );
  }
  if (mode !== "embedded") {
    throw new TypeError(
      "TRANSLATION_WORKER_MODE must be embedded",
    );
  }

  return {
    mode,
    maxDrainPerCycle: integer(
      env.TRANSLATION_WORKER_MAX_DRAIN_PER_CYCLE,
      8,
      "TRANSLATION_WORKER_MAX_DRAIN_PER_CYCLE",
      { min: 1, max: 1_000 },
    ),
    idlePollMs: integer(
      env.TRANSLATION_WORKER_IDLE_POLL_MS,
      250,
      "TRANSLATION_WORKER_IDLE_POLL_MS",
      { min: 10, max: 60_000 },
    ),
    busyYieldMs: integer(
      env.TRANSLATION_WORKER_BUSY_YIELD_MS,
      0,
      "TRANSLATION_WORKER_BUSY_YIELD_MS",
      { min: 0, max: 10_000 },
    ),
    errorBackoffMs: integer(
      env.TRANSLATION_WORKER_ERROR_BACKOFF_MS,
      1_000,
      "TRANSLATION_WORKER_ERROR_BACKOFF_MS",
      { min: 10, max: 60_000 },
    ),
  };
}

export function createTranslationWorkerRunner({
  worker,
  contextWorker = null,
  config = {},
  onError = null,
}) {
  if (
    !worker ||
    typeof worker.runFanoutOnce !== "function" ||
    typeof worker.runExecuteOnce !== "function"
  ) {
    throw new TypeError(
      "worker.runFanoutOnce and worker.runExecuteOnce are required",
    );
  }
  if (
    contextWorker !== null &&
    (!contextWorker ||
      typeof contextWorker.runOnce !== "function")
  ) {
    throw new TypeError(
      "contextWorker.runOnce is required when contextWorker is provided",
    );
  }

  const settings = {
    maxDrainPerCycle: integer(
      config.maxDrainPerCycle,
      8,
      "maxDrainPerCycle",
      { min: 1, max: 1_000 },
    ),
    idlePollMs: integer(
      config.idlePollMs,
      250,
      "idlePollMs",
      { min: 10, max: 60_000 },
    ),
    busyYieldMs: integer(
      config.busyYieldMs,
      0,
      "busyYieldMs",
      { min: 0, max: 10_000 },
    ),
    errorBackoffMs: integer(
      config.errorBackoffMs,
      1_000,
      "errorBackoffMs",
      { min: 10, max: 60_000 },
    ),
  };

  if (onError !== null && typeof onError !== "function") {
    throw new TypeError("onError must be a function when provided");
  }

  let controller = null;
  let loopPromise = null;
  let cyclePromise = null;
  let processedTotal = 0;
  let consecutiveErrors = 0;
  let lastCycleAt = null;
  let lastSuccessAt = null;
  let lastErrorAt = null;
  let lastErrorName = null;

  function timestamp() {
    return new Date().toISOString();
  }

  async function notifyError(error) {
    lastCycleAt = timestamp();
    lastErrorAt = lastCycleAt;
    lastErrorName =
      error instanceof Error
        ? error.name || "Error"
        : "UnknownError";
    consecutiveErrors += 1;

    if (onError) {
      try {
        await onError(error, status());
      } catch {
        // Observability must never break the worker loop.
      }
    }
  }

  function recordSuccess(cycle) {
    lastCycleAt = timestamp();
    lastSuccessAt = lastCycleAt;
    lastErrorName = null;
    consecutiveErrors = 0;
    processedTotal += cycle.processed;
  }

  function status() {
    return {
      running: Boolean(loopPromise),
      processedTotal,
      consecutiveErrors,
      lastCycleAt,
      lastSuccessAt,
      lastErrorAt,
      lastErrorName,
    };
  }

  async function runCycle() {
    if (cyclePromise) {
      return cyclePromise;
    }

    cyclePromise = (async () => {
      let processed = 0;
      let fanoutResult = "NO_WORK";
      let contextResult = "NO_WORK";
      let executeResult = "NO_WORK";

      for (
        let i = 0;
        i < settings.maxDrainPerCycle;
        i += 1
      ) {
        // Translation fanout snapshots context before the current message
        // operation is allowed to enter the durable ConversationState.
        fanoutResult = await worker.runFanoutOnce();
        contextResult = contextWorker
          ? await contextWorker.runOnce()
          : "NO_WORK";
        executeResult = await worker.runExecuteOnce();

        const fanoutWorked = fanoutResult !== "NO_WORK";
        const contextWorked = contextResult !== "NO_WORK";
        const executeWorked = executeResult !== "NO_WORK";

        processed +=
          Number(fanoutWorked) +
          Number(contextWorked) +
          Number(executeWorked);

        if (
          !fanoutWorked &&
          !contextWorked &&
          !executeWorked
        ) {
          break;
        }
      }

      return {
        processed,
        fanoutResult,
        ...(contextWorker ? { contextResult } : {}),
        executeResult,
      };
    })();

    try {
      const cycle = await cyclePromise;
      recordSuccess(cycle);
      return cycle;
    } catch (error) {
      await notifyError(error);
      throw error;
    } finally {
      cyclePromise = null;
    }
  }

  async function loop(signal) {
    while (!signal.aborted) {
      try {
        const cycle = await runCycle();
        const delay =
          cycle.processed > 0
            ? settings.busyYieldMs
            : settings.idlePollMs;

        await sleep(delay, undefined, { signal });
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") {
          break;
        }

        try {
          await sleep(
            settings.errorBackoffMs,
            undefined,
            { signal },
          );
        } catch (sleepError) {
          if (
            signal.aborted ||
            sleepError?.name === "AbortError"
          ) {
            break;
          }
          throw sleepError;
        }
      }
    }
  }

  return {
    async runOnce() {
      return runCycle();
    },

    start() {
      if (loopPromise) {
        return loopPromise;
      }

      controller = new AbortController();
      const signal = controller.signal;
      loopPromise = loop(signal).finally(() => {
        loopPromise = null;
        controller = null;
      });
      return loopPromise;
    },

    async stop() {
      if (!loopPromise) {
        return;
      }
      controller?.abort();
      await loopPromise;
    },

    status,

    get running() {
      return Boolean(loopPromise);
    },
  };
}
