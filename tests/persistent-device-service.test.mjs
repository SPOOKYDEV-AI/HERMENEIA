import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  PersistentDeviceService,
} from "../.build/packages/device-service/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakeDeviceStore {
  constructor() {
    this.actorAllowed = true;
    this.receipts = new Map();
    this.devices = new Map([
      ["device-current", {
        deviceId: "device-current",
        userId: "user-a",
        status: "ACTIVE",
        credentialVersion: 1,
        publicMaterialRef: "material-current",
        platform: "DESKTOP",
        revocationEpoch: 0,
        registeredAt: "2026-10-04T10:00:00.000Z",
        revokedAt: null,
        lastSeenAt: null,
      }],
    ]);
    this.syncStates = new Set(["device-current"]);
    this.sessions = [
      { userId: "user-a", deviceId: "device-current", status: "ACTIVE" },
    ];
    this.envelopes = [];
  }

  snapshot() {
    return {
      receipts: new Map(
        [...this.receipts.entries()].map(([k,v]) => [k, clone(v)]),
      ),
      devices: new Map(
        [...this.devices.entries()].map(([k,v]) => [k, clone(v)]),
      ),
      syncStates: new Set(this.syncStates),
      sessions: clone(this.sessions),
      envelopes: clone(this.envelopes),
    };
  }

  restore(snapshot) {
    this.receipts = snapshot.receipts;
    this.devices = snapshot.devices;
    this.syncStates = snapshot.syncStates;
    this.sessions = snapshot.sessions;
    this.envelopes = snapshot.envelopes;
  }

  async withTransaction(work) {
    const snapshot = this.snapshot();
    try {
      return await work({});
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async claimCommand(_tx, input) {
    const key = `${input.actor.tenantId}:${input.commandId}`;
    const existing = this.receipts.get(key);
    if (existing) {
      return { claimed: false, existing: clone(existing) };
    }
    this.receipts.set(key, {
      actorUserId: input.actor.userId,
      actorDeviceId: input.actor.deviceId,
      commandType: input.commandType,
      commandFingerprint: input.commandFingerprint,
      status: "IN_PROGRESS",
      result: {},
    });
    return { claimed: true };
  }

  async markCommandSucceeded(_tx, input) {
    const receipt = this.receipts.get(
      `${input.tenantId}:${input.commandId}`,
    );
    assert.ok(receipt);
    assert.equal(receipt.status, "IN_PROGRESS");
    assert.equal(receipt.actorUserId, input.actorUserId);
    assert.equal(receipt.actorDeviceId, input.actorDeviceId);
    assert.equal(receipt.commandType, input.commandType);
    assert.equal(
      receipt.commandFingerprint,
      input.commandFingerprint,
    );
    receipt.status = "SUCCEEDED";
    receipt.result = clone(input.result);
  }

  async actorCanManageDevices() {
    return this.actorAllowed;
  }

  async lockDeviceForUser(_tx, actor, deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== actor.userId) {
      return undefined;
    }
    return clone(device);
  }

  async insertDevice(_tx, input) {
    if (this.devices.has(input.deviceId)) return false;
    this.devices.set(input.deviceId, {
      deviceId: input.deviceId,
      userId: input.userId,
      status: "ACTIVE",
      credentialVersion: 1,
      publicMaterialRef: input.publicMaterialRef,
      platform: input.platform,
      revocationEpoch: 0,
      registeredAt: input.registeredAt,
      revokedAt: null,
      lastSeenAt: null,
    });
    return true;
  }

  async insertDeviceSyncState(_tx, deviceId) {
    this.syncStates.add(deviceId);
  }

  async listUserDevices(_tx, actor) {
    return [...this.devices.values()]
      .filter((device) => device.userId === actor.userId)
      .map(clone);
  }

  async rotateDeviceMaterial(_tx, input) {
    const device = this.devices.get(input.deviceId);
    if (
      !device ||
      device.userId !== input.userId ||
      device.status !== "ACTIVE" ||
      device.credentialVersion !== input.expectedCredentialVersion
    ) {
      return undefined;
    }
    device.credentialVersion += 1;
    device.publicMaterialRef = input.publicMaterialRef;
    device.lastSeenAt = input.now;
    return clone(device);
  }

  async revokeDevice(_tx, input) {
    const device = this.devices.get(input.deviceId);
    if (
      !device ||
      device.userId !== input.userId ||
      device.status === "REVOKED"
    ) {
      return undefined;
    }
    device.status = "REVOKED";
    device.revocationEpoch += 1;
    device.revokedAt = input.now;
    return clone(device);
  }

  async revokeActiveSessionsForDevice(_tx, input) {
    let count = 0;
    for (const session of this.sessions) {
      if (
        session.userId === input.userId &&
        session.deviceId === input.deviceId &&
        session.status === "ACTIVE"
      ) {
        session.status = "REVOKED";
        count += 1;
      }
    }
    return count;
  }

  async revokePendingDeviceEnvelopes(_tx, input) {
    let count = 0;
    for (const envelope of this.envelopes) {
      if (
        envelope.deviceId === input.deviceId &&
        envelope.credentialVersion <= input.throughCredentialVersion &&
        envelope.status === "PENDING"
      ) {
        envelope.status = "REVOKED";
        envelope.payload = "";
        count += 1;
      }
    }
    return count;
  }
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-current",
};

