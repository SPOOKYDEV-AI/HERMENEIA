import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

import {
  createPersistentHermeneiaHttpRuntime,
} from "./persistent-server.mjs";

function positivePort(value) {
  const parsed = Number(value ?? 3000);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 65535
  ) {
    throw new TypeError("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function persistentServerProcessConfigFromEnv(
  env = process.env,
) {
  return {
    host: env.HOST || "0.0.0.0",
    port: positivePort(env.PORT),
    securityModulePath:
      env.HERMENEIA_SECURITY_MODULE || null,
  };
}

export async function loadSecurityRuntimeModule({
  modulePath,
  cwd = process.cwd(),
} = {}) {
  if (typeof modulePath !== "string" || !modulePath.trim()) {
    throw new TypeError(
      "HERMENEIA_SECURITY_MODULE is required",
    );
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(modulePath)) {
    throw new TypeError(
      "HERMENEIA_SECURITY_MODULE must be a local filesystem path",
    );
  }

  const absolutePath = path.resolve(cwd, modulePath);
  const loaded = await import(pathToFileURL(absolutePath).href);

  if (
    !loaded.envelopeProtector ||
    typeof loaded.envelopeProtector.protect !== "function"
  ) {
    throw new TypeError(
      "Security module must export envelopeProtector.protect",
    );
  }

  const hasTranslationProvider = Boolean(
    loaded.translationProvider,
  );
  const hasTranslationProtector = Boolean(
    loaded.translationEnvelopeProtector &&
    typeof loaded.translationEnvelopeProtector.protect === "function",
  );

  if (hasTranslationProvider !== hasTranslationProtector) {
    throw new TypeError(
      "Security module translationProvider and translationEnvelopeProtector must be exported together",
    );
  }

  return {
    envelopeProtector: loaded.envelopeProtector,
    ...(hasTranslationProvider
      ? {
          translationProvider: loaded.translationProvider,
          translationEnvelopeProtector:
            loaded.translationEnvelopeProtector,
        }
      : {}),
  };
}

export async function startPersistentServerProcess({
  env = process.env,
  securityRuntime = null,
  pgModule,
  clock,
  ids,
  host: hostOverride,
  port: portOverride,
  onStarted = null,
} = {}) {
  const config = persistentServerProcessConfigFromEnv(env);
  const host =
    hostOverride === undefined ? config.host : hostOverride;
  const port =
    portOverride === undefined ? config.port : portOverride;

  if (typeof host !== "string" || !host) {
    throw new TypeError("host override must be a non-empty string");
  }
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new TypeError(
      "port override must be an integer between 0 and 65535",
    );
  }
  const security =
    securityRuntime ??
    await loadSecurityRuntimeModule({
      modulePath: config.securityModulePath,
    });

  const app = await createPersistentHermeneiaHttpRuntime({
    env,
    ...security,
    pgModule,
    ...(clock ? { clock } : {}),
    ...(ids ? { ids } : {}),
  });

  let closing = false;
  let closePromise = null;
  const close = async () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = app.close();
    try {
      await closePromise;
    } finally {
      closePromise = null;
    }
  };

  try {
    await listen(app.server, host, port);
  } catch (error) {
    await close();
    throw error;
  }

  if (typeof onStarted === "function") {
    await onStarted({
      host,
      port: app.server.address()?.port ?? port,
    });
  }

  return {
    ...app,
    host,
    port: app.server.address()?.port ?? port,
    get closing() {
      return closing;
    },
    close,
  };
}

export async function runPersistentServerMain({
  env = process.env,
} = {}) {
  const processRuntime = await startPersistentServerProcess({
    env,
    onStarted({ host, port }) {
      process.stdout.write(
        `HERMENEIA_API_LISTENING host=${host} port=${port}\n`,
      );
    },
  });

  let exitCode = 0;
  const shutdown = async (signal) => {
    process.stdout.write(
      `HERMENEIA_API_SHUTDOWN signal=${signal}\n`,
    );
    try {
      await processRuntime.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(
        `HERMENEIA_API_SHUTDOWN_ERROR name=${
          error instanceof Error ? error.name : "UnknownError"
        }\n`,
      );
    }
    process.exitCode = exitCode;
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return processRuntime;
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runPersistentServerMain().catch((error) => {
    process.stderr.write(
      `HERMENEIA_API_START_FAILED name=${
        error instanceof Error ? error.name : "UnknownError"
      }\n`,
    );
    process.exitCode = 1;
  });
}
