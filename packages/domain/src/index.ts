export type UUID = string;

export type TranslationStatus =
  | "NOT_REQUESTED"
  | "PENDING"
  | "READY"
  | "FAILED"
  | "SOURCE_REQUIRED"
  | "EXPIRED"
  | "SUPERSEDED";

export type DeliveryEnvelopeStatus = "PENDING" | "ACKED" | "EXPIRED" | "REVOKED";

export type DomainErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_AUTHORIZED"
  | "DEVICE_REVOKED"
  | "INVALID_COMMAND"
  | "DELIVERY_EXPIRED";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export interface ActorContext {
  tenantId: UUID;
  userId: UUID;
  deviceId: UUID;
}

export interface MessageMetadata {
  tenantId: UUID;
  messageId: UUID;
  conversationId: UUID;
  authorUserId: UUID;
  authorDeviceId: UUID;
  clientMessageId: UUID;
  messageSeq: number;
  currentRevision: number;
  status: "ACTIVE" | "DELETED";
  acceptedAt: string;
}

export interface AcceptedMessage {
  protocol_version: 1;
  status: "ACCEPTED";
  message_id: UUID;
  message_seq: number;
  source_revision: number;
  accepted_at: string;
  translation_status: TranslationStatus;
}

export interface DeliveryEnvelope {
  tenantId: UUID;
  envelopeId: UUID;
  conversationId: UUID;
  messageId: UUID;
  sourceRevision: number;
  recipientUserId: UUID;
  recipientDeviceId: UUID;
  renditionType: "ORIGINAL" | "TRANSLATION";
  protectedPayload: string;
  status: DeliveryEnvelopeStatus;
  createdAt: string;
  expiresAt: string;
  ackedAt?: string;
}

export interface DeviceInboxEvent {
  deviceId: UUID;
  inboxEpoch: number;
  offset: number;
  eventId: UUID;
  type: "message.available";
  tenantId: UUID;
  conversationId: UUID;
  messageId: UUID;
  envelopeId: UUID;
  createdAt: string;
}

export interface TranslationJob {
  jobId: UUID;
  messageId: UUID;
  sourceRevision: number;
  status: "AVAILABLE";
  createdAt: string;
}
