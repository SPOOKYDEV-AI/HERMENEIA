BEGIN;

INSERT INTO context_claims(
  tenant_id,
  claim_id,
  claim_version,
  conversation_id,
  message_id,
  subject_user_id,
  claim_type,
  proposition_ref,
  modality,
  authority_class,
  retention_class,
  sensitivity_class,
  confidence,
  scope_kind,
  scope_conversation_id,
  trigger_kind,
  valid_from,
  valid_until,
  status
)
SELECT
  c.tenant_id,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  1,
  c.conversation_id,
  NULL,
  cm.user_id,
  'STYLE',
  '{"schema_version":1,"kind":"STYLE_PREFERENCE","preferred_register":"FORMAL"}'::jsonb,
  'ASSERTION',
  'EXPLICIT_PREFERENCE',
  'PREFERENCE_REFERENCE',
  'NORMAL',
  1,
  'CONVERSATION',
  c.conversation_id,
  'EXPLICIT_STYLE_PREFERENCE',
  now() - interval '1 second',
  NULL,
  'ACTIVE'
FROM conversations c
JOIN conversation_members cm
  ON cm.tenant_id = c.tenant_id
 AND cm.conversation_id = c.conversation_id
LIMIT 1;

DO $preference_claim$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM context_claims
     WHERE claim_id =
       'f1000000-0000-4000-8000-000000000001'::uuid
       AND retention_class = 'PREFERENCE_REFERENCE'
       AND authority_class = 'EXPLICIT_PREFERENCE'
  ) THEN
    RAISE EXCEPTION
      'PREFERENCE_REFERENCE explicit style claim was not accepted';
  END IF;
END
$preference_claim$;

ROLLBACK;
