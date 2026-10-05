import { DomainError } from "../../domain/src/index.js";
import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  CorrectionResult,
  CorrectionRevocationResult,
  CorrectionReviewResult,
  CorrectionScope,
} from "../../protocol/src/index.js";
import {
  isUuid,
} from "./policy.js";

export function replayCorrectionCommand(
  existing: {
    actorUserId: UUID;
    actorDeviceId: UUID;
    commandType: string;
    commandFingerprint: string | null;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result: Record<string, unknown>;
  },
  actor: ActorContext,
  commandFingerprint: string,
): CorrectionResult {
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
    existing.commandType !== "context.correction" ||
    existing.commandFingerprint !==
      commandFingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }

  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent correction command receipt is not terminal",
    );
  }

  return correctionResultFromRecord(
    existing.result,
  );
}

function correctionResultFromRecord(
  value: Record<string, unknown>,
): CorrectionResult {
  const status = value.status;
  const requestedScope =
    value.requested_scope;
  const appliedScope = value.applied_scope;

  if (
    value.protocol_version !== 1 ||
    !isUuid(value.repair_event_id) ||
    !["RECORDED", "NEEDS_CONFIRMATION", "APPLIED"].includes(
      String(status),
    ) ||
    !["MESSAGE", "CONVERSATION", "TENANT"].includes(
      String(requestedScope),
    ) ||
    !(
      appliedScope === null ||
      appliedScope === "CONVERSATION" ||
      appliedScope === "TENANT"
    ) ||
    !(
      value.claim_id === null ||
      isUuid(value.claim_id)
    ) ||
    !(
      value.claim_version === null ||
      (
        Number.isInteger(value.claim_version) &&
        Number(value.claim_version) >= 1
      )
    )
  ) {
    throw new Error(
      "Stored correction result is malformed",
    );
  }

  return {
    protocol_version: 1,
    repair_event_id:
      value.repair_event_id,
    status:
      status as CorrectionResult["status"],
    requested_scope:
      requestedScope as CorrectionScope,
    applied_scope:
      appliedScope as CorrectionResult["applied_scope"],
    claim_id:
      value.claim_id as UUID | null,
    claim_version:
      value.claim_version as number | null,
  };
}


export function replayCorrectionRevocationCommand(
  existing: {
    actorUserId: UUID;
    actorDeviceId: UUID;
    commandType: string;
    commandFingerprint: string | null;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result: Record<string, unknown>;
  },
  actor: ActorContext,
  commandFingerprint: string,
): CorrectionRevocationResult {
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
    existing.commandType !==
      "context.correction.revoke" ||
    existing.commandFingerprint !==
      commandFingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }

  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent correction revocation command receipt is not terminal",
    );
  }

  const value = existing.result;
  if (
    value.protocol_version !== 1 ||
    !isUuid(value.repair_event_id) ||
    !isUuid(value.claim_id) ||
    !Number.isInteger(value.claim_version) ||
    Number(value.claim_version) < 1 ||
    value.status !== "REVOKED"
  ) {
    throw new Error(
      "Stored correction revocation result is malformed",
    );
  }

  return {
    protocol_version: 1,
    repair_event_id: value.repair_event_id,
    claim_id: value.claim_id,
    claim_version: Number(value.claim_version),
    status: "REVOKED",
  };
}


export function replayCorrectionReviewCommand(
  existing: {
    actorUserId: UUID;
    actorDeviceId: UUID;
    commandType: string;
    commandFingerprint: string | null;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result: Record<string, unknown>;
  },
  actor: ActorContext,
  commandFingerprint: string,
): CorrectionReviewResult {
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
    existing.commandType !==
      "context.correction.review" ||
    existing.commandFingerprint !==
      commandFingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }

  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent correction review command receipt is not terminal",
    );
  }

  const value = existing.result;
  const status = String(value.status);
  if (
    value.protocol_version !== 1 ||
    !isUuid(value.repair_event_id) ||
    !isUuid(value.review_event_id) ||
    !["APPLIED", "REJECTED"].includes(status) ||
    (
      value.claim_id !== null &&
      !isUuid(value.claim_id)
    ) ||
    (
      value.claim_version !== null &&
      (
        !Number.isInteger(value.claim_version) ||
        Number(value.claim_version) < 1
      )
    ) ||
    (
      (value.claim_id === null) !==
      (value.claim_version === null)
    )
  ) {
    throw new Error(
      "Stored correction review result is malformed",
    );
  }

  return {
    protocol_version: 1,
    repair_event_id: value.repair_event_id,
    review_event_id: value.review_event_id,
    status:
      status as CorrectionReviewResult["status"],
    claim_id:
      value.claim_id as UUID | null,
    claim_version:
      value.claim_version === null
        ? null
        : Number(value.claim_version),
  };
}
