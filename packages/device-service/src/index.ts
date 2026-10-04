import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";

export type DevicePlatform =
  | "WEB"
  | "ANDROID"
  | "IOS"
  | "DESKTOP"
  | "OTHER";

export type DeviceLifecycleStatus =
  | "ACTIVE"
  | "REVOKED"
  | "LOST";

export interface DeviceResult {
  device_id: UUID;
  status: DeviceLifecycleStatus;
  credential_version: number;
  platform: DevicePlatform;
  registered_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
}

export interface EnrollDeviceCommand {
  protocol_version: 1;
  command_id: UUID;
  device_id: UUID;
  public_material_ref: string;
  platform?: DevicePlatform;
}

export interface RotateDeviceMaterialCommand {
  protocol_version: 1;
  command_id: UUID;
  device_id: UUID;
  expected_credential_version: number;
  public_material_ref: string;
}

export interface RevokeDeviceCommand {
  protocol_version: 1;
  command_id: UUID;
  device_id: UUID;
}

export interface PersistentDeviceRecord {
  deviceId: UUID;
  userId: UUID;
  status: DeviceLifecycleStatus;
  credentialVersion: number;
  publicMaterialRef: string;
  platform: DevicePlatform;
  revocationEpoch: number;
  registeredAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface PersistentDeviceCommandReceipt {
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export type PersistentDeviceCommandClaim =
  | { claimed: true }
  | { claimed: false; existing: PersistentDeviceCommandReceipt };

export interface PersistentDeviceStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<PersistentDeviceCommandClaim>;

  markCommandSucceeded(
    tx: Tx,
    input: {
      tenantId: UUID;
      commandId: UUID;
      actorUserId: UUID;
      actorDeviceId: UUID;
      commandType: string;
      commandFingerprint: string;
      result: Record<string, unknown>;
      now: string;
    },
  ): Promise<void>;

  actorCanManageDevices(
    tx: Tx,
    actor: ActorContext,
  ): Promise<boolean>;

  lockDeviceForUser(
    tx: Tx,
    actor: ActorContext,
    deviceId: UUID,
  ): Promise<PersistentDeviceRecord | undefined>;

  insertDevice(
    tx: Tx,
    input: {
      deviceId: UUID;
      userId: UUID;
      publicMaterialRef: string;
      platform: DevicePlatform;
      registeredAt: string;
    },
  ): Promise<boolean>;

  insertDeviceSyncState(
    tx: Tx,
    deviceId: UUID,
  ): Promise<void>;

  listUserDevices(
    tx: Tx,
    actor: ActorContext,
  ): Promise<PersistentDeviceRecord[]>;

  rotateDeviceMaterial(
    tx: Tx,
    input: {
      deviceId: UUID;
      userId: UUID;
      expectedCredentialVersion: number;
      publicMaterialRef: string;
      now: string;
    },
  ): Promise<PersistentDeviceRecord | undefined>;

  revokeDevice(
    tx: Tx,
    input: {
      deviceId: UUID;
      userId: UUID;
      now: string;
    },
  ): Promise<PersistentDeviceRecord | undefined>;

  revokeActiveSessionsForDevice(
    tx: Tx,
    input: {
      userId: UUID;
      deviceId: UUID;
      now: string;
    },
  ): Promise<number>;

  revokePendingDeviceEnvelopes(
    tx: Tx,
    input: {
      deviceId: UUID;
      throughCredentialVersion: number;
    },
  ): Promise<number>;
}

export interface DeviceClock {
  now(): string;
}

export interface DeviceMaterialFingerprinter {
  fingerprint(publicMaterialRef: string): string;
}

export interface DeviceMaterialValidator {
  validate(publicMaterialRef: string): void;
}

export interface PersistentDeviceServiceDependencies<Tx> {
  store: PersistentDeviceStore<Tx>;
  clock: DeviceClock;
  materialFingerprinter: DeviceMaterialFingerprinter;
  materialValidator: DeviceMaterialValidator;
}

interface EnrollFingerprintV1 {
  v: 1;
  type: "device.enroll";
  device_id: UUID;
  public_material_fingerprint: string;
  platform: DevicePlatform;
}

interface RotateFingerprintV1 {
  v: 1;
  type: "device.rotate_material";
  device_id: UUID;
  expected_credential_version: number;
  public_material_fingerprint: string;
}

interface RevokeFingerprintV1 {
  v: 1;
  type: "device.revoke";
  device_id: UUID;
}

export class PersistentDeviceService<Tx> {
  constructor(
    private readonly deps: PersistentDeviceServiceDependencies<Tx>,
  ) {}

