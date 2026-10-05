import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

function listen(server, port) {
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
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function reserveFreePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

function waitForMarker(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(
        `Timed out waiting for child marker: ${marker}`,
      ));
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    }

    function onStdout(chunk) {
      stdout += String(chunk);
      if (stdout.includes(marker)) {
        finish();
      }
    }

    function onStderr(chunk) {
      stderr += String(chunk);
    }

    function onExit(code, signal) {
      finish(new Error(
        `Persistent process exited before readiness: code=${code} signal=${signal} stderr=${stderr.slice(-2000)}`,
      ));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Persistent process did not exit after SIGTERM"));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const required = [
  "DATABASE_URL",
  "SOURCE_FINGERPRINT_HMAC_KEY_BASE64",
];

for (const name of required) {
  if (!process.env[name]) {
    process.stdout.write(
      `PERSISTENT_PROCESS_SIGNAL_SMOKE=SKIP missing=${name}\n`,
    );
    process.exit(0);
  }
}

if (process.platform === "win32") {
  process.stdout.write(
    "PERSISTENT_PROCESS_SIGNAL_SMOKE=SKIP platform=win32\n",
  );
  process.exit(0);
}

const port = await reserveFreePort();
const child = spawn(
  process.execPath,
  ["apps/api/start-persistent-server.mjs"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  if (stdout.length > 64 * 1024) {
    stdout = stdout.slice(-64 * 1024);
  }
});
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
  if (stderr.length > 64 * 1024) {
    stderr = stderr.slice(-64 * 1024);
  }
});

try {
  await waitForMarker(
    child,
    "HERMENEIA_API_LISTENING",
    15_000,
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  assert.equal(child.kill("SIGTERM"), true);
  const exited = await waitForExit(child, 15_000);

  assert.equal(exited.code, 0);
  assert.equal(exited.signal, null);
  assert.match(stdout, /HERMENEIA_API_SHUTDOWN signal=SIGTERM/);
  assert.doesNotMatch(
    stderr,
    /HERMENEIA_API_(START_FAILED|SHUTDOWN_ERROR)/,
  );

  process.stdout.write(
    "PERSISTENT_PROCESS_SIGNAL_SMOKE=PASS\n",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
