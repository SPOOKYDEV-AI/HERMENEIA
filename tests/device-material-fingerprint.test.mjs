import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeviceMaterialFingerprinter,
} from "../apps/api/device-material-fingerprint.mjs";

test("device material fingerprint is stable and never returns raw material", () => {
  const fingerprinter = createDeviceMaterialFingerprinter();
  const material = "opaque-public-material-reference";

  const first = fingerprinter.fingerprint(material);
  const second = fingerprinter.fingerprint(material);

  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first, material);
  assert.equal(first.includes(material), false);
});

test("different device material produces different fingerprints", () => {
  const fingerprinter = createDeviceMaterialFingerprinter();
  assert.notEqual(
    fingerprinter.fingerprint("material-a"),
    fingerprinter.fingerprint("material-b"),
  );
});
