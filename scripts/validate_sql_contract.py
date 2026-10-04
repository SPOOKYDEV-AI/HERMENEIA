#!/usr/bin/env python3
"""Static contract validation for the PostgreSQL core migration.

This does not replace executing the migration against PostgreSQL. It guards the
architectural invariants that can be checked without a server.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/0001_core_messaging.sql"
SESSION_MIGRATION = ROOT / "db/migrations/0002_session_access_credential.sql"
RUNTIME_MIGRATION = ROOT / "db/migrations/0003_runtime_alignment.sql"
COMMAND_MIGRATION = ROOT / "db/migrations/0004_command_fingerprint.sql"
TENANT_SYNC_MIGRATION = ROOT / "db/migrations/0005_tenant_device_sync_state.sql"
OUTBOX_LIFECYCLE_MIGRATION = ROOT / "db/migrations/0006_outbox_superseded.sql"
OUTBOX_LEASE_MIGRATION = ROOT / "db/migrations/0007_outbox_lease_shape.sql"

REQUIRED_TABLES = {
    "users",
    "tenants",
    "tenant_memberships",
    "devices",
    "sessions",
    "conversations",
    "conversation_members",
    "message_metadata",
    "message_revisions",
    "command_receipts",
    "device_sync_states",
    "delivery_envelopes",
    "device_inbox_events",
    "outbox_jobs",
}

FORBIDDEN_PLAINTEXT_COLUMNS = {
    "message_text",
    "source_text",
    "translated_text",
    "translation_text",
    "prompt_text",
    "conversation_history",
    "raw_history",
    "plaintext",
}

REQUIRED_SNIPPETS = [
    "UNIQUE (tenant_id, conversation_id, message_seq)",
    "UNIQUE (tenant_id, author_user_id, client_message_id)",
    "UNIQUE (tenant_id, conversation_id, op_seq)",
    "PRIMARY KEY (device_id, inbox_epoch, offset_value)",
    "FOREIGN KEY (tenant_id, envelope_id, device_id)",
    "WHERE rendition_type = 'ORIGINAL'",
    "WHERE status = 'AVAILABLE'",
    "protected_payload bytea NOT NULL",
    "UNIQUE (tenant_id, job_type, business_key)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)",
]


def fail(message: str) -> None:
    raise SystemExit(f"SQL_CONTRACT_FAIL: {message}")


def main() -> int:
    sql = MIGRATION.read_text(encoding="utf-8")
    session_sql = SESSION_MIGRATION.read_text(encoding="utf-8")
    runtime_sql = RUNTIME_MIGRATION.read_text(encoding="utf-8")
    command_sql = COMMAND_MIGRATION.read_text(encoding="utf-8")
    tenant_sync_sql = TENANT_SYNC_MIGRATION.read_text(encoding="utf-8")
    outbox_lifecycle_sql = OUTBOX_LIFECYCLE_MIGRATION.read_text(encoding="utf-8")
    outbox_lease_sql = OUTBOX_LEASE_MIGRATION.read_text(encoding="utf-8")
    upper = sql.upper()

    if not upper.lstrip().startswith("BEGIN;"):
        fail("migration must begin with an explicit transaction")
    if not upper.rstrip().endswith("COMMIT;"):
        fail("migration must end with COMMIT")

    tables = set(
        re.findall(r"CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)", sql, flags=re.I)
    )
    missing = sorted(REQUIRED_TABLES - tables)
    if missing:
        fail(f"missing required tables: {', '.join(missing)}")

    lowered = sql.lower()
    for column in sorted(FORBIDDEN_PLAINTEXT_COLUMNS):
        if re.search(rf"\b{re.escape(column)}\b", lowered):
            fail(f"forbidden durable plaintext column/token present: {column}")

    for snippet in REQUIRED_SNIPPETS:
        if snippet not in sql:
            fail(f"required invariant snippet missing: {snippet}")

    # Structural multi-tenant sanity: business tables should carry tenant_id.
    tenant_scoped = {
        "tenant_memberships",
        "conversations",
        "conversation_members",
        "message_metadata",
        "message_revisions",
        "command_receipts",
        "delivery_envelopes",
        "device_inbox_events",
    }
    for table in tenant_scoped:
        match = re.search(
            rf"CREATE\s+TABLE\s+{table}\s*\((.*?)\n\);",
            sql,
            flags=re.I | re.S,
        )
        if not match:
            fail(f"could not inspect table body for {table}")
        if not re.search(r"\btenant_id\s+uuid\b", match.group(1), flags=re.I):
            fail(f"{table} is expected to be explicitly tenant-scoped")

    if "access_credential_ref text" not in session_sql:
        fail("session migration must add access_credential_ref")
    if "WHERE access_credential_ref IS NOT NULL" not in session_sql:
        fail("session access credential reference must use a partial unique index")
    if "access_token" in session_sql.lower() or "bearer_token" in session_sql.lower():
        fail("session migration must not store bearer/access token plaintext")

    runtime_required = [
        "ADD COLUMN tenant_id uuid",
        "FOREIGN KEY (tenant_id, user_id)",
        "REFERENCES tenant_memberships(tenant_id, user_id)",
        "ALTER COLUMN envelope_id DROP NOT NULL",
        "'message.edited'",
        "'message.deleted'",
        "device_inbox_events_envelope_shape_check",
    ]
    for snippet in runtime_required:
        if snippet not in runtime_sql:
            fail(f"runtime alignment migration missing invariant: {snippet}")

    if not runtime_sql.lstrip().startswith("BEGIN;"):
        fail("runtime alignment migration must begin with BEGIN")
    if not runtime_sql.rstrip().endswith("COMMIT;"):
        fail("runtime alignment migration must end with COMMIT")

    command_required = [
        "ADD COLUMN command_fingerprint text",
        "command_receipts_actor_status_idx",
        "command_receipts_message_result_idx",
        "result_ref->>'message_id'",
        "WHERE command_type = 'message.send'",
        "AND status = 'SUCCEEDED'",
    ]
    for snippet in command_required:
        if snippet not in command_sql:
            fail(f"command migration missing invariant: {snippet}")

    if not command_sql.lstrip().startswith("BEGIN;"):
        fail("command migration must begin with BEGIN")
    if not command_sql.rstrip().endswith("COMMIT;"):
        fail("command migration must end with COMMIT")

    tenant_sync_required = [
        "CREATE TABLE tenant_device_sync_states",
        "PRIMARY KEY (tenant_id, device_id)",
        "last_acked_offset bigint NOT NULL DEFAULT 0",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)",
        "FOREIGN KEY (device_id) REFERENCES devices(device_id)",
    ]
    for snippet in tenant_sync_required:
        if snippet not in tenant_sync_sql:
            fail(f"tenant sync migration missing invariant: {snippet}")

    if not tenant_sync_sql.lstrip().startswith("BEGIN;"):
        fail("tenant sync migration must begin with BEGIN")
    if not tenant_sync_sql.rstrip().endswith("COMMIT;"):
        fail("tenant sync migration must end with COMMIT")

    outbox_required = [
        "outbox_jobs_status_check",
        "'SUPERSEDED'",
        "outbox_jobs_message_revision_idx",
        "payload_ref->>'message_id'",
        "payload_ref->>'source_revision'",
        "WHERE job_type = 'translation.request'",
    ]
    for snippet in outbox_required:
        if snippet not in outbox_lifecycle_sql:
            fail(f"outbox lifecycle migration missing invariant: {snippet}")

    if not outbox_lifecycle_sql.lstrip().startswith("BEGIN;"):
        fail("outbox lifecycle migration must begin with BEGIN")
    if not outbox_lifecycle_sql.rstrip().endswith("COMMIT;"):
        fail("outbox lifecycle migration must end with COMMIT")

    outbox_lease_required = [
        "outbox_jobs_lifecycle_shape_check",
        "status = 'AVAILABLE'",
        "status = 'LEASED'",
        "status IN ('DONE','DEAD','SUPERSEDED')",
        "lease_until IS NOT NULL",
        "completed_at IS NOT NULL",
    ]
    for snippet in outbox_lease_required:
        if snippet not in outbox_lease_sql:
            fail(f"outbox lease migration missing invariant: {snippet}")

    if not outbox_lease_sql.lstrip().startswith("BEGIN;"):
        fail("outbox lease migration must begin with BEGIN")
    if not outbox_lease_sql.rstrip().endswith("COMMIT;"):
        fail("outbox lease migration must end with COMMIT")

    command_lower = command_sql.lower()
    for forbidden in (
        "source_text",
        "message_text",
        "translated_text",
        "prompt_text",
        "plaintext",
        "bearer_token",
        "access_token",
    ):
        if forbidden in command_lower:
            fail(f"command migration contains forbidden token: {forbidden}")

    print(
        "SQL_CONTRACT_PASS "
        f"tables={len(tables)} required={len(REQUIRED_TABLES)} "
        "plaintext_columns=0"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
