import { createHermeneiaHttpServer } from "./server.mjs";
import {
  createPersistentSendRuntime,
} from "./persistent-send-runtime.mjs";
import {
  createTranslationWorkerRunner,
  translationWorkerRunnerConfigFromEnv,
} from "./translation-worker-runner.mjs";

function closeHttpServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function createPersistentHermeneiaHttpRuntime(options = {}) {
  const runtime = await createPersistentSendRuntime(options);
  const workerConfig = translationWorkerRunnerConfigFromEnv(
    options.env ?? process.env,
  );
  const translationWorkerRunner = runtime.translationWorker
    ? createTranslationWorkerRunner({
        worker: runtime.translationWorker,
        contextWorker: runtime.contextStateWorker,
        config: workerConfig,
      })
    : null;

  try {
    const server = createHermeneiaHttpServer({
      authenticate: runtime.authenticate,
      sendService: runtime.sendService,
      commandService: runtime.commandService,
      mutationService: runtime.mutationService,
      deliveryService: runtime.deliveryService,
      translationRecoveryService:
        runtime.translationRecoveryService,
      correctionService: runtime.correctionService,
      tenantPolicyService: runtime.tenantPolicyService,
      userLanguagePreferenceService:
        runtime.userLanguagePreferenceService,
      translationFeedbackService:
        runtime.translationFeedbackService,
      deviceService: runtime.deviceService,
      readinessService: runtime.readinessService,
    });

    if (
      translationWorkerRunner &&
      workerConfig.mode === "embedded"
    ) {
      translationWorkerRunner.start();
    }

    let closed = false;

    return {
      server,
      runtime,
      translationWorkerRunner,
      async close() {
        if (closed) return;
        closed = true;

        let serverError;
        try {
          await closeHttpServer(server);
        } catch (error) {
          serverError = error;
        }

        try {
          await translationWorkerRunner?.stop();
        } catch (workerError) {
          if (!serverError) {
            serverError = workerError;
          }
        }

        try {
          await runtime.close();
        } catch (runtimeError) {
          if (!serverError) {
            throw runtimeError;
          }
        }

        if (serverError) {
          throw serverError;
        }
      },
    };
  } catch (error) {
    await translationWorkerRunner?.stop();
    await runtime.close();
    throw error;
  }
}
