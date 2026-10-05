import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import type {
  TranslationFeedbackCommand,
  TranslationFeedbackKind,
  TranslationFeedbackResult,
} from "../../protocol/src/index.js";
import type {
  PersistentCommandClaimResult,
} from "../../messaging-service/src/index.js";

export interface TranslationFeedbackTransactions<Tx> {
  withTransaction<T>(
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;
}

export interface TranslationFeedbackCommandStore<Tx> {
  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<PersistentCommandClaimResult>;

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

export interface TranslationFeedbackStore<Tx> {
  loadEligibleTranslation(
    tx: Tx,
    input: {
      actor: ActorContext;
      translationId: UUID;
    },
  ): Promise<{
    conversationId: UUID;
    messageId: UUID;
    sourceRevision: number;
  } | undefined>;

  insertFeedbackRepairEvent(
    tx: Tx,
    input: {
      tenantId: UUID;
      repairEventId: UUID;
      conversationId: UUID;
      actorUserId: UUID;
      targetTranslationId: UUID;
      targetMessageId: UUID;
      targetSourceRevision: number;
      kind:
        | "PROBLEM_REPORT"
        | "MEANING_CORRECTION"
        | "TONE_CORRECTION"
        | "TERMINOLOGY_CORRECTION";
      status: "RECORDED" | "NEEDS_CONFIRMATION";
      structuredPayload: Record<string, unknown>;
      commandId: UUID;
      createdAt: string;
    },
  ): Promise<void>;
}

export interface TranslationFeedbackFingerprinter {
  fingerprint(input: {
    text: string;
    language_hint?: string;
  }): string;
  matches(
    input: {
      text: string;
      language_hint?: string;
    },
    storedFingerprint: string,
  ): boolean;
}

export interface TranslationFeedbackDependencies<Tx> {
  transactions: TranslationFeedbackTransactions<Tx>;
  commands: TranslationFeedbackCommandStore<Tx>;
  feedbacks: TranslationFeedbackStore<Tx>;
  ids: {
    next(prefix: string): UUID;
  };
  clock: {
    now(): string;
  };
  noteFingerprinter: TranslationFeedbackFingerprinter;
}

interface NormalisedFeedback {
  note: string | null;
  noteFingerprint: string | null;
}

export class TranslationFeedbackService<Tx> {
  constructor(
    private readonly deps: TranslationFeedbackDependencies<Tx>,
  ) {}

  async createFeedback(
    actor: ActorContext,
    command: TranslationFeedbackCommand,
  ): Promise<TranslationFeedbackResult> {
    validateFeedbackCommand(command);
    const normalised = normaliseFeedback(
      command,
      this.deps.noteFingerprinter,
    );
    const now = this.deps.clock.now();

    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Translation feedback clock returned an invalid timestamp",
      );
    }

    const commandFingerprint = feedbackFingerprint({
      command,
      noteFingerprint:
        normalised.noteFingerprint,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const claim =
          await this.deps.commands.claimCommand(
            tx,
            {
              actor,
              commandId: command.command_id,
              commandType:
                "translation.feedback",
              commandFingerprint,
              now,
            },
          );

        if (!claim.claimed) {
          return replayFeedback(
            claim.existing,
            actor,
            command,
            normalised.note,
            this.deps.noteFingerprinter,
          );
        }

        const target =
          await this.deps.feedbacks.loadEligibleTranslation(
            tx,
            {
              actor,
              translationId:
                command.translation_id,
            },
          );

        if (!target) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Translation is not available for feedback",
          );
        }

        const status = feedbackStatus(
          command.kind,
        );
        const repairEventId =
          this.deps.ids.next("repair");

        await this.deps.feedbacks.insertFeedbackRepairEvent(
          tx,
          {
            tenantId: actor.tenantId,
            repairEventId,
            conversationId:
              target.conversationId,
            actorUserId: actor.userId,
            targetTranslationId:
              command.translation_id,
            targetMessageId: target.messageId,
            targetSourceRevision:
              target.sourceRevision,
            kind: feedbackRepairKind(
              command.kind,
            ),
            status,
            structuredPayload: {
              schema_version: 1,
              feedback_kind: command.kind,
              note_present:
                normalised.note !== null,
              note_length:
                normalised.note?.length ?? 0,
            },
            commandId: command.command_id,
            createdAt: now,
          },
        );

        const result: TranslationFeedbackResult = {
          protocol_version: 1,
          repair_event_id: repairEventId,
          status,
        };

        await this.deps.commands.markCommandSucceeded(
          tx,
          {
            tenantId: actor.tenantId,
            commandId: command.command_id,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandType:
              "translation.feedback",
            commandFingerprint,
            result:
              result as unknown as Record<string, unknown>,
            now,
          },
        );

