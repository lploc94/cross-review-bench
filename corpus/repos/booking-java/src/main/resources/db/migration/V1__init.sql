CREATE TABLE property (
    id                        BIGSERIAL PRIMARY KEY,
    code                      VARCHAR(40)  NOT NULL UNIQUE,
    name                      VARCHAR(120) NOT NULL,
    time_zone                 VARCHAR(64)  NOT NULL,
    check_in_time             TIME         NOT NULL,
    check_out_time            TIME         NOT NULL,
    currency                  VARCHAR(3)      NOT NULL,
    full_refund_days          INTEGER      NOT NULL CHECK (full_refund_days >= 0),
    partial_refund_percent    INTEGER      NOT NULL CHECK (partial_refund_percent BETWEEN 0 AND 100),
    weekend_surcharge_percent INTEGER      NOT NULL CHECK (weekend_surcharge_percent BETWEEN 0 AND 100),
    los_min_nights            INTEGER      NOT NULL CHECK (los_min_nights >= 1),
    los_discount_percent      INTEGER      NOT NULL CHECK (los_discount_percent BETWEEN 0 AND 100)
);

CREATE TABLE room_type (
    id                BIGSERIAL PRIMARY KEY,
    property_id       BIGINT        NOT NULL REFERENCES property (id),
    code              VARCHAR(40)   NOT NULL,
    name              VARCHAR(120)  NOT NULL,
    capacity          INTEGER       NOT NULL CHECK (capacity >= 1),
    base_nightly_rate NUMERIC(12, 2) NOT NULL CHECK (base_nightly_rate >= 0),
    extra_guest_fee   NUMERIC(12, 2) NOT NULL CHECK (extra_guest_fee >= 0),
    UNIQUE (property_id, code)
);

CREATE TABLE seasonal_rate (
    id           BIGSERIAL PRIMARY KEY,
    room_type_id BIGINT        NOT NULL REFERENCES room_type (id),
    start_date   DATE          NOT NULL,
    end_date     DATE          NOT NULL,
    nightly_rate NUMERIC(12, 2) NOT NULL CHECK (nightly_rate >= 0),
    priority     INTEGER       NOT NULL DEFAULT 0,
    CHECK (end_date >= start_date)
);
CREATE INDEX seasonal_rate_room_type_dates ON seasonal_rate (room_type_id, start_date, end_date);

CREATE TABLE inventory (
    id           BIGSERIAL PRIMARY KEY,
    room_type_id BIGINT  NOT NULL REFERENCES room_type (id),
    night        DATE    NOT NULL,
    total        INTEGER NOT NULL CHECK (total >= 0),
    held         INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
    booked       INTEGER NOT NULL DEFAULT 0 CHECK (booked >= 0),
    version      BIGINT  NOT NULL DEFAULT 0,
    UNIQUE (room_type_id, night),
    CHECK (held + booked <= total)
);

CREATE TABLE hold (
    id           UUID PRIMARY KEY,
    property_id  BIGINT       NOT NULL REFERENCES property (id),
    room_type_id BIGINT       NOT NULL REFERENCES room_type (id),
    check_in     DATE         NOT NULL,
    check_out    DATE         NOT NULL,
    rooms        INTEGER      NOT NULL CHECK (rooms >= 1),
    guests       INTEGER      NOT NULL CHECK (guests >= 1),
    guest_name   VARCHAR(120) NOT NULL,
    guest_email  VARCHAR(254) NOT NULL,
    guest_phone  VARCHAR(32),
    status       VARCHAR(16)  NOT NULL CHECK (status IN ('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
    currency     VARCHAR(3)      NOT NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    expires_at   TIMESTAMPTZ  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL,
    version      BIGINT       NOT NULL DEFAULT 0,
    CHECK (check_out > check_in)
);
CREATE INDEX hold_status_expiry ON hold (status, expires_at);

CREATE TABLE hold_price_line (
    hold_id     UUID REFERENCES hold (id) ON DELETE CASCADE,
    position    INTEGER      NOT NULL,
    kind        VARCHAR(32)  NOT NULL,
    night       DATE,
    description VARCHAR(160) NOT NULL,
    amount      NUMERIC(12, 2) NOT NULL,
    PRIMARY KEY (hold_id, position)
);

CREATE TABLE reservation (
    id           BIGSERIAL PRIMARY KEY,
    reference    VARCHAR(16)  NOT NULL UNIQUE,
    hold_id      UUID         NOT NULL UNIQUE REFERENCES hold (id),
    property_id  BIGINT       NOT NULL REFERENCES property (id),
    room_type_id BIGINT       NOT NULL REFERENCES room_type (id),
    check_in     DATE         NOT NULL,
    check_out    DATE         NOT NULL,
    rooms        INTEGER      NOT NULL CHECK (rooms >= 1),
    guests       INTEGER      NOT NULL CHECK (guests >= 1),
    status       VARCHAR(16)  NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED')),
    guest_name   VARCHAR(120) NOT NULL,
    guest_email  VARCHAR(254) NOT NULL,
    guest_phone  VARCHAR(32),
    currency     VARCHAR(3)      NOT NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL,
    updated_at   TIMESTAMPTZ  NOT NULL,
    cancelled_at TIMESTAMPTZ,
    version      BIGINT       NOT NULL DEFAULT 0,
    CHECK (check_out > check_in)
);
CREATE INDEX reservation_status_check_in ON reservation (status, check_in, id);
CREATE INDEX reservation_guest_email ON reservation (guest_email);

CREATE TABLE reservation_price_line (
    reservation_id BIGINT REFERENCES reservation (id) ON DELETE CASCADE,
    position       INTEGER      NOT NULL,
    kind           VARCHAR(32)  NOT NULL,
    night          DATE,
    description    VARCHAR(160) NOT NULL,
    amount         NUMERIC(12, 2) NOT NULL,
    PRIMARY KEY (reservation_id, position)
);

CREATE TABLE ledger_entry (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT       NOT NULL REFERENCES reservation (id),
    kind              VARCHAR(16)  NOT NULL CHECK (kind IN ('CHARGE', 'REFUND')),
    amount            NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    currency          VARCHAR(3)      NOT NULL,
    reason            VARCHAR(120) NOT NULL,
    gateway_reference VARCHAR(120) NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL
);
CREATE INDEX ledger_entry_reservation ON ledger_entry (reservation_id, id);
