-- Reference data shared by every tenant: ISO 4217 codes and their minor-unit exponents.
CREATE TABLE currencies (
    code     text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
    exponent smallint NOT NULL CHECK (exponent BETWEEN 0 AND 4),
    name     text NOT NULL
);

INSERT INTO currencies (code, exponent, name) VALUES
    ('USD', 2, 'US Dollar'),
    ('EUR', 2, 'Euro'),
    ('GBP', 2, 'Pound Sterling'),
    ('CHF', 2, 'Swiss Franc'),
    ('JPY', 0, 'Yen'),
    ('VND', 0, 'Dong'),
    ('KWD', 3, 'Kuwaiti Dinar'),
    ('BHD', 3, 'Bahraini Dinar');