  async listDevices(actor: ActorContext): Promise<DeviceResult[]> {
    return this.deps.store.withTransaction(async (tx) => {
      if (!(await this.deps.store.actorCanManageDevices(tx, actor))) {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Current device is not authorised for device administration",
        );
      }

      const devices = await this.deps.store.listUserDevices(tx, actor);
      return devices.map(toDeviceResult);
    });
  }

  async enrollDevice(
    actor: ActorContext,
    command: EnrollDeviceCommand,
  ): Promise<DeviceResult> {
    validateCommandIdentity(command.command_id, command.device_id);
    validateMaterial(command.public_material_ref);
    this.validateMaterialFormat(command.public_material_ref);
    this.validateMaterialFormat(command.public_material_ref);
    const platform = command.platform ?? "OTHER";
    validatePlatform(platform);

    const now = this.deps.clock.now();
    validateTimestamp(now);

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "device.enroll",
      device_id: command.device_id,
      public_material_fingerprint:
        this.materialFingerprint(command.public_material_ref),
      platform,
    } satisfies EnrollFingerprintV1);

    return this.deps.store.withTransaction(async (tx) => {
      const claim = await this.deps.store.claimCommand(tx, {
        actor,
        commandId: command.command_id,
        commandType: "device.enroll",
        commandFingerprint,
        now,
      });

      const replay = replayDeviceCommand(
        claim,
        actor,
        "device.enroll",
        commandFingerprint,
      );
      if (replay) return replay;

      if (!(await this.deps.store.actorCanManageDevices(tx, actor))) {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Current device is not authorised for device administration",
        );
      }

      const existing = await this.deps.store.lockDeviceForUser(
        tx,
        actor,
        command.device_id,
      );

      let result: DeviceResult;
      if (existing) {
        if (
          existing.status !== "ACTIVE" ||
          existing.credentialVersion !== 1 ||
          existing.publicMaterialRef !== command.public_material_ref ||
          existing.platform !== platform
        ) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "device_id is already bound to different device state",
          );
        }
        result = toDeviceResult(existing);
      } else {
        const inserted = await this.deps.store.insertDevice(tx, {
          deviceId: command.device_id,
          userId: actor.userId,
          publicMaterialRef: command.public_material_ref,
          platform,
          registeredAt: now,
        });
        if (!inserted) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "device_id is already registered",
          );
        }

        await this.deps.store.insertDeviceSyncState(
          tx,
          command.device_id,
        );

        result = {
          device_id: command.device_id,
          status: "ACTIVE",
          credential_version: 1,
          platform,
          registered_at: now,
          revoked_at: null,
          last_seen_at: null,
        };
      }

      await this.markSucceeded(
        tx,
        actor,
        command.command_id,
        "device.enroll",
        commandFingerprint,
        result,
        now,
      );

      return result;
    });
  }

  async rotateMaterial(
    actor: ActorContext,
    command: RotateDeviceMaterialCommand,
  ): Promise<DeviceResult> {
    validateCommandIdentity(command.command_id, command.device_id);
    validateMaterial(command.public_material_ref);
    if (
      !Number.isInteger(command.expected_credential_version) ||
      command.expected_credential_version < 1
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "expected_credential_version must be a positive integer",
      );
    }
    if (command.device_id !== actor.deviceId) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "A device may rotate only its own delivery material",
      );
    }

    const now = this.deps.clock.now();
    validateTimestamp(now);
    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "device.rotate_material",
      device_id: command.device_id,
      expected_credential_version:
        command.expected_credential_version,
      public_material_fingerprint:
        this.materialFingerprint(command.public_material_ref),
    } satisfies RotateFingerprintV1);

    return this.deps.store.withTransaction(async (tx) => {
      const claim = await this.deps.store.claimCommand(tx, {
        actor,
        commandId: command.command_id,
        commandType: "device.rotate_material",
        commandFingerprint,
        now,
      });
      const replay = replayDeviceCommand(
        claim,
        actor,
        "device.rotate_material",
        commandFingerprint,
      );
      if (replay) return replay;

      if (!(await this.deps.store.actorCanManageDevices(tx, actor))) {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Current device is not authorised for device administration",
        );
      }

      const current = await this.deps.store.lockDeviceForUser(
        tx,
        actor,
        command.device_id,
      );
      if (!current || current.status !== "ACTIVE") {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Device is not active",
        );
      }

      if (
        current.credentialVersion ===
          command.expected_credential_version + 1 &&
        current.publicMaterialRef === command.public_material_ref
      ) {
        const recovered = toDeviceResult(current);
        await this.markSucceeded(
          tx,
          actor,
          command.command_id,
          "device.rotate_material",
          commandFingerprint,
          recovered,
          now,
        );
        return recovered;
      }

      if (
        current.credentialVersion !==
        command.expected_credential_version
      ) {
        throw new DomainError(
          "REVISION_CONFLICT",
          "Device credential version is stale",
        );
      }
      if (current.publicMaterialRef === command.public_material_ref) {
        throw new DomainError(
          "INVALID_COMMAND",
          "New delivery material must differ from the current material",
        );
      }

      const rotated = await this.deps.store.rotateDeviceMaterial(tx, {
        deviceId: command.device_id,
        userId: actor.userId,
        expectedCredentialVersion:
          command.expected_credential_version,
        publicMaterialRef: command.public_material_ref,
        now,
      });
      if (!rotated) {
        throw new DomainError(
          "REVISION_CONFLICT",
          "Device credential version changed concurrently",
        );
      }

      await this.deps.store.revokePendingDeviceEnvelopes(tx, {
        deviceId: command.device_id,
        throughCredentialVersion:
          command.expected_credential_version,
      });

      const result = toDeviceResult(rotated);
      await this.markSucceeded(
        tx,
        actor,
        command.command_id,
        "device.rotate_material",
        commandFingerprint,
        result,
        now,
      );
      return result;
    });
  }

  async revokeDevice(
    actor: ActorContext,
    command: RevokeDeviceCommand,
  ): Promise<DeviceResult> {
    validateCommandIdentity(command.command_id, command.device_id);

    const now = this.deps.clock.now();
    validateTimestamp(now);
    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "device.revoke",
      device_id: command.device_id,
    } satisfies RevokeFingerprintV1);

    return this.deps.store.withTransaction(async (tx) => {
      const claim = await this.deps.store.claimCommand(tx, {
        actor,
        commandId: command.command_id,
        commandType: "device.revoke",
        commandFingerprint,
        now,
      });
      const replay = replayDeviceCommand(
        claim,
        actor,
        "device.revoke",
        commandFingerprint,
      );
      if (replay) return replay;

      if (!(await this.deps.store.actorCanManageDevices(tx, actor))) {
        throw new DomainError(
          "DEVICE_REVOKED",
          "Current device is not authorised for device administration",
        );
      }

      const current = await this.deps.store.lockDeviceForUser(
        tx,
        actor,
        command.device_id,
      );
      if (!current) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Device is not available to current user",
        );
      }

      let revoked = current;
      if (current.status !== "REVOKED") {
        const updated = await this.deps.store.revokeDevice(tx, {
          deviceId: current.deviceId,
          userId: actor.userId,
          now,
        });
        if (!updated) {
          throw new Error(
            "Invariant violation: locked device could not be revoked",
          );
        }
        revoked = updated;

        await this.deps.store.revokeActiveSessionsForDevice(tx, {
          userId: actor.userId,
          deviceId: current.deviceId,
          now,
        });

        await this.deps.store.revokePendingDeviceEnvelopes(tx, {
          deviceId: current.deviceId,
          throughCredentialVersion: current.credentialVersion,
        });
      }

      const result = toDeviceResult(revoked);
      await this.markSucceeded(
        tx,
        actor,
        command.command_id,
        "device.revoke",
        commandFingerprint,
        result,
        now,
      );
      return result;
    });
  }

  private validateMaterialFormat(value: string): void {
    try {
      this.deps.materialValidator.validate(value);
    } catch {
      throw new DomainError(
        "INVALID_COMMAND",
        "public_material_ref is not a supported delivery key",
      );
    }
  }

  private materialFingerprint(value: string): string {
    const fingerprint =
      this.deps.materialFingerprinter.fingerprint(value);
    if (!fingerprint || fingerprint === value) {
      throw new Error(
        "Device material fingerprinter must return an opaque fingerprint",
      );
    }
    return fingerprint;
  }

  private async markSucceeded(
    tx: Tx,
    actor: ActorContext,
    commandId: UUID,
    commandType: string,
    commandFingerprint: string,
    result: DeviceResult,
    now: string,
  ): Promise<void> {
    await this.deps.store.markCommandSucceeded(tx, {
      tenantId: actor.tenantId,
      commandId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      commandType,
      commandFingerprint,
      result: result as unknown as Record<string, unknown>,
      now,
    });
  }
}

