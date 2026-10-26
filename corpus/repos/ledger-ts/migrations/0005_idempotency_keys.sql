CREATE TABLE idempotency_keys (
    tenant_id       uuid NOT NULL REFERENCES tenants (id),
    key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
    request_hash    text NOT NULL,
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);
