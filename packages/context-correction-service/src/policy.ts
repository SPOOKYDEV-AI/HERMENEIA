import { DomainError } from "../../domain/src/index.js";
import type {
  CorrectionCommand,
} from "../../protocol/src/index.js";
import {
  parseSupportedClaimProposition,
  storedClaimProposition,
} from "../../context-claim-candidates/src/index.js";
import type {
  CorrectionAuthority,
} from "./contracts.js";

export interface NormalisedCorrection {
  payload: Record<string, unknown>;
  canBecomeClaim: boolean;
}

export interface CorrectionPromotionDecision {
  apply: boolean;
  status:
    | "RECORDED"
    | "NEEDS_CONFIRMATION"
    | "APPLIED";
  scope: "CONVERSATION" | "TENANT" | null;
  subjectUserId: string | null;
}

export function validateCorrectionCommand(
  command: CorrectionCommand,
): void {
  if (
    command.protocol_version !== 1 ||
    !isUuid(command.command_id) ||
    !isUuid(command.conversation_id)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid correction command identity",
    );
  }

  if (
    !["MEANING", "TONE", "TERMINOLOGY"].includes(
      command.kind,
    ) ||
    !["MESSAGE", "CONVERSATION", "TENANT"].includes(
      command.requested_scope,
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid correction kind or scope",
    );
  }

  const hasMessage =
    command.target_message_id !== undefined &&
    command.target_message_id !== null;
  const hasRevision =
    command.target_source_revision !== undefined &&
    command.target_source_revision !== null;

  if (hasMessage !== hasRevision) {
    throw new DomainError(
      "INVALID_COMMAND",
      "target_message_id and target_source_revision must be provided together",
    );
  }

  if (
    hasMessage &&
    (
      !isUuid(command.target_message_id) ||
      !Number.isInteger(
        command.target_source_revision,
      ) ||
      Number(command.target_source_revision) < 1
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid target message revision",
    );
  }

  if (
    command.target_translation_id !== undefined &&
    command.target_translation_id !== null &&
    !isUuid(command.target_translation_id)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid target_translation_id",
    );
  }

  if (
    command.requested_scope === "MESSAGE" &&
    !hasMessage &&
    !command.target_translation_id
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "MESSAGE correction requires a message or translation target",
    );
  }

  if (
    !command.payload ||
    typeof command.payload !== "object" ||
    Array.isArray(command.payload)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Correction payload must be an object",
    );
  }
}

export function normaliseCorrection(
  command: CorrectionCommand,
): NormalisedCorrection {
  if (command.kind === "TONE") {
    const preferred =
      command.payload.preferred_register;
    if (
      command.payload.schema_version !== 1 ||
      command.payload.kind !== "TONE" ||
      !["NEUTRAL", "FORMAL", "INFORMAL"].includes(
        String(preferred),
      )
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "TONE correction requires schema_version=1, kind=TONE and a supported preferred_register",
      );
    }

    return {
      payload: {
        schema_version: 1,
        kind: "TONE",
        preferred_register: preferred,
      },
      canBecomeClaim: false,
    };
  }

  const proposition =
    parseSupportedClaimProposition(
      command.payload,
    );
  if (!proposition) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Correction payload is not a supported structured proposition",
    );
  }

  if (
    command.kind === "MEANING" &&
    proposition.kind !== "TERM_MEANING"
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "MEANING correction requires TERM_MEANING payload",
    );
  }

  return {
    payload:
      storedClaimProposition(proposition),
    canBecomeClaim: true,
  };
}

export function decideCorrectionPromotion(
  command: CorrectionCommand,
  authority: CorrectionAuthority,
  canBecomeClaim: boolean,
  actorUserId: string,
  targetAuthorUserId: string | null,
): CorrectionPromotionDecision {
  if (
    command.requested_scope === "MESSAGE"
  ) {
    return {
      apply: false,
      status: "RECORDED",
      scope: null,
      subjectUserId: null,
    };
  }

  if (!canBecomeClaim) {
    return {
      apply: false,
      status: "NEEDS_CONFIRMATION",
      scope: null,
      subjectUserId: null,
    };
  }

  if (
    command.requested_scope === "TENANT"
  ) {
    // Tenant-wide distribution is intentionally not implemented in V1.
    return {
      apply: false,
      status: "NEEDS_CONFIRMATION",
      scope: null,
      subjectUserId: null,
    };
  }

  if (
    targetAuthorUserId !== null &&
    targetAuthorUserId === actorUserId
  ) {
    return {
      apply: true,
      status: "APPLIED",
      scope: "CONVERSATION",
      subjectUserId: actorUserId,
    };
  }

  const elevated =
    authority.conversationRole === "MODERATOR" ||
    authority.tenantRole === "ADMIN" ||
    authority.tenantRole === "OWNER";

  return elevated
    ? {
        apply: true,
        status: "APPLIED",
        scope: "CONVERSATION",
        subjectUserId: null,
      }
    : {
        apply: false,
        status: "NEEDS_CONFIRMATION",
        scope: null,
        subjectUserId: null,
      };
}

export function correctionRepairKind(
  kind: CorrectionCommand["kind"],
):
  | "MEANING_CORRECTION"
  | "TONE_CORRECTION"
  | "TERMINOLOGY_CORRECTION" {
  if (kind === "MEANING") {
    return "MEANING_CORRECTION";
  }
  if (kind === "TONE") {
    return "TONE_CORRECTION";
  }
  return "TERMINOLOGY_CORRECTION";
}

export function isUuid(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
