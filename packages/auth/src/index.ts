import type { ActorContext, UUID } from "../../domain/src/index.js";

export type SessionStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface SessionRecord {
  sessionId: UUID;
  tenantId: UUID;
  userId: UUID;
  deviceId: UUID;
  accessCredentialRef: string;
  status: SessionStatus;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface SessionClock {
  now(): string;
}

export interface SessionCredentialIndex {
  put(reference: string, sessionId: UUID): void;
  get(reference: string): UUID | undefined;
  delete(reference: string): void;
}

export interface SessionRegistryDependencies {
  clock: SessionClock;
  credentials: SessionCredentialIndex;
}

export class InMemorySessionRegistry {
  private readonly byId = new Map<UUID, SessionRecord>();

  constructor(private readonly deps: SessionRegistryDependencies) {}

  registerSession(record: SessionRecord): void {
    if (record.status !== "ACTIVE") {
      throw new Error("New sessions must start ACTIVE");
    }
    if (Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)) {
      throw new Error("Session expiry must be after issuance");
    }
    this.byId.set(record.sessionId, { ...record });
    this.deps.credentials.put(record.accessCredentialRef, record.sessionId);
  }

  authenticateCredential(reference: string): ActorContext | null {
    const sessionId = this.deps.credentials.get(reference);
    if (!sessionId) return null;

    const session = this.byId.get(sessionId);
    if (!session || session.status !== "ACTIVE") return null;

    if (Date.parse(this.deps.clock.now()) >= Date.parse(session.expiresAt)) {
      session.status = "EXPIRED";
      this.deps.credentials.delete(session.accessCredentialRef);
      return null;
    }

    return {
      tenantId: session.tenantId,
      userId: session.userId,
      deviceId: session.deviceId,
    };
  }

  revokeSession(sessionId: UUID): void {
    const session = this.byId.get(sessionId);
    if (!session || session.status !== "ACTIVE") return;
    session.status = "REVOKED";
    session.revokedAt = this.deps.clock.now();
    this.deps.credentials.delete(session.accessCredentialRef);
  }

  revokeDeviceSessions(deviceId: UUID): number {
    let count = 0;
    for (const session of this.byId.values()) {
      if (session.deviceId === deviceId && session.status === "ACTIVE") {
        this.revokeSession(session.sessionId);
        count += 1;
      }
    }
    return count;
  }

  getSessionRecord(sessionId: UUID): SessionRecord | undefined {
    const session = this.byId.get(sessionId);
    return session ? { ...session } : undefined;
  }
}

export class InMemorySessionCredentialIndex implements SessionCredentialIndex {
  private readonly index = new Map<string, UUID>();
  put(reference: string, sessionId: UUID): void { this.index.set(reference, sessionId); }
  get(reference: string): UUID | undefined { return this.index.get(reference); }
  delete(reference: string): void { this.index.delete(reference); }
}
