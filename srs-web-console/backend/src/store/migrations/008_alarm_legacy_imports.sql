-- Original documents remain available for auditing and operator reconfirmation.
CREATE TABLE alarm_trigger_legacy_imports (
 trigger_id TEXT PRIMARY KEY,
 source_version INTEGER NOT NULL,
 original_document JSONB NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('converted','review')),
 reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
