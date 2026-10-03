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
