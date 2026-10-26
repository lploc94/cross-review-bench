CREATE TABLE accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants (id),
    name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    currency      text NOT NULL REFERENCES currencies (code),
    kind          text NOT NULL CHECK (kind IN ('wallet', 'system')),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    balance_minor bigint NOT NULL DEFAULT 0,
    held_minor    bigint NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accounts_tenant_id_key UNIQUE (tenant_id, id),
    -- Wallets never go below zero available; system accounts (funding, settlement) may.
    CONSTRAINT accounts_wallet_available_check CHECK (kind = 'system' OR balance_minor >= held_minor)
);

CREATE INDEX accounts_tenant_created_idx ON accounts (tenant_id, created_at DESC, id DESC);