function createFixture() {
  const store = new FakeDeviceStore();
  const service = new PersistentDeviceService({
    store,
    clock: {
      now() {
        return "2026-10-04T16:00:00.000Z";
      },
    },
    materialFingerprinter: {
      fingerprint(value) {
        return `sha256:${createHash("sha256")
          .update(value)
          .digest("hex")}`;
      },
    },
  });
  return { store, service };
}

function enroll(overrides = {}) {
  return {
    protocol_version: 1,
    command_id: "enroll-1",
    device_id: "device-new",
    public_material_ref: "public:new",
    platform: "ANDROID",
    ...overrides,
  };
}

test("enrollment creates server-owned credential version 1 and sync state", async () => {
  const { store, service } = createFixture();
  const result = await service.enrollDevice(actor, enroll());

  assert.deepEqual(result, {
    device_id: "device-new",
    status: "ACTIVE",
    credential_version: 1,
    platform: "ANDROID",
    registered_at: "2026-10-04T16:00:00.000Z",
    revoked_at: null,
    last_seen_at: null,
  });
  assert.equal(store.syncStates.has("device-new"), true);
  assert.equal(
    Object.hasOwn(result, "public_material_ref"),
    false,
  );
});

test("enrollment retry is idempotent across same or new command id", async () => {
  const { store, service } = createFixture();
  const first = await service.enrollDevice(actor, enroll());
  const sameCommand = await service.enrollDevice(actor, enroll());
  const newCommand = await service.enrollDevice(
    actor,
    enroll({ command_id: "enroll-2" }),
  );

  assert.deepEqual(sameCommand, first);
  assert.deepEqual(newCommand, first);
  assert.equal(
    [...store.devices.keys()].filter((id) => id === "device-new").length,
    1,
  );
});

