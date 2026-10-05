import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";

export type PreferredRegister =
  | "NEUTRAL"
  | "FORMAL"
  | "INFORMAL";

export interface UserLanguagePreferenceCommand {
  target_language: string;
  target_locale?: string | null;
  preferred_register?: PreferredRegister | null;
}

export interface UserLanguagePreferenceRecord {
  tenantId: UUID;
  userId: UUID;
  targetLanguageTag: string;
  targetLocaleOverride: string | null;
  preferredRegister: PreferredRegister | null;
  preferenceVersion: number;
  updatedAt: string;
}

export interface UserLanguagePreferenceResult {
  changed: boolean;
  preference_version: number;
  target_profile_updates: number;
}

export interface UserLanguagePreferenceTransactions<Tx> {
  withTransaction<T>(
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;
}

export interface UserLanguagePreferenceStore<Tx> {
  lockActiveActor(
    tx: Tx,
    actor: ActorContext,
  ): Promise<boolean>;

  loadForUpdate(
    tx: Tx,
    input: {
      tenantId: UUID;
      userId: UUID;
    },
  ): Promise<UserLanguagePreferenceRecord | undefined>;

  write(
    tx: Tx,
    input: UserLanguagePreferenceRecord,
  ): Promise<void>;

  bumpActiveMembershipProfiles(
    tx: Tx,
    input: {
      tenantId: UUID;
      userId: UUID;
    },
  ): Promise<number>;
}

export interface UserLanguagePreferenceClock {
  now(): string;
}

export interface UserLanguagePreferenceDependencies<Tx> {
  transactions:
    UserLanguagePreferenceTransactions<Tx>;
  store: UserLanguagePreferenceStore<Tx>;
  clock: UserLanguagePreferenceClock;
}

export class UserLanguagePreferenceService<Tx> {
  constructor(
    private readonly deps:
      UserLanguagePreferenceDependencies<Tx>,
  ) {}

  async update(
    actor: ActorContext,
    command: UserLanguagePreferenceCommand,
  ): Promise<UserLanguagePreferenceResult> {
    const normalized =
      normalizePreferenceCommand(command);
    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Language preference clock returned an invalid timestamp",
      );
    }

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const authorized =
          await this.deps.store.lockActiveActor(
            tx,
            actor,
          );
        if (!authorized) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Language preferences are not available to actor",
          );
        }

        const existing =
          await this.deps.store.loadForUpdate(
            tx,
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
            },
          );

        if (
          existing &&
          sameLanguageTag(
            existing.targetLanguageTag,
            normalized.targetLanguageTag,
          ) &&
          sameNullableLanguageTag(
            existing.targetLocaleOverride,
            normalized.targetLocaleOverride,
          ) &&
          existing.preferredRegister ===
            normalized.preferredRegister
        ) {
          return {
            changed: false,
            preference_version:
              existing.preferenceVersion,
            target_profile_updates: 0,
          };
        }

        const preferenceVersion =
          (existing?.preferenceVersion ?? 0) + 1;

        await this.deps.store.write(
          tx,
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            targetLanguageTag:
              normalized.targetLanguageTag,
            targetLocaleOverride:
              normalized.targetLocaleOverride,
            preferredRegister:
              normalized.preferredRegister,
            preferenceVersion,
            updatedAt: now,
          },
        );

        const targetProfileUpdates =
          await this.deps.store
            .bumpActiveMembershipProfiles(
              tx,
              {
                tenantId: actor.tenantId,
                userId: actor.userId,
              },
            );

        return {
          changed: true,
          preference_version:
            preferenceVersion,
          target_profile_updates:
            targetProfileUpdates,
        };
      },
    );
  }
}

function normalizePreferenceCommand(
  command: UserLanguagePreferenceCommand,
): {
  targetLanguageTag: string;
  targetLocaleOverride: string | null;
  preferredRegister: PreferredRegister | null;
} {
  if (
    !command ||
    typeof command !== "object"
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid language preference payload",
    );
  }

  const targetLanguageTag =
    normalizeLanguageTag(
      command.target_language,
      "target_language",
    );

  const targetLocaleOverride =
    command.target_locale === undefined ||
    command.target_locale === null
      ? null
      : normalizeLanguageTag(
          command.target_locale,
          "target_locale",
        );

  const preferredRegister =
    command.preferred_register === undefined ||
    command.preferred_register === null
      ? null
      : command.preferred_register;

  if (
    preferredRegister !== null &&
    ![
      "NEUTRAL",
      "FORMAL",
      "INFORMAL",
    ].includes(preferredRegister)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "preferred_register is unsupported",
    );
  }

  return {
    targetLanguageTag,
    targetLocaleOverride,
    preferredRegister,
  };
}

function normalizeLanguageTag(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length > 64
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      `${field} must be a bounded language tag`,
    );
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(
      trimmed,
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      `${field} must be a valid language tag`,
    );
  }
  return trimmed;
}

function sameLanguageTag(
  left: string,
  right: string,
): boolean {
  return (
    left.trim().toLowerCase() ===
    right.trim().toLowerCase()
  );
}

function sameNullableLanguageTag(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameLanguageTag(left, right);
}
