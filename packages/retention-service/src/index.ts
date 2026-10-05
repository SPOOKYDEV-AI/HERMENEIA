export interface RetentionClock {
  now(): string;
}

export interface PersistentRetentionStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  expireDeliveryEnvelopesBatch(
    tx: Tx,
    input: {
      now: string;
      limit: number;
    },
  ): Promise<number>;
}

export interface TransientRetentionStore {
  purgeExpired(): number | Promise<number>;
}

export interface PersistentRetentionServiceOptions {
  batchSize?: number;
}

export class PersistentRetentionService<Tx> {
  private readonly batchSize: number;

  constructor(
    private readonly store: PersistentRetentionStore<Tx>,
    private readonly transientSources: TransientRetentionStore,
    private readonly clock: RetentionClock,
    options: PersistentRetentionServiceOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 500;
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 10_000
    ) {
      throw new TypeError(
        "retention batchSize must be an integer between 1 and 10000",
      );
    }
  }

  async runOnce(): Promise<{
    purgedTransientSources: number;
    expiredDeliveryEnvelopes: number;
  }> {
    const now = this.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new Error("Clock returned an invalid timestamp");
    }

    const purgedTransientSources = Number(
      await this.transientSources.purgeExpired(),
    );

    const expiredDeliveryEnvelopes =
      await this.store.withTransaction((tx) =>
        this.store.expireDeliveryEnvelopesBatch(tx, {
          now,
          limit: this.batchSize,
        }),
      );

    return {
      purgedTransientSources,
      expiredDeliveryEnvelopes,
    };
  }
}