test("device id cannot be rebound to different enrollment state", async () => {
  const { service } = createFixture();
  await service.enrollDevice(actor, enroll());

  await assert.rejects(
    () =>
      service.enrollDevice(
        actor,
        enroll({
          command_id: "enroll-conflict",
          public_material_ref: "public:different",
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("device rotation is self-only, monotone and purges old pending envelopes", async () => {
  const { store, service } = createFixture();
  store.envelopes.push(
    {
      deviceId: "device-current",
      credentialVersion: 1,
      status: "PENDING",
      payload: "cipher-1",
    },
    {
      deviceId: "device-current",
      credentialVersion: 2,
      status: "PENDING",
      payload: "future",
    },
  );

  const result = await service.rotateMaterial(actor, {
    protocol_version: 1,
    command_id: "rotate-1",
    device_id: "device-current",
    expected_credential_version: 1,
    public_material_ref: "material-v2",
  });

  assert.equal(result.credential_version, 2);
  assert.equal(
    store.devices.get("device-current").publicMaterialRef,
    "material-v2",
  );
  assert.equal(store.envelopes[0].status, "REVOKED");
  assert.equal(store.envelopes[0].payload, "");
  assert.equal(store.envelopes[1].status, "PENDING");
  assert.equal(store.sessions[0].status, "ACTIVE");

  await assert.rejects(
    () =>
      service.rotateMaterial(actor, {
        protocol_version: 1,
        command_id: "rotate-foreign",
        device_id: "device-new",
        expected_credential_version: 1,
        public_material_ref: "x",
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "NOT_AUTHORIZED",
  );
});

test("rotation lost-response retry with a new command recovers version 2", async () => {
  const { service } = createFixture();

  const first = await service.rotateMaterial(actor, {
    protocol_version: 1,
    command_id: "rotate-first",
    device_id: "device-current",
    expected_credential_version: 1,
    public_material_ref: "material-v2",
  });

  const recovered = await service.rotateMaterial(actor, {
    protocol_version: 1,
    command_id: "rotate-recovery",
    device_id: "device-current",
    expected_credential_version: 1,
    public_material_ref: "material-v2",
  });

  assert.deepEqual(recovered, first);
  assert.equal(first.credential_version, 2);
});

test("stale rotation with different material is rejected", async () => {
  const { service } = createFixture();
  await service.rotateMaterial(actor, {
    protocol_version: 1,
    command_id: "rotate-first",
    device_id: "device-current",
    expected_credential_version: 1,
    public_material_ref: "material-v2",
  });

  await assert.rejects(
    () =>
      service.rotateMaterial(actor, {
        protocol_version: 1,
        command_id: "rotate-stale",
        device_id: "device-current",
        expected_credential_version: 1,
        public_material_ref: "material-other",
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "REVISION_CONFLICT",
  );
});

test("revocation cuts active sessions and purges pending envelopes", async () => {
  const { store, service } = createFixture();
  await service.enrollDevice(actor, enroll());
  store.sessions.push({
    userId: "user-a",
    deviceId: "device-new",
    status: "ACTIVE",
  });
  store.envelopes.push({
    deviceId: "device-new",
    credentialVersion: 1,
    status: "PENDING",
    payload: "cipher-new",
  });

  const result = await service.revokeDevice(actor, {
    protocol_version: 1,
    command_id: "revoke-1",
    device_id: "device-new",
  });

  assert.equal(result.status, "REVOKED");
  assert.equal(
    store.sessions.find((s) => s.deviceId === "device-new").status,
    "REVOKED",
  );
  assert.equal(store.envelopes[0].status, "REVOKED");
  assert.equal(store.envelopes[0].payload, "");
  assert.equal(
    store.devices.get("device-new").revocationEpoch,
    1,
  );

  const retry = await service.revokeDevice(actor, {
    protocol_version: 1,
    command_id: "revoke-2",
    device_id: "device-new",
  });
  assert.deepEqual(retry, result);
});

test("device listing returns lifecycle metadata without delivery material", async () => {
  const { service } = createFixture();
  await service.enrollDevice(actor, enroll());

  const devices = await service.listDevices(actor);
  assert.equal(devices.length, 2);
  assert.equal(
    devices.some((device) =>
      Object.hasOwn(device, "publicMaterialRef") ||
      Object.hasOwn(device, "public_material_ref")
    ),
    false,
  );
});

test("revoked current actor cannot administer devices", async () => {
  const { store, service } = createFixture();
  store.actorAllowed = false;

  await assert.rejects(
    () => service.listDevices(actor),
    (error) =>
      error instanceof DomainError &&
      error.code === "DEVICE_REVOKED",
  );

  await assert.rejects(
    () => service.enrollDevice(actor, enroll()),
    (error) =>
      error instanceof DomainError &&
      error.code === "DEVICE_REVOKED",
  );
  assert.equal(store.receipts.size, 0);
});
