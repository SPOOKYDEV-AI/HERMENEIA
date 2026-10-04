import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = Object.freeze({
  "@hpke/core": Object.freeze({
    version: "1.9.0",
    resolved:
      "https://registry.npmjs.org/@hpke/core/-/core-1.9.0.tgz",
    integrity:
      "sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==",
  }),
  "@hpke/common": Object.freeze({
    version: "1.10.1",
    resolved:
      "https://registry.npmjs.org/@hpke/common/-/common-1.10.1.tgz",
    integrity:
      "sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==",
  }),
});

function fail(message) {
  throw new Error(`ENVELOPE_CRYPTO_DEPENDENCY_GATE: ${message}`);
}

function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is missing or invalid JSON: ${error.message}`);
  }
  return parsed;
}

function assertExactVersion(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be exactly ${expected}; got ${String(actual)}`);
  }
}

function assertLockedPackage(lockfile, packageName, expected) {
  const key = `node_modules/${packageName}`;
  const entry = lockfile.packages?.[key];

  if (!entry || typeof entry !== "object") {
    fail(`package-lock.json does not contain ${key}`);
  }

  assertExactVersion(
    entry.version,
    expected.version,
    `package-lock ${packageName}`,
  );

  if (entry.resolved !== expected.resolved) {
    fail(
      `package-lock ${packageName} resolved URL does not match the approved artifact`,
    );
  }

  if (entry.integrity !== expected.integrity) {
    fail(
      `package-lock ${packageName} integrity does not match the approved artifact`,
    );
  }
}

export function verifyEnvelopeCryptoDependencies(root = process.cwd()) {
  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");

  const pkg = readJson(packagePath, "package.json");

  assertExactVersion(
    pkg.dependencies?.["@hpke/core"],
    REQUIRED["@hpke/core"].version,
    "package.json @hpke/core",
  );
  assertExactVersion(
    pkg.overrides?.["@hpke/common"],
    REQUIRED["@hpke/common"].version,
    "package.json override @hpke/common",
  );

  if (!existsSync(lockPath)) {
    fail(
      "package-lock.json is required before a production crypto claim",
    );
  }

  const lock = readJson(lockPath, "package-lock.json");
  if (
    !Number.isInteger(lock.lockfileVersion) ||
    lock.lockfileVersion < 3
  ) {
    fail("package-lock.json must use lockfileVersion >= 3");
  }

  assertLockedPackage(
    lock,
    "@hpke/core",
    REQUIRED["@hpke/core"],
  );
  assertLockedPackage(
    lock,
    "@hpke/common",
    REQUIRED["@hpke/common"],
  );

  return {
    ok: true,
    packages: {
      "@hpke/core": REQUIRED["@hpke/core"].version,
      "@hpke/common": REQUIRED["@hpke/common"].version,
    },
  };
}

const invokedPath = process.argv[1]
  ? resolve(process.argv[1])
  : null;

if (
  invokedPath &&
  invokedPath === fileURLToPath(import.meta.url)
) {
  try {
    const result = verifyEnvelopeCryptoDependencies();
    process.stdout.write(
      `ENVELOPE_CRYPTO_DEPENDENCY_GATE_PASS ${JSON.stringify(result.packages)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
