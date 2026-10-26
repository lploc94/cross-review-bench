-- Rates are scaled integers: rate_scaled / 10^8 units of quote per one unit of base.
CREATE TABLE fx_rates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants (id),
    base         text NOT NULL REFERENCES currencies (code),
    quote        text NOT NULL REFERENCES currencies (code),
    rate_scaled  bigint NOT NULL CHECK (rate_scaled > 0),
    effective_at timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fx_rates_distinct_pair_check CHECK (base <> quote),
    CONSTRAINT fx_rates_pair_effective_key UNIQUE (tenant_id, base, quote, effective_at)
);
