CREATE TABLE holds (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants (id),
    account_id           uuid NOT NULL,
    amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
    currency             text NOT NULL REFERENCES currencies (code),
    status               text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'captured', 'voided', 'expired')),
    expires_at           timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    captured_transfer_id uuid,
    CONSTRAINT holds_tenant_id_key UNIQUE (tenant_id, id),
    CONSTRAINT holds_account_fkey FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, id),
    CONSTRAINT holds_captured_transfer_fkey FOREIGN KEY (tenant_id, captured_transfer_id)
        REFERENCES transfers (tenant_id, id)
);

CREATE INDEX holds_account_idx ON holds (tenant_id, account_id, created_at DESC);
CREATE INDEX holds_active_expiry_idx ON holds (expires_at) WHERE status = 'active';
