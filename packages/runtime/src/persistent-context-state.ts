import type {
  PersistentContextOperationRecorder,
} from "../../messaging-service/src/index.js";
import {
  createDegradedContextStateFromFloor,
  createInitialContextState,
  rebaseContextStateAuthority,
  registerContextOperation,
} from "../../context-state/src/index.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import type {
  PostgresConversationContextStateRepository,
} from "../../persistence-postgres/src/context-state.js";
import {
  restoreContextStateFromCheckpoint,
  type RecoveryCheckpointV1,
} from "../../context-recovery/src/index.js";

export interface PostgresContextOperationRecorderDependencies {
  repository: PostgresConversationContextStateRepository;
  recoveryCheckpoints?: {
    loadValidForRestore(
      tx: SqlExecutor,
      input: {
        tenantId: string;
        conversationId: string;
        requiredProcessedPrefixOpSeq: number;
        strategyVersion: string;
        now: string;
      },
    ): Promise<RecoveryCheckpointV1 | undefined>;
  };
  strategyVersion?: string;
}

export function createPostgresContextOperationRecorder(
  deps: PostgresContextOperationRecorderDependencies,
): PersistentContextOperationRecorder<SqlExecutor> {
  const strategyVersion =
    deps.strategyVersion ?? "context-state-v1";

  if (!strategyVersion) {
    throw new TypeError(
      "ContextState strategyVersion is required",
    );
  }

  return {
    async register(tx, input) {
      const existing = await deps.repository.loadState(tx, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        forUpdate: true,
      });

      if (!existing) {
        let created;

        if (input.opSeq === 1) {
          created = createInitialContextState({
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            membershipEpoch: input.membershipEpoch,
            erasureEpoch: input.erasureEpoch,
            policyVersion: input.policyVersion,
            strategyVersion,
            now: input.registeredAt,
          });
        } else {
          const checkpoint =
            deps.recoveryCheckpoints
              ? await deps.recoveryCheckpoints.loadValidForRestore(
                  tx,
                  {
                    tenantId: input.tenantId,
                    conversationId:
                      input.conversationId,
                    requiredProcessedPrefixOpSeq:
                      input.opSeq - 1,
                    strategyVersion,
                    now: input.registeredAt,
                  },
                )
              : undefined;

          created =
            checkpoint
              ? restoreContextStateFromCheckpoint(
                  checkpoint,
                  {
                    tenantId: input.tenantId,
                    conversationId:
                      input.conversationId,
                    requiredProcessedPrefixOpSeq:
                      input.opSeq - 1,
                    strategyVersion,
                    now: input.registeredAt,
                  },
                )
              : null;

          created ??=
            createDegradedContextStateFromFloor({
              tenantId: input.tenantId,
              conversationId:
                input.conversationId,
              causalFloorOpSeq:
                input.opSeq - 1,
              membershipEpoch:
                input.membershipEpoch,
              erasureEpoch:
                input.erasureEpoch,
              policyVersion:
                input.policyVersion,
              strategyVersion,
              now: input.registeredAt,
            });
        }

        created = registerContextOperation(created, {
          opSeq: input.opSeq,
          operationId: input.operationId,
          kind: input.kind,
          messageId: input.messageId,
          sourceRevision: input.sourceRevision,
          registeredAt: input.registeredAt,
        });

        const inserted =
          await deps.repository.insertState(tx, created);
        if (!inserted) {
          throw new Error(
            "ConversationState appeared concurrently while conversation mutation was locked",
          );
        }
        return;
      }

      const expectedStateVersion = existing.stateVersion;
      let next = rebaseContextStateAuthority(existing, {
        membershipEpoch: input.membershipEpoch,
        erasureEpoch: input.erasureEpoch,
        policyVersion: input.policyVersion,
        now: input.registeredAt,
      });

      next = registerContextOperation(next, {
        opSeq: input.opSeq,
        operationId: input.operationId,
        kind: input.kind,
        messageId: input.messageId,
        sourceRevision: input.sourceRevision,
        registeredAt: input.registeredAt,
      });

      if (next.stateVersion === expectedStateVersion) {
        return;
      }

      const updated = await deps.repository.updateState(tx, {
        expectedStateVersion,
        state: next,
      });
      if (!updated) {
        throw new Error(
          "ConversationState changed despite its mutation lock",
        );
      }
    },
  };
}
