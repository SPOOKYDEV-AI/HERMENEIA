import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const OPENAPI = readFileSync(
  new URL("../api/openapi.yaml", import.meta.url),
  "utf8",
);

function count(value) {
  return OPENAPI.split(value).length - 1;
}

test("tenant policy OpenAPI additions stay unique and do not duplicate existing schemas", () => {
  assert.equal(
    count("  /v1/tenant/context-policies:\n"),
    1,
  );
  assert.equal(
    count(
      "  /v1/tenant/context-policies/{claim_id}/revoke:\n",
    ),
    1,
  );

  const policySchemas = [
    "TenantContextPolicyTermMeaning",
    "TenantContextPolicyPreferredRendering",
    "TenantContextPolicyProposition",
    "TenantContextPolicyUpsertRequest",
    "TenantContextPolicySupersededClaim",
    "TenantContextPolicyUpsertResult",
    "TenantContextPolicyRevokeRequest",
    "TenantContextPolicyRevokeResult",
  ];

  for (const schema of policySchemas) {
    assert.equal(
      count(`    ${schema}:\n`),
      1,
      `${schema} must be defined exactly once`,
    );
  }

  for (const existingSchema of [
    "SourceResupplyRequest",
    "TranslationRecoveryResult",
    "LanguagePreferenceRequest",
    "RegisterDeviceRequest",
    "RotateDeviceMaterialRequest",
    "RevokeDeviceRequest",
    "DeviceResult",
    "TranslationStatus",
    "ServerEvent",
    "SyncResponse",
    "SyncResetRequired",
    "ApiError",
  ]) {
    assert.equal(
      count(`    ${existingSchema}:\n`),
      1,
      `${existingSchema} must not be duplicated by policy schema insertion`,
    );
  }
});

test("tenant policy OpenAPI language-tag patterns remain literal and intact", () => {
  assert.equal(
    count(
      "pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$'",
    ),
    4,
  );
  assert.equal(
    OPENAPI.includes(
      "pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*      type: object",
    ),
    false,
  );
});

test("tenant policy OpenAPI refs point to declared policy schemas", () => {
  const declared = new Set(
    [...OPENAPI.matchAll(
      /^    (TenantContextPolicy[A-Za-z0-9_]+):$/gm,
    )].map((match) => match[1]),
  );

  const refs = [
    ...OPENAPI.matchAll(
      /#\/components\/schemas\/(TenantContextPolicy[A-Za-z0-9_]+)/g,
    ),
  ].map((match) => match[1]);

  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.equal(
      declared.has(ref),
      true,
      `missing tenant policy schema for ref ${ref}`,
    );
  }
});