        return result;
      },
    );
  }
}

function validateFeedbackCommand(
  command: TranslationFeedbackCommand,
): void {
  if (
    command.protocol_version !== 1 ||
    !isUuid(command.command_id) ||
    !isUuid(command.translation_id)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid translation feedback identity",
    );
  }

  if (
    ![
      "PROBLEM",
      "WRONG_MEANING",
      "WRONG_TONE",
      "TERMINOLOGY",
      "OTHER",
    ].includes(command.kind)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid translation feedback kind",
    );
  }

  if (
    command.note !== undefined &&
    (
      typeof command.note !== "string" ||
      command.note.length > 2048
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Feedback note must be at most 2048 characters",
    );
  }
}

function normaliseFeedback(
  command: TranslationFeedbackCommand,
  fingerprinter: TranslationFeedbackFingerprinter,
): NormalisedFeedback {
  const trimmed =
    command.note?.trim() ?? "";
  if (!trimmed) {
    return {
      note: null,
      noteFingerprint: null,
    };
  }

  const source = {
    text: trimmed,
    language_hint:
      "feedback-note-v1",
  };

  return {
    note: trimmed,
    noteFingerprint:
      fingerprinter.fingerprint(source),
  };
}

function feedbackFingerprint(input: {
  command: TranslationFeedbackCommand;
  noteFingerprint: string | null;
}): string {
  return JSON.stringify({
    v: 1,
    type: "translation.feedback",
    translation_id:
      input.command.translation_id,
    kind: input.command.kind,
    note_fingerprint:
      input.noteFingerprint,
  });
}

function replayFeedback(
  existing: {
    actorUserId: UUID;
    actorDeviceId: UUID;
    commandType: string;
    commandFingerprint: string | null;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result: Record<string, unknown>;
  },
  actor: ActorContext,
  command: TranslationFeedbackCommand,
  note: string | null,
  fingerprinter: TranslationFeedbackFingerprinter,
): TranslationFeedbackResult {
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
      "translation.feedback" ||
    !feedbackFingerprintMatches(
      existing.commandFingerprint,
      command,
      note,
      fingerprinter,
    )
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }

  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent feedback command receipt is not terminal",
    );
  }

  return feedbackResultFromRecord(
    existing.result,
  );
}

function feedbackFingerprintMatches(
  stored: string | null,
  command: TranslationFeedbackCommand,
  note: string | null,
  fingerprinter: TranslationFeedbackFingerprinter,
): boolean {
  if (!stored) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return false;
  }

  const value =
    parsed as Record<string, unknown>;

  if (
    value.v !== 1 ||
    value.type !== "translation.feedback" ||
    value.translation_id !==
      command.translation_id ||
    value.kind !== command.kind
  ) {
    return false;
  }

  const storedNote =
    value.note_fingerprint;

  if (note === null) {
    return storedNote === null;
  }

  return (
    typeof storedNote === "string" &&
    fingerprinter.matches(
      {
        text: note,
        language_hint:
          "feedback-note-v1",
      },
      storedNote,
    )
  );
}

function feedbackRepairKind(
  kind: TranslationFeedbackKind,
):
  | "PROBLEM_REPORT"
  | "MEANING_CORRECTION"
  | "TONE_CORRECTION"
  | "TERMINOLOGY_CORRECTION" {
  if (kind === "WRONG_MEANING") {
    return "MEANING_CORRECTION";
  }
  if (kind === "WRONG_TONE") {
    return "TONE_CORRECTION";
  }
  if (kind === "TERMINOLOGY") {
    return "TERMINOLOGY_CORRECTION";
  }
  return "PROBLEM_REPORT";
}

function feedbackStatus(
  kind: TranslationFeedbackKind,
): "RECORDED" | "NEEDS_CONFIRMATION" {
  return (
    kind === "PROBLEM" ||
    kind === "OTHER"
  )
    ? "RECORDED"
    : "NEEDS_CONFIRMATION";
}

function feedbackResultFromRecord(
  value: Record<string, unknown>,
): TranslationFeedbackResult {
  if (
    value.protocol_version !== 1 ||
    !isUuid(value.repair_event_id) ||
    ![
      "RECORDED",
      "NEEDS_CONFIRMATION",
    ].includes(String(value.status))
  ) {
    throw new Error(
      "Stored translation feedback result is malformed",
    );
  }

  return {
    protocol_version: 1,
    repair_event_id:
      value.repair_event_id as UUID,
    status:
      value.status as TranslationFeedbackResult["status"],
  };
}

function isUuid(value: unknown): value is UUID {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
