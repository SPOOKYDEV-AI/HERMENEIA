BEGIN;

DROP TABLE IF EXISTS outbox_jobs;
DROP TABLE IF EXISTS device_inbox_events;
DROP TABLE IF EXISTS delivery_envelopes;
DROP TABLE IF EXISTS device_sync_states;
DROP TABLE IF EXISTS command_receipts;
DROP TABLE IF EXISTS message_revisions;
DROP TABLE IF EXISTS message_metadata;
DROP TABLE IF EXISTS conversation_members;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS tenant_memberships;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS users;

COMMIT;
