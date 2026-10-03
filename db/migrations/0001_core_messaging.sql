BEGIN;

CREATE TABLE users (
  user_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  default_language_tag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('CONSUMER_SHARED','ORGANISATION')),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  home_region text NOT NULL,
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  erasure_epoch bigint NOT NULL DEFAULT 0 CHECK (erasure_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('MEMBER','ADMIN','OWNER')),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE devices (
  device_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED','LOST')),
  credential_version bigint NOT NULL CHECK (credential_version >= 1),
  public_material_ref text NOT NULL,
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  UNIQUE (device_id, user_id)
);

CREATE INDEX devices_user_status_idx
  ON devices(user_id, status);

CREATE TABLE sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  refresh_secret_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (device_id, user_id) REFERENCES devices(device_id, user_id)
);

CREATE INDEX sessions_user_status_idx
  ON sessions(user_id, status);

CREATE INDEX sessions_device_status_idx
  ON sessions(device_id, status);

CREATE INDEX sessions_expires_at_idx
  ON sessions(expires_at);

CREATE TABLE conversations (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DIRECT')),
  status text NOT NULL CHECK (status IN ('ACTIVE','CLOSED','DELETED')),
  home_region text NOT NULL,
  next_message_seq bigint NOT NULL DEFAULT 1 CHECK (next_message_seq >= 1),
  next_op_seq bigint NOT NULL DEFAULT 1 CHECK (next_op_seq >= 1),
  membership_epoch bigint NOT NULL DEFAULT 0 CHECK (membership_epoch >= 0),
  erasure_epoch bigint NOT NULL DEFAULT 0 CHECK (erasure_epoch >= 0),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE TABLE conversation_members (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('MEMBER','MODERATOR')),
  status text NOT NULL CHECK (status IN ('ACTIVE','LEFT','REMOVED','BLOCKED')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  target_language_tag text,
  target_locale_override text,
  read_message_seq bigint NOT NULL DEFAULT 0 CHECK (read_message_seq >= 0),
  membership_version bigint NOT NULL DEFAULT 1 CHECK (membership_version >= 1),
  PRIMARY KEY (tenant_id, conversation_id, user_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE INDEX conversation_members_user_idx
  ON conversation_members(tenant_id, user_id, status);

CREATE TABLE message_metadata (
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  author_device_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  message_seq bigint NOT NULL CHECK (message_seq >= 1),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  status text NOT NULL CHECK (status IN ('ACTIVE','DELETED')),
  reply_to_message_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  client_authored_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, message_id),
  UNIQUE (tenant_id, conversation_id, message_id),
  UNIQUE (tenant_id, conversation_id, message_seq),
  UNIQUE (tenant_id, author_user_id, client_message_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id, author_user_id)
    REFERENCES conversation_members(tenant_id, conversation_id, user_id),
  FOREIGN KEY (author_device_id, author_user_id)
    REFERENCES devices(device_id, user_id),
  FOREIGN KEY (tenant_id, conversation_id, reply_to_message_id)
    REFERENCES message_metadata(tenant_id, conversation_id, message_id)
);

CREATE INDEX message_metadata_conversation_seq_idx
  ON message_metadata(tenant_id, conversation_id, message_seq);

CREATE INDEX message_metadata_author_accepted_idx
  ON message_metadata(tenant_id, author_user_id, accepted_at DESC);

CREATE TABLE message_revisions (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  op_seq bigint NOT NULL CHECK (op_seq >= 1),
  mutation_type text NOT NULL CHECK (mutation_type IN ('CREATED','EDITED','DELETED')),
  actor_user_id uuid NOT NULL,
  source_hash text,
  declared_source_language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, revision),
  UNIQUE (tenant_id, conversation_id, op_seq),
  FOREIGN KEY (tenant_id, conversation_id, message_id)
    REFERENCES message_metadata(tenant_id, conversation_id, message_id),
  FOREIGN KEY (tenant_id, conversation_id, actor_user_id)
    REFERENCES conversation_members(tenant_id, conversation_id, user_id)
);

CREATE INDEX message_revisions_message_idx
  ON message_revisions(tenant_id, message_id, revision DESC);

CREATE TABLE command_receipts (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_device_id uuid NOT NULL,
  command_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  result_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (actor_device_id, actor_user_id)
    REFERENCES devices(device_id, user_id)
);

CREATE INDEX command_receipts_actor_created_idx
  ON command_receipts(tenant_id, actor_user_id, created_at DESC);

CREATE TABLE device_sync_states (
  device_id uuid PRIMARY KEY,
  inbox_epoch bigint NOT NULL DEFAULT 1 CHECK (inbox_epoch >= 1),
  next_offset bigint NOT NULL DEFAULT 1 CHECK (next_offset >= 1),
  last_acked_offset bigint NOT NULL DEFAULT 0 CHECK (last_acked_offset >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE TABLE delivery_envelopes (
  tenant_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  translation_id uuid,
  recipient_user_id uuid NOT NULL,
  recipient_device_id uuid NOT NULL,
  recipient_credential_version bigint NOT NULL CHECK (recipient_credential_version >= 1),
  rendition_type text NOT NULL CHECK (rendition_type IN ('ORIGINAL','TRANSLATION')),
  protected_payload bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','ACKED','EXPIRED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  acked_at timestamptz,
  PRIMARY KEY (tenant_id, envelope_id),
  UNIQUE (tenant_id, envelope_id, recipient_device_id),
  FOREIGN KEY (tenant_id, conversation_id, message_id)
    REFERENCES message_metadata(tenant_id, conversation_id, message_id),
  FOREIGN KEY (tenant_id, message_id, source_revision)
    REFERENCES message_revisions(tenant_id, message_id, revision),
  FOREIGN KEY (tenant_id, conversation_id, recipient_user_id)
    REFERENCES conversation_members(tenant_id, conversation_id, user_id),
  FOREIGN KEY (recipient_device_id, recipient_user_id)
    REFERENCES devices(device_id, user_id),
  CHECK (expires_at > created_at),
  CHECK (
    (rendition_type = 'ORIGINAL' AND translation_id IS NULL)
    OR
    (rendition_type = 'TRANSLATION' AND translation_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX delivery_original_per_device_idx
  ON delivery_envelopes(
    tenant_id,
    message_id,
    source_revision,
    recipient_device_id,
    recipient_credential_version
  )
  WHERE rendition_type = 'ORIGINAL';

CREATE INDEX delivery_pending_device_idx
  ON delivery_envelopes(recipient_device_id, status, created_at);

CREATE INDEX delivery_expiry_idx
  ON delivery_envelopes(status, expires_at)
  WHERE status = 'PENDING';

CREATE TABLE device_inbox_events (
  device_id uuid NOT NULL,
  inbox_epoch bigint NOT NULL CHECK (inbox_epoch >= 1),
  offset_value bigint NOT NULL CHECK (offset_value >= 1),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('message.available')),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (device_id, inbox_epoch, offset_value),
  FOREIGN KEY (device_id) REFERENCES devices(device_id),
  FOREIGN KEY (tenant_id, envelope_id, device_id)
    REFERENCES delivery_envelopes(tenant_id, envelope_id, recipient_device_id)
);

CREATE INDEX device_inbox_events_event_time_idx
  ON device_inbox_events(device_id, inbox_epoch, created_at);

CREATE TABLE outbox_jobs (
  job_id uuid PRIMARY KEY,
  tenant_id uuid,
  job_type text NOT NULL,
  business_key text NOT NULL,
  payload_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority smallint NOT NULL DEFAULT 100,
  status text NOT NULL CHECK (status IN ('AVAILABLE','LEASED','DONE','DEAD')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_type, business_key)
);

CREATE INDEX outbox_jobs_available_idx
  ON outbox_jobs(priority, available_at)
  WHERE status = 'AVAILABLE';

COMMIT;
