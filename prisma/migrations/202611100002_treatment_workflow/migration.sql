-- Existing V1 prescriptions are retained without guessing treatment dates or clinical outcomes.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('smartshrimp-treatment-20261110'));

ALTER TABLE protocols ADD COLUMN IF NOT EXISTS treatment_start_at TIMESTAMPTZ;
ALTER TABLE protocol_items ADD COLUMN IF NOT EXISTS due_at_minutes INTEGER;
ALTER TABLE production_protocol_template_items ADD COLUMN IF NOT EXISTS due_at_minutes INTEGER;
ALTER TABLE protocol_status_history ADD COLUMN IF NOT EXISTS event_type VARCHAR(40) NOT NULL DEFAULT 'STATUS_CHANGED';
ALTER TABLE protocol_status_history ADD COLUMN IF NOT EXISTS event_data JSONB;
ALTER TABLE disease_cases ADD COLUMN IF NOT EXISTS resolution_reason VARCHAR(40);
ALTER TABLE disease_case_responses ADD COLUMN IF NOT EXISTS reply_to_response_id UUID;
ALTER TABLE disease_case_responses ADD COLUMN IF NOT EXISTS request_status VARCHAR(16);
ALTER TABLE protocol_status_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE disease_case_status_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE operation_schedules DROP CONSTRAINT IF EXISTS operation_schedules_check1;
ALTER TABLE operation_schedules ADD CONSTRAINT operation_schedules_check1 CHECK (
    status='cancelled' AND cancellation_type IS NOT NULL AND nullif(trim(cancellation_reason),'') IS NOT NULL
        AND cancelled_at IS NOT NULL AND (cancelled_by IS NOT NULL
            OR cancellation_type IN ('protocol_superseded','treatment_override','treatment_completed'))
    OR status<>'cancelled' AND cancellation_type IS NULL AND cancellation_reason IS NULL
        AND cancelled_by IS NULL AND cancelled_at IS NULL);

ALTER TABLE protocols DROP CONSTRAINT IF EXISTS protocols_check2;
ALTER TABLE protocols ADD CONSTRAINT protocols_check2 CHECK (
    (protocol_type='production' AND disease_case_id IS NULL AND allowed_variance_pct BETWEEN 0 AND 100 AND allowed_variance_pct IS NOT NULL)
    OR (protocol_type='treatment' AND disease_case_id IS NOT NULL AND (
        content_version=1 AND allowed_variance_pct IS NULL
        OR allowed_variance_pct IS NOT NULL AND allowed_variance_pct BETWEEN 0 AND 100)));
ALTER TABLE protocols DROP CONSTRAINT IF EXISTS protocols_check3;
ALTER TABLE protocols ADD CONSTRAINT protocols_check3 CHECK (
    status IN ('draft','cancelled') OR submitted_at IS NOT NULL);
ALTER TABLE protocols DROP CONSTRAINT IF EXISTS protocols_check4;
ALTER TABLE protocols ADD CONSTRAINT protocols_check4 CHECK (
    status NOT IN ('approved','active','paused','completed','rejected','superseded','aborted')
    OR reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL);
ALTER TABLE protocols DROP CONSTRAINT IF EXISTS protocols_production_storage_check;
ALTER TABLE protocols ADD CONSTRAINT protocols_production_storage_check CHECK (COALESCE(
    content_version IN (1,2)
    AND (source_template_version_no IS NULL)=(source_template_snapshot IS NULL)
    AND (source_template_version_no IS NULL OR source_template_version_no>=1 AND jsonb_typeof(source_template_snapshot)='object')
    AND (content_version=1 AND production_structure IS NULL AND source_template_snapshot IS NULL
        OR content_version=2 AND production_structure IS NOT NULL AND production_protocol_structure_valid(production_structure)),false));
ALTER TABLE protocols ADD CONSTRAINT protocols_treatment_workflow_check CHECK (
    (status<>'paused' OR protocol_type='production')
    AND (protocol_type<>'treatment' OR content_version=1 OR rolling_window_days=3
        AND (status IN ('draft','rejected','cancelled') OR treatment_start_at IS NOT NULL)));
