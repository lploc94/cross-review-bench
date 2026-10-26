CREATE TABLE transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants (id),
    from_account_id uuid NOT NULL,
    to_account_id   uuid NOT NULL,
    amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
    currency        text NOT NULL REFERENCES currencies (code),
    description     text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transfers_tenant_id_key UNIQUE (tenant_id, id),
    CONSTRAINT transfers_distinct_accounts_check CHECK (from_account_id <> to_account_id),
    CONSTRAINT transfers_from_account_fkey FOREIGN KEY (tenant_id, from_account_id)
        REFERENCES accounts (tenant_id, id),
    CONSTRAINT transfers_to_account_fkey FOREIGN KEY (tenant_id, to_account_id)
        REFERENCES accounts (tenant_id, id)
);

CREATE INDEX transfers_tenant_created_idx ON transfers (tenant_id, created_at DESC, id DESC);
CREATE INDEX transfers_from_account_idx ON transfers (tenant_id, from_account_id, created_at DESC);
CREATE INDEX transfers_to_account_idx ON transfers (tenant_id, to_account_id, created_at DESC);

-- One row per leg of a transfer. Debits are negative, credits positive; the entries of a
-- transfer sum to zero. balance_after is the account balance right after this entry.
CREATE TABLE entries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants (id),
    transfer_id   uuid NOT NULL,
    account_id    uuid NOT NULL,
    amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
    currency      text NOT NULL REFERENCES currencies (code),
    balance_after bigint NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entries_transfer_fkey FOREIGN KEY (tenant_id, transfer_id)
        REFERENCES transfers (tenant_id, id),
    CONSTRAINT entries_account_fkey FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, id)
);

CREATE INDEX entries_account_created_idx ON entries (tenant_id, account_id, created_at DESC, id DESC);
CREATE INDEX entries_transfer_idx ON entries (tenant_id, transfer_id);