function replayDeviceCommand(
  claim: PersistentDeviceCommandClaim,
  actor: ActorContext,
  commandType: string,
  commandFingerprint: string,
): DeviceResult | undefined {
  if (claim.claimed) return undefined;

  const existing = claim.existing;
  if (
    existing.actorUserId !== actor.userId ||
    existing.actorDeviceId !== actor.deviceId
  ) {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "Command identifier is not available to actor",
    );
  }
  if (
    existing.commandType !== commandType ||
    existing.commandFingerprint !== commandFingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }
  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent command receipt is not terminal",
    );
  }
  return deviceResultFromRecord(existing.result);
}

function deviceResultFromRecord(
  value: Record<string, unknown>,
): DeviceResult {
  if (
    typeof value.device_id !== "string" ||
    (value.status !== "ACTIVE" &&
      value.status !== "REVOKED" &&
      value.status !== "LOST") ||
    typeof value.credential_version !== "number" ||
    !isPlatform(value.platform) ||
    typeof value.registered_at !== "string" ||
    !(
      value.revoked_at === null ||
      typeof value.revoked_at === "string"
    ) ||
    !(
      value.last_seen_at === null ||
      typeof value.last_seen_at === "string"
    )
  ) {
    throw new Error(
      "Invariant violation: invalid persistent device command result",
    );
  }
  return value as unknown as DeviceResult;
}

function toDeviceResult(
  record: PersistentDeviceRecord,
): DeviceResult {
  return {
    device_id: record.deviceId,
    status: record.status,
    credential_version: record.credentialVersion,
    platform: record.platform,
    registered_at: record.registeredAt,
    revoked_at: record.revokedAt,
    last_seen_at: record.lastSeenAt,
  };
}

function validateCommandIdentity(
  commandId: UUID,
  deviceId: UUID,
): void {
  if (!commandId || !deviceId) {
    throw new DomainError(
      "INVALID_COMMAND",
      "command_id and device_id are required",
    );
  }
}

function validateMaterial(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.trim().length < 1
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "public_material_ref must contain 1..4096 characters",
    );
  }
}

function validatePlatform(value: string): asserts value is DevicePlatform {
  if (!isPlatform(value)) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Unsupported device platform",
    );
  }
}

function isPlatform(value: unknown): value is DevicePlatform {
  return (
    value === "WEB" ||
    value === "ANDROID" ||
    value === "IOS" ||
    value === "DESKTOP" ||
    value === "OTHER"
  );
}

function validateTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Clock returned an invalid timestamp");
  }
}
