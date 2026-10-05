import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import {
  parseSupportedClaimProposition,
  storedClaimProposition,
} from "../../context-claim-candidates/src/index.js";

export type TenantContextPolicyKind =
  | "GLOSSARY"
  | "POLICY";

export interface TenantContextPolicyUpsertCommand {
  protocol_version: 1;
  command_id: UUID;
  kind: TenantContextPolicyKind;
  proposition: Record<string, unknown>;
}

export interface TenantContextPolicyUpsertResult {
  protocol_version: 1;
  claim_id: UUID;
  claim_version: number;
  status: "ACTIVE";
  kind: TenantContextPolicyKind;
  tenant_policy_version: number;
  superseded_claims: Array<{
    claim_id: UUID;
    claim_version: number;
  }>;
}

export interface TenantContextPolicyRevokeCommand {
  protocol_version: 1;
  command_id: UUID;
  claim_id: UUID;
}

export interface TenantContextPolicyRevokeResult {
  protocol_version: 1;
  claim_id: UUID;
  claim_version: number;
  status: "REVOKED";
  tenant_policy_version: number;
}

interface CommandReceipt {
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export interface TenantContextPolicyTransactions<Tx> {
  withTransaction<T>(
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;
}

export interface TenantContextPolicyCommandStore<Tx> {
  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<
    | { claimed: true }
    | { claimed: false; existing: CommandReceipt }
  >;

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
}

export interface TenantContextPolicyStore<Tx> {
  lockTenantAuthority(
    tx: Tx,
    actor: ActorContext,
  ): Promise<{
    tenantRole: "MEMBER" | "ADMIN" | "OWNER";
    tenantPolicyVersion: number;
  } | undefined>;

  invalidateSupersededTenantClaims(
    tx: Tx,
    input: {
      tenantId: UUID;
      authorityClass:
        | "APPROVED_GLOSSARY"
        | "POLICY";
      propositionRef: Record<string, unknown>;
      invalidatedAt: string;
    },
  ): Promise<Array<{
    claimId: UUID;
    claimVersion: number;
  }>>;

  insertTenantPolicyClaim(
    tx: Tx,
    input: {
      tenantId: UUID;
      claimId: UUID;
      claimType:
        | "TERMINOLOGY"
        | "LEXICAL_PREFERENCE";
      propositionRef: Record<string, unknown>;
      authorityClass:
        | "APPROVED_GLOSSARY"
        | "POLICY";
      triggerKind:
        | "APPROVED_GLOSSARY_CHANGE"
        | "TENANT_POLICY_CHANGE";
      createdAt: string;
    },
  ): Promise<void>;

  insertOverrideProvenance(
    tx: Tx,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      overriddenClaimId: UUID;
      overriddenClaimVersion: number;
      replacementClaimId: UUID;
      replacementClaimVersion: number;
      strategyVersion: string;
      createdAt: string;
    },
  ): Promise<void>;

  bumpTenantPolicyVersion(
    tx: Tx,
    tenantId: UUID,
  ): Promise<number>;

  loadRevocableTenantClaim(
    tx: Tx,
    input: {
      tenantId: UUID;
      claimId: UUID;
    },
  ): Promise<{
    claimId: UUID;
    claimVersion: number;
    authorityClass:
      | "APPROVED_GLOSSARY"
      | "POLICY";
  } | undefined>;

  revokeTenantClaim(
    tx: Tx,
    input: {
      tenantId: UUID;
      claimId: UUID;
      claimVersion: number;
      revokedAt: string;
    },
  ): Promise<boolean>;
}

export interface TenantContextPolicyIds {
  next(prefix: string): UUID;
}

export interface TenantContextPolicyClock {
  now(): string;
}

export interface TenantContextPolicyDependencies<Tx> {
  transactions: TenantContextPolicyTransactions<Tx>;
  commands: TenantContextPolicyCommandStore<Tx>;
  policies: TenantContextPolicyStore<Tx>;
  ids: TenantContextPolicyIds;
  clock: TenantContextPolicyClock;
  strategyVersion?: string;
}

export class TenantContextPolicyService<Tx> {
  private readonly strategyVersion: string;

  constructor(
    private readonly deps:
      TenantContextPolicyDependencies<Tx>,
  ) {
    this.strategyVersion =
      deps.strategyVersion ??
      "tenant-context-policy-v1";
    if (!this.strategyVersion) {
      throw new TypeError(
        "Tenant context policy strategyVersion is required",
      );
    }
  }

  async upsertPolicy(
    actor: ActorContext,
    command: TenantContextPolicyUpsertCommand,
  ): Promise<TenantContextPolicyUpsertResult> {
    validateUpsertCommand(command);

    const parsed =
      parseSupportedClaimProposition(
        command.proposition,
      );
    if (!parsed) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Tenant policy proposition is not a supported structured proposition",
      );
    }