CREATE UNIQUE INDEX uq_one_active_protocol ON protocols(season_id) WHERE status='active';
-- A resumed production slot gets a new row; the overridden cancellation remains immutable.
ALTER TABLE operation_schedules DROP CONSTRAINT IF EXISTS operation_schedules_protocol_item_id_scheduled_at_key;
CREATE UNIQUE INDEX uq_operation_schedule_live_occurrence
    ON operation_schedules(protocol_item_id,scheduled_at) WHERE status<>'cancelled';
CREATE UNIQUE INDEX uq_treatment_work_in_progress ON protocols(disease_case_id)
    WHERE protocol_type='treatment' AND content_version=2 AND status IN ('draft','rejected','pending_approval');
CREATE INDEX idx_protocols_treatment_start ON protocols(treatment_start_at) WHERE protocol_type='treatment' AND status='approved';
CREATE INDEX idx_protocol_history_events ON protocol_status_history(protocol_id,event_type,changed_at);

ALTER TABLE protocol_items ADD CONSTRAINT protocol_items_due_minutes_check CHECK (due_at_minutes IS NULL OR due_at_minutes>=0);
ALTER TABLE production_protocol_template_items ADD CONSTRAINT template_items_due_minutes_check CHECK (due_at_minutes IS NULL OR due_at_minutes>=0);
-- The cross-table trigger below applies the DOC30 gate using the actual season age for treatment.
ALTER TABLE protocol_items DROP CONSTRAINT IF EXISTS protocol_items_production_dose_rule_check;
ALTER TABLE protocol_items ADD CONSTRAINT protocol_items_production_dose_rule_check CHECK (
    dose_basis='fixed_quantity'
    OR operation_type IN ('medicine','mineral','chemical') AND dose_basis='per_m3_water'
    OR operation_type IN ('feeding','medicine','mineral') AND dose_basis IN ('percent_biomass','per_kg_biomass'));

ALTER TABLE protocol_status_history DROP CONSTRAINT IF EXISTS protocol_status_history_check;
ALTER TABLE protocol_status_history ADD CONSTRAINT protocol_history_event_check CHECK (
    event_type IN ('STATUS_CHANGED','SUBMITTED','ACTIVATED','COURSE_COMPLETED','SEASON_ENDED','SEASON_CANCELLED',
        'WITHDRAWN','ABORTED','SUPERSEDED','HOLD_SET','HOLD_RELEASED')
    AND (event_data IS NULL OR jsonb_typeof(event_data)='object')
    AND (from_status IS NULL OR from_status<>to_status OR event_type IN ('SUBMITTED','HOLD_SET','HOLD_RELEASED')));
CREATE UNIQUE INDEX uq_case_response_identity ON disease_case_responses(id,case_id);
ALTER TABLE disease_case_responses ADD CONSTRAINT case_response_reply_same_case_fk
    FOREIGN KEY(reply_to_response_id,case_id) REFERENCES disease_case_responses(id,case_id) ON DELETE RESTRICT;
ALTER TABLE disease_case_responses ADD CONSTRAINT case_response_request_state_check CHECK (
    reply_to_response_id IS DISTINCT FROM id
    AND (request_status IS NULL OR response_type='request_info' AND request_status IN ('OPEN','ANSWERED','CANCELLED')));
CREATE INDEX idx_case_response_request ON disease_case_responses(case_id,request_status) WHERE response_type='request_info';
CREATE INDEX idx_case_response_reply ON disease_case_responses(reply_to_response_id) WHERE reply_to_response_id IS NOT NULL;
ALTER TABLE disease_cases ADD CONSTRAINT disease_case_resolution_reason_check CHECK (
    resolution_reason IS NULL OR status='resolved' AND resolution_reason IN ('EXPERT_CONCLUDED','SEASON_ENDED','SEASON_CANCELLED'));
ALTER TABLE production_protocol_template_items DROP CONSTRAINT IF EXISTS template_daily_increment_check;
ALTER TABLE production_protocol_template_items ADD CONSTRAINT template_daily_increment_check CHECK (
    daily_dose_increment>=0 AND (daily_dose_increment=0 OR operation_type='feeding'
    AND dose_basis='fixed_quantity' AND meal_number IS NOT NULL AND dose_unit IN ('kg','g') AND repeat_interval_days=1)
    AND dose_value+daily_dose_increment*(end_day_of_culture-start_day_of_culture)<=9999999999);

