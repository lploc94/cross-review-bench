CREATE TABLE schedules (
    name        text        PRIMARY KEY,
    spec        text        NOT NULL,
    queue       text        NOT NULL,
    type        text        NOT NULL,
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    enabled     boolean     NOT NULL DEFAULT true,
    next_run_at timestamptz NOT NULL,
    last_run_at timestamptz,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT schedules_payload_object_check CHECK (jsonb_typeof(payload) = 'object')
);

-- The scheduler loop claims enabled schedules that are due.
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;