    const proposition =
      storedClaimProposition(parsed);
    const now = this.validNow();
    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "context.tenant-policy.upsert",
      kind: command.kind,
      proposition,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const commandClaim =
          await this.deps.commands.claimCommand(
            tx,
            {
              actor,
              commandId: command.command_id,
              commandType:
                "context.tenant-policy.upsert",
              commandFingerprint,
              now,
            },
          );

        if (!commandClaim.claimed) {
          return replayUpsert(
            commandClaim.existing,
            actor,
            commandFingerprint,
          );
        }

        await this.requireAdministrator(
          tx,
          actor,
        );

        const authorityClass =
          command.kind === "GLOSSARY"
            ? "APPROVED_GLOSSARY"
            : "POLICY";
        const triggerKind =
          command.kind === "GLOSSARY"
            ? "APPROVED_GLOSSARY_CHANGE"
            : "TENANT_POLICY_CHANGE";
        const claimType =
          parsed.kind === "TERM_MEANING"
            ? "TERMINOLOGY"
            : "LEXICAL_PREFERENCE";
        const claimId =
          this.deps.ids.next("claim");
        if (!isUuid(claimId)) {
          throw new Error(
            "Tenant context policy claim id factory returned an invalid UUID",
          );
        }

        const superseded =
          await this.deps.policies
            .invalidateSupersededTenantClaims(
              tx,
              {
                tenantId: actor.tenantId,
                authorityClass,
                propositionRef: proposition,
                invalidatedAt: now,
              },
            );

        await this.deps.policies
          .insertTenantPolicyClaim(
            tx,
            {
              tenantId: actor.tenantId,
              claimId,
              claimType,
              propositionRef: proposition,
              authorityClass,
              triggerKind,
              createdAt: now,
            },
          );

        for (const prior of superseded) {
          const provenanceEdgeId =
            this.deps.ids.next("prov");
          if (!isUuid(provenanceEdgeId)) {
            throw new Error(
              "Tenant context policy provenance id factory returned an invalid UUID",
            );
          }
          await this.deps.policies
            .insertOverrideProvenance(
              tx,
              {
                tenantId: actor.tenantId,
                provenanceEdgeId,
                overriddenClaimId:
                  prior.claimId,
                overriddenClaimVersion:
                  prior.claimVersion,
                replacementClaimId: claimId,
                replacementClaimVersion: 1,
                strategyVersion:
                  this.strategyVersion,
                createdAt: now,
              },
            );
        }

        const tenantPolicyVersion =
          await this.deps.policies
            .bumpTenantPolicyVersion(
              tx,
              actor.tenantId,
            );

        const result:
          TenantContextPolicyUpsertResult = {
            protocol_version: 1,
            claim_id: claimId,
            claim_version: 1,
            status: "ACTIVE",
            kind: command.kind,
            tenant_policy_version:
              tenantPolicyVersion,
            superseded_claims:
              superseded.map((value) => ({
                claim_id: value.claimId,
                claim_version:
                  value.claimVersion,
              })),
          };

        await this.deps.commands
          .markCommandSucceeded(
            tx,
            {
              tenantId: actor.tenantId,
              commandId: command.command_id,
              actorUserId: actor.userId,
              actorDeviceId: actor.deviceId,
              commandType:
                "context.tenant-policy.upsert",
              commandFingerprint,
              result:
                result as unknown as Record<
                  string,
                  unknown
                >,
              now,
            },
          );

        return result;
      },
    );
  }

  async revokePolicy(
    actor: ActorContext,
    command: TenantContextPolicyRevokeCommand,
  ): Promise<TenantContextPolicyRevokeResult> {
    if (
      command.protocol_version !== 1 ||
      !isUuid(command.command_id) ||
      !isUuid(command.claim_id)
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Invalid tenant policy revocation command",
      );
    }

    const now = this.validNow();
    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "context.tenant-policy.revoke",
      claim_id: command.claim_id,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const commandClaim =
          await this.deps.commands.claimCommand(
            tx,
            {
              actor,
              commandId: command.command_id,
              commandType:
                "context.tenant-policy.revoke",
              commandFingerprint,
              now,
            },
          );

        if (!commandClaim.claimed) {
          return replayRevocation(
            commandClaim.existing,
            actor,
            commandFingerprint,
          );
        }

        await this.requireAdministrator(
          tx,
          actor,
        );

        const claim =
          await this.deps.policies
            .loadRevocableTenantClaim(
              tx,
              {
                tenantId: actor.tenantId,
                claimId: command.claim_id,
              },
            );
        if (!claim) {
          throw new DomainError(
            "INVALID_COMMAND",
            "Tenant policy claim is not active or revocable",
          );
        }

        const revoked =
          await this.deps.policies
            .revokeTenantClaim(
              tx,
              {
                tenantId: actor.tenantId,
                claimId: claim.claimId,
                claimVersion:
                  claim.claimVersion,
                revokedAt: now,
              },
            );
        if (!revoked) {
          throw new Error(
            "Tenant policy claim changed despite its mutation lock",
          );
        }

        const tenantPolicyVersion =
          await this.deps.policies
            .bumpTenantPolicyVersion(
              tx,
              actor.tenantId,
            );

        const result:
          TenantContextPolicyRevokeResult = {
            protocol_version: 1,
            claim_id: claim.claimId,
            claim_version:
              claim.claimVersion,
            status: "REVOKED",
            tenant_policy_version:
              tenantPolicyVersion,
          };

        await this.deps.commands
          .markCommandSucceeded(
            tx,
            {
              tenantId: actor.tenantId,
              commandId: command.command_id,
              actorUserId: actor.userId,
              actorDeviceId: actor.deviceId,
              commandType:
                "context.tenant-policy.revoke",
              commandFingerprint,
              result:
                result as unknown as Record<
                  string,
                  unknown
                >,
              now,
            },
          );

        return result;
      },
    );
  }

  private async requireAdministrator(
    tx: Tx,
    actor: ActorContext,
  ): Promise<void> {
    const authority =
      await this.deps.policies
        .lockTenantAuthority(tx, actor);

    if (
      !authority ||
      (
        authority.tenantRole !== "ADMIN" &&
        authority.tenantRole !== "OWNER"
      )
    ) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Tenant context policy mutation requires ADMIN or OWNER authority",
      );
    }
  }

  private validNow(): string {
    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Tenant context policy clock returned an invalid timestamp",
      );
    }
    return now;
  }
}

