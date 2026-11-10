-- Commit enum additions before a later transaction references the new values.
SET search_path = pg_catalog, public;
ALTER TYPE protocol_status ADD VALUE IF NOT EXISTS 'active';
ALTER TYPE protocol_status ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE protocol_status ADD VALUE IF NOT EXISTS 'completed';
ALTER TYPE schedule_cancellation_type ADD VALUE IF NOT EXISTS 'treatment_override';
ALTER TYPE schedule_cancellation_type ADD VALUE IF NOT EXISTS 'treatment_completed';
