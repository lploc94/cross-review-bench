CREATE TABLE jobs (
    id           bigserial   PRIMARY KEY,
    queue        text        NOT NULL,
    type         text        NOT NULL,
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    priority     integer     NOT NULL DEFAULT 0,
    state        text        NOT NULL DEFAULT 'available',
    attempts     integer     NOT NULL DEFAULT 0,
    max_attempts integer     NOT NULL DEFAULT 5,
    run_at       timestamptz NOT NULL,
    locked_by    text,
    locked_until timestamptz,
    last_error   text,
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    finished_at  timestamptz,

    CONSTRAINT jobs_state_check CHECK (state IN ('available', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
    CONSTRAINT jobs_attempts_check CHECK (attempts >= 0 AND max_attempts >= 1),
    CONSTRAINT jobs_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
    -- A running job always has an owner and a lease deadline; no other job has either.
    CONSTRAINT jobs_lock_check CHECK (
        (state = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL)
    )
);

-- Leasing: the next available jobs of a queue, in the order workers take them.
CREATE INDEX jobs_lease_idx ON jobs (queue, priority DESC, run_at, id) WHERE state = 'available';

-- Reaping: running jobs whose lease has expired.
CREATE INDEX jobs_running_locked_until_idx ON jobs (locked_until) WHERE state = 'running';

-- Listing with keyset pagination by id, filtered by queue and/or state.
CREATE INDEX jobs_queue_id_idx ON jobs (queue, id);
CREATE INDEX jobs_state_id_idx ON jobs (state, id);