function validateUpsertCommand(
  command: TenantContextPolicyUpsertCommand,
): void {
  if (
    command.protocol_version !== 1 ||
    !isUuid(command.command_id) ||
    !["GLOSSARY", "POLICY"].includes(
      command.kind,
    ) ||
    !isPlainObject(command.proposition)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid tenant context policy command",
    );
  }
}

function replayUpsert(
  existing: CommandReceipt,
  actor: ActorContext,
  fingerprint: string,
): TenantContextPolicyUpsertResult {
  assertReplayIdentity(
    existing,
    actor,
    "context.tenant-policy.upsert",
    fingerprint,
  );
  const value = existing.result;
  if (
    value.protocol_version !== 1 ||
    !isUuid(value.claim_id) ||
    !Number.isInteger(value.claim_version) ||
    Number(value.claim_version) < 1 ||
    value.status !== "ACTIVE" ||
    !["GLOSSARY", "POLICY"].includes(
      String(value.kind),
    ) ||
    !Number.isInteger(
      value.tenant_policy_version,
    ) ||
    Number(value.tenant_policy_version) < 1 ||
    !Array.isArray(value.superseded_claims) ||
    value.superseded_claims.some(
      (item) =>
        !isPlainObject(item) ||
        !isUuid(item.claim_id) ||
        !Number.isInteger(
          item.claim_version,
        ) ||
        Number(item.claim_version) < 1,
    )
  ) {
    throw new Error(
      "Stored tenant context policy result is malformed",
    );
  }

  return {
    protocol_version: 1,
    claim_id: value.claim_id,
    claim_version: Number(
      value.claim_version,
    ),
    status: "ACTIVE",
    kind:
      value.kind as TenantContextPolicyKind,
    tenant_policy_version: Number(
      value.tenant_policy_version,
    ),
    superseded_claims:
      value.superseded_claims.map(
        (item) => {
          const row =
            item as Record<string, unknown>;
          return {
            claim_id:
              row.claim_id as UUID,
            claim_version: Number(
              row.claim_version,
            ),
          };
        },
      ),
  };
}

function replayRevocation(
  existing: CommandReceipt,
  actor: ActorContext,
  fingerprint: string,
): TenantContextPolicyRevokeResult {
  assertReplayIdentity(
    existing,
    actor,
    "context.tenant-policy.revoke",
    fingerprint,
  );
  const value = existing.result;
  if (
    value.protocol_version !== 1 ||
    !isUuid(value.claim_id) ||
    !Number.isInteger(value.claim_version) ||
    Number(value.claim_version) < 1 ||
    value.status !== "REVOKED" ||
    !Number.isInteger(
      value.tenant_policy_version,
    ) ||
    Number(value.tenant_policy_version) < 1
  ) {
    throw new Error(
      "Stored tenant context policy revocation result is malformed",
    );
  }

  return {
    protocol_version: 1,
    claim_id: value.claim_id,
    claim_version: Number(
      value.claim_version,
    ),
    status: "REVOKED",
    tenant_policy_version: Number(
      value.tenant_policy_version,
    ),
  };
}

function assertReplayIdentity(
  existing: CommandReceipt,
  actor: ActorContext,
  commandType: string,
  fingerprint: string,
): void {
  if (
    existing.actorUserId !== actor.userId ||
    existing.actorDeviceId !==
      actor.deviceId
  ) {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "Command identifier is not available to actor",
    );
  }
  if (
    existing.commandType !== commandType ||
    existing.commandFingerprint !==
      fingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }
  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent tenant context policy command receipt is not terminal",
    );
  }
}

function isUuid(value: unknown): value is UUID {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}
