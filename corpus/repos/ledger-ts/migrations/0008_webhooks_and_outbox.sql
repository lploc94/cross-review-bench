CREATE TABLE webhook_endpoints (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id),
    url        text NOT NULL,
    secret     text NOT NULL,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id) WHERE active;

-- Transactional outbox: events are written in the same transaction as the change they
-- describe and delivered to the tenant's webhook endpoints by the outbox dispatcher.
CREATE TABLE outbox (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants (id),
    aggregate_id    uuid NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    last_error      text
);

CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, id) WHERE delivered_at IS NULL;
CREATE INDEX outbox_aggregate_pending_idx ON outbox (tenant_id, aggregate_id, id) WHERE delivered_at IS NULL;
