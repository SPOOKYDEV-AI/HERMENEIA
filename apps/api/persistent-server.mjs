import { createHermeneiaHttpServer } from "./server.mjs";
import {
  createPersistentSendRuntime,
} from "./persistent-send-runtime.mjs";

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

  try {
    const server = createHermeneiaHttpServer({
      authenticate: runtime.authenticate,
      sendService: runtime.sendService,
      commandService: runtime.commandService,
      mutationService: runtime.mutationService,
      deliveryService: runtime.deliveryService,
      translationRecoveryService:
        runtime.translationRecoveryService,
    });

    let closed = false;

    return {
      server,
      runtime,
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
    await runtime.close();
    throw error;
  }
}
