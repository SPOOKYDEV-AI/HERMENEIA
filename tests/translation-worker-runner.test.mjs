import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createTranslationWorkerRunner,
  translationWorkerRunnerConfigFromEnv,
} from "../apps/api/translation-worker-runner.mjs";

test("worker runner drains fanout and execute fairly until idle", async () => {
  const fanout = ["FANOUT_DONE", "NO_WORK"];
  const execute = ["EXECUTION_DONE", "NO_WORK"];
  let fanoutCalls = 0;
  let executeCalls = 0;

  const runner = createTranslationWorkerRunner({
    worker: {
      async runFanoutOnce() {
        const result = fanout[fanoutCalls] ?? "NO_WORK";
        fanoutCalls += 1;
        return result;
      },
      async runExecuteOnce() {
        const result = execute[executeCalls] ?? "NO_WORK";
        executeCalls += 1;
        return result;
      },
    },
    config: {
      maxDrainPerCycle: 8,
    },
  });

  assert.deepEqual(await runner.runOnce(), {
    processed: 2,
    fanoutResult: "NO_WORK",
    executeResult: "NO_WORK",
  });
  assert.equal(fanoutCalls, 2);
  assert.equal(executeCalls, 2);
});

test("worker runner enforces the per-cycle drain bound", async () => {
  let fanoutCalls = 0;
  let executeCalls = 0;

  const runner = createTranslationWorkerRunner({
    worker: {
      async runFanoutOnce() {
        fanoutCalls += 1;
        return "FANOUT_DONE";
      },
      async runExecuteOnce() {
        executeCalls += 1;
        return "EXECUTION_DONE";
      },
    },
    config: {
      maxDrainPerCycle: 3,
    },
  });

  const cycle = await runner.runOnce();
  assert.equal(cycle.processed, 6);
  assert.equal(fanoutCalls, 3);
  assert.equal(executeCalls, 3);
});

test("worker runner start is idempotent and stop ends the idle loop", async () => {
  let calls = 0;
  const runner = createTranslationWorkerRunner({
    worker: {
      async runFanoutOnce() {
        calls += 1;
        return "NO_WORK";
      },
      async runExecuteOnce() {
        calls += 1;
        return "NO_WORK";
      },
    },
    config: {
      idlePollMs: 10,
      errorBackoffMs: 10,
    },
  });

  const first = runner.start();
  const second = runner.start();
  assert.equal(first, second);
  assert.equal(runner.running, true);

  await sleep(25);
  await runner.stop();
  await first;

  assert.equal(runner.running, false);
  assert.ok(calls >= 2);
});

test("worker runner stop waits for an in-flight cycle before resolving", async () => {
  let releaseFanout;
  let enteredFanout;
  const entered = new Promise((resolve) => {
    enteredFanout = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseFanout = resolve;
  });

  const runner = createTranslationWorkerRunner({
    worker: {
      async runFanoutOnce() {
        enteredFanout();
        await blocked;
        return "FANOUT_DONE";
      },
      async runExecuteOnce() {
        return "NO_WORK";
      },
    },
    config: {
      maxDrainPerCycle: 1,
      busyYieldMs: 0,
      idlePollMs: 10,
      errorBackoffMs: 10,
    },
  });

  const loop = runner.start();
  await entered;

  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });

  await sleep(5);
  assert.equal(stopped, false);

  releaseFanout();
  await stopping;
  await loop;

  assert.equal(stopped, true);
  assert.equal(runner.running, false);
});

test("worker runner config supports embedded or external mode only", () => {
  assert.equal(
    translationWorkerRunnerConfigFromEnv({
      TRANSLATION_WORKER_MODE: "external",
    }).mode,
    "external",
  );

  assert.throws(
    () =>
      translationWorkerRunnerConfigFromEnv({
        TRANSLATION_WORKER_MODE: "sometimes",
      }),
    /must be embedded or external/,
  );
});
