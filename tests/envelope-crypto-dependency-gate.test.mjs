import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyEnvelopeCryptoDependencies,
} from "../scripts/verify_envelope_crypto_dependencies.mjs";

function fixture({
  core = "1.9.0",
  common = "1.10.1",
  withLock = true,
  coreIntegrity = "sha512-QUJDRA==",
  commonIntegrity = "sha512-RUZHSA==",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "hermeneia-hpke-gate-"));

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: {
        "@hpke/core": core,
      },
      overrides: {
        "@hpke/common": common,
      },
    }),
  );

  if (withLock) {
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/@hpke/core": {
            version: core,
            resolved:
              `https://registry.npmjs.org/@hpke/core/-/core-${core}.tgz`,
            integrity: coreIntegrity,
          },
          "node_modules/@hpke/common": {
            version: common,
            resolved:
              `https://registry.npmjs.org/@hpke/common/-/common-${common}.tgz`,
            integrity: commonIntegrity,
          },
        },
      }),
    );
  }

  return root;
}

test("crypto dependency gate accepts exact locked HPKE versions", () => {
  assert.deepEqual(
    verifyEnvelopeCryptoDependencies(fixture()),
    {
      ok: true,
      packages: {
        "@hpke/core": "1.9.0",
        "@hpke/common": "1.10.1",
      },
    },
  );
});

test("crypto dependency gate rejects missing lockfile", () => {
  assert.throws(
    () =>
      verifyEnvelopeCryptoDependencies(
        fixture({ withLock: false }),
      ),
    /package-lock\.json is required/,
  );
});

test("crypto dependency gate rejects direct or override version drift", () => {
  assert.throws(
    () =>
      verifyEnvelopeCryptoDependencies(
        fixture({ core: "^1.9.0" }),
      ),
    /@hpke\/core must be exactly 1\.9\.0/,
  );

  assert.throws(
    () =>
      verifyEnvelopeCryptoDependencies(
        fixture({ common: "1.11.0" }),
      ),
    /@hpke\/common must be exactly 1\.10\.1/,
  );
});

test("crypto dependency gate rejects lockfile version drift", () => {
  const root = fixture();
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 2,
      packages: {},
    }),
  );

  assert.throws(
    () => verifyEnvelopeCryptoDependencies(root),
    /lockfileVersion >= 3/,
  );
});

test("crypto dependency gate rejects missing package integrity", () => {
  assert.throws(
    () =>
      verifyEnvelopeCryptoDependencies(
        fixture({ coreIntegrity: "" }),
      ),
    /@hpke\/core must contain sha512 integrity/,
  );

  assert.throws(
    () =>
      verifyEnvelopeCryptoDependencies(
        fixture({ commonIntegrity: "sha256-not-enough" }),
      ),
    /@hpke\/common must contain sha512 integrity/,
  );
});
