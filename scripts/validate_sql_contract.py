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

    print(
        "SQL_CONTRACT_PASS "
        f"tables={len(tables)} required={len(REQUIRED_TABLES)} "
        "plaintext_columns=0"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
