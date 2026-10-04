import type { UUID } from "../../domain/src/index.js";

export interface SourceContent {
  text: string;
  language_hint?: string;
}

export interface SendMessageCommand {
  protocol_version: 1;
  command_id: UUID;
  client_message_id: UUID;
  conversation_id: UUID;
  source: SourceContent;
  reply_to_message_id?: UUID | null;
  client_authored_at?: string | null;
}


export interface AcceptedMessageResponse {
  protocol_version: 1;
  status: "ACCEPTED";
  message_id: UUID;
  message_seq: number;
  source_revision: number;
  accepted_at: string;
  translation_status:
    | "NOT_REQUESTED"
    | "PENDING"
    | "READY"
    | "FAILED"
    | "SOURCE_REQUIRED"
    | "EXPIRED"
    | "SUPERSEDED";
}

export interface ServerEvent {
  protocol_version: 1;
  event_id: UUID;
  cursor: string;
  type:
    | "message.accepted"
    | "message.available"
    | "message.edited"
    | "message.deleted"
    | "translation.pending"
    | "translation.ready"
    | "translation.failed"
    | "translation.source_required"
    | "translation.expired"
    | "delivery.expired"
    | "membership.changed"
    | "preferences.changed"
    | "device.revoked"
    | "sync.reset_required";
  server_time: string;
  tenant_id?: UUID;
  conversation_id?: UUID | null;
  payload: Record<string, unknown>;
}

export interface SyncResponse {
  protocol_version: 1;
  events: ServerEvent[];
  next_cursor: string;
}

export interface DeliveryAckInput {
  envelope_id: UUID;
  persisted_at: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  details?: Record<string, unknown>;
}


export interface EditMessageCommand {
  protocol_version: 1;
  command_id: UUID;
  message_id: UUID;
  expected_revision: number;
  source: SourceContent;
}

export interface DeleteMessageCommand {
  protocol_version: 1;
  command_id: UUID;
  message_id: UUID;
  expected_revision: number;
}


export interface MessageRevisionResult {
  message_id: UUID;
  revision: number;
  op_seq: number;
  status: "ACTIVE" | "DELETED";
}


export interface SourceResupplyCommand {
  protocol_version: 1;
  command_id: UUID;
  translation_id: UUID;
  message_id: UUID;
  source_revision: number;
  source_ref: string;
  source: SourceContent;
}

export interface TranslationRecoveryResult {
  protocol_version: 1;
  translation_id: UUID;
  status: "PENDING" | "SOURCE_REQUIRED" | "READY" | "FAILED" | "SUPERSEDED";
}
