import type { UUID } from "../../domain/src/index.js";
import type { SourceContent } from "../../protocol/src/index.js";

export interface TransientSourceKey {
  tenantId: UUID;
  messageId: UUID;
  sourceRevision: number;
}

export interface TransientSourceRecord extends TransientSourceKey {
  sourceHash: string;
  source: SourceContent;
  createdAt: string;
  expiresAt: string;
}

export interface TransientSourceStore {
  put(record: TransientSourceRecord): boolean | Promise<boolean>;
  get(key: TransientSourceKey): TransientSourceRecord | undefined | Promise<TransientSourceRecord | undefined>;
  remove(key: TransientSourceKey): void | Promise<void>;
}

export interface TransientSourceClock {
  now(): string;
}

export interface InMemoryTransientSourceStoreOptions {
  clock: TransientSourceClock;
  maxEntries?: number;
  maxApproxBytes?: number;
}

interface StoredRecord {
  record: TransientSourceRecord;
  approxBytes: number;
}

export class InMemoryTransientSourceStore implements TransientSourceStore {
  private readonly records = new Map<string, StoredRecord>();
  private approxBytes = 0;
  private readonly maxEntries: number;
  private readonly maxApproxBytes: number;

  constructor(private readonly options: InMemoryTransientSourceStoreOptions) {
    this.maxEntries = options.maxEntries ?? 1_000;
    this.maxApproxBytes = options.maxApproxBytes ?? 8 * 1024 * 1024;
  }

  put(record: TransientSourceRecord): boolean {
    this.pruneExpired();

    if (Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
      return false;
    }

    const key = keyOf(record);
    const approxBytes = approximateBytes(record.source);
    const previous = this.records.get(key);
    if (previous) {
      return false;
    }

    const nextEntries = this.records.size + 1;
    const nextBytes = this.approxBytes + approxBytes;

    if (
      nextEntries > this.maxEntries ||
      nextBytes > this.maxApproxBytes
    ) {
      return false;
    }

    this.records.set(key, {
      record: structuredClone(record),
      approxBytes,
    });
    this.approxBytes += approxBytes;
    return true;
  }

  get(key: TransientSourceKey): TransientSourceRecord | undefined {
    this.pruneExpired();
    const stored = this.records.get(keyOf(key));
    return stored ? structuredClone(stored.record) : undefined;
  }

  remove(key: TransientSourceKey): void {
    const stringKey = keyOf(key);
    const stored = this.records.get(stringKey);
    if (!stored) return;
    this.records.delete(stringKey);
    this.approxBytes -= stored.approxBytes;
  }

  purgeExpired(): number {
    return this.pruneExpired();
  }

  get size(): number {
    this.pruneExpired();
    return this.records.size;
  }

  get approximateByteSize(): number {
    this.pruneExpired();
    return this.approxBytes;
  }

  private pruneExpired(): number {
    const now = Date.parse(this.options.clock.now());
    let purged = 0;
    for (const [key, stored] of this.records.entries()) {
      if (Date.parse(stored.record.expiresAt) <= now) {
        this.records.delete(key);
        this.approxBytes -= stored.approxBytes;
        purged += 1;
      }
    }
    return purged;
  }
}

function keyOf(key: TransientSourceKey): string {
  return [
    key.tenantId,
    key.messageId,
    key.sourceRevision,
  ].join(":");
}

function approximateBytes(source: SourceContent): number {
  // Conservative UTF-16-ish upper estimate without a platform-specific Buffer.
  return (
    source.text.length * 2 +
    (source.language_hint?.length ?? 0) * 2 +
    64
  );
}
