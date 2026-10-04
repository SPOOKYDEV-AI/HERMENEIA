import type {
  TranslationWorkerContextBridge,
} from "../../translation-worker/src/index.js";
import type {
  TranslationContextService,
} from "../../context-translation/src/index.js";
import type { SqlExecutor } from "../../persistence/src/index.js";

export function createTranslationWorkerContextBridge(
  context: TranslationContextService<SqlExecutor>,
): TranslationWorkerContextBridge {
  return {
    async prepare(input) {
      const prepared = await context.prepareForTranslation({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        sourceRevision: input.sourceRevision,
        recipientUserId: input.recipientUserId,
        targetLanguageTag: input.targetLanguageTag,
        targetProfileVersion: input.targetProfileVersion,
      });

      return {
        contextSnapshotId: prepared.contextSnapshotId,
        strategyVersion: prepared.strategyVersion,
      };
    },

    async resolve(input) {
      const resolved = await context.resolveForTranslation({
        tenantId: input.tenantId,
        contextSnapshotId: input.contextSnapshotId,
      });

      if (resolved.status !== "READY") {
        return { status: resolved.status };
      }

      return {
        status: "READY",
        selected: resolved.selected.map((item) => ({
          candidateId: item.candidateId,
          candidateType: item.candidateType,
          content: item.content,
          selectionReason: item.selectionReason,
        })),
      };
    },
  };
}
