import {
  UserLanguagePreferenceService,
} from "../../user-language-preference-service/src/index.js";
import {
  PostgresUserLanguagePreferenceRepository,
} from "../../persistence-postgres/src/user-language-preferences.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export function createPostgresUserLanguagePreferenceService(
  transactions: SqlTransactionManager,
  clock: { now(): string },
): UserLanguagePreferenceService<SqlExecutor> {
  const store =
    new PostgresUserLanguagePreferenceRepository(
      transactions,
    );
  return new UserLanguagePreferenceService({
    transactions: store,
    store,
    clock,
  });
}