CREATE OR REPLACE FUNCTION public.validate_production_protocol_storage()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, public AS $function$
DECLARE p public.protocols%ROWTYPE; i public.protocol_items%ROWTYPE; st jsonb; meal jsonb;
    pid uuid; item_id uuid; stock_date date; first_doc integer;
BEGIN
    IF TG_TABLE_NAME='protocols' THEN pid:=NEW.id; ELSE pid:=NEW.protocol_id; item_id:=NEW.id; END IF;
    SELECT * INTO p FROM public.protocols WHERE id=pid FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT stocking_date INTO stock_date FROM public.aquaculture_seasons WHERE id=p.season_id;
    FOR i IN SELECT * FROM public.protocol_items WHERE protocol_id=pid AND (item_id IS NULL OR id=item_id) LOOP
        IF p.content_version=1 THEN
            IF i.production_meal_id IS NOT NULL THEN RAISE EXCEPTION 'V1 item cannot contain V2 metadata' USING ERRCODE='23514'; END IF;
            CONTINUE;
        END IF;
        IF i.production_meal_id IS NULL THEN RAISE EXCEPTION 'V2 item metadata missing' USING ERRCODE='23514'; END IF;
        SELECT s.value,m.value INTO st,meal FROM jsonb_array_elements(p.production_structure->'stages') s
            CROSS JOIN LATERAL jsonb_array_elements(s.value->'meals') m WHERE (m.value->>'id')::uuid=i.production_meal_id;
        IF NOT FOUND OR i.start_day_offset<(st->>'startDayOfCulture')::integer OR i.end_day_offset>(st->>'endDayOfCulture')::integer
            OR i.meal_number IS DISTINCT FROM (meal->>'mealNumber')::integer
            OR i.planned_time IS DISTINCT FROM (meal->>'plannedTime')::time THEN
            RAISE EXCEPTION 'V2 item window or meal mismatch' USING ERRCODE='23514';
        END IF;
        first_doc:=CASE WHEN p.protocol_type='production' THEN i.start_day_offset
            WHEN p.treatment_start_at IS NOT NULL AND stock_date IS NOT NULL
            THEN (p.treatment_start_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-stock_date+i.start_day_offset
            ELSE NULL END;
        IF i.operation_type='feeding' AND i.meal_number IS NULL
            OR i.operation_type='chemical' AND i.meal_number IS NOT NULL
            OR i.dose_basis='per_m3_water' AND i.meal_number IS NOT NULL
            OR i.dose_basis IN ('percent_biomass','per_kg_biomass') AND (i.meal_number IS NULL OR first_doc IS NULL OR first_doc<30)
            OR i.operation_type='other' AND i.dose_basis<>'fixed_quantity'
            OR i.dose_basis='percent_biomass' AND (i.dose_value>100 OR i.dose_unit NOT IN ('kg','g')) THEN
            RAISE EXCEPTION 'V2 route or dose mismatch' USING ERRCODE='23514';
        END IF;
        IF i.daily_dose_increment>0 AND (i.operation_type<>'feeding' OR i.meal_number IS NULL
            OR i.dose_basis<>'fixed_quantity' OR i.repeat_interval_days<>1 OR i.dose_unit NOT IN ('kg','g')) THEN
            RAISE EXCEPTION 'V2 increment mismatch' USING ERRCODE='23514'; END IF;
        IF i.dose_value+i.daily_dose_increment*(i.end_day_offset-i.dose_anchor_day)>9999999999 THEN
            RAISE EXCEPTION 'V2 final dose overflow' USING ERRCODE='23514'; END IF;
        IF p.status IN ('approved','active','paused','completed','superseded','aborted')
            AND (i.product_id IS NULL OR i.material_snapshot IS NULL) THEN
            RAISE EXCEPTION 'Approved V2 item lacks selected material snapshot' USING ERRCODE='23514'; END IF;
        IF p.protocol_type='treatment' AND p.status NOT IN ('draft','rejected','cancelled')
            AND (i.due_at_minutes IS NULL OR i.planned_time IS NULL
                OR i.start_day_offset=1 AND i.planned_time<(p.treatment_start_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time) THEN
            RAISE EXCEPTION 'Treatment occurrence lacks a valid execution window' USING ERRCODE='23514'; END IF;
    END LOOP;
    RETURN NULL;
END $function$;
COMMIT;
