CREATE TABLE app_user (
    id           BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    email        VARCHAR(254) NOT NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    admin        BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE TABLE user_group (
    id   BIGSERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE group_member (
    group_id BIGINT NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
    user_id  BIGINT NOT NULL REFERENCES app_user (id),
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE api_token (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES app_user (id),
    prefix      VARCHAR(8)  NOT NULL UNIQUE,
    secret_hash VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ
);

CREATE TABLE workflow_definition (
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(80)  NOT NULL,
    version      INTEGER      NOT NULL CHECK (version >= 1),
    published    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL,
    published_at TIMESTAMPTZ,
    UNIQUE (name, version),
    CHECK (published = (published_at IS NOT NULL))
);

CREATE TABLE step_definition (
    id            BIGSERIAL PRIMARY KEY,
    definition_id BIGINT      NOT NULL REFERENCES workflow_definition (id) ON DELETE CASCADE,
    step_order    INTEGER     NOT NULL CHECK (step_order >= 1),
    kind          VARCHAR(16) NOT NULL CHECK (kind IN ('SINGLE', 'ANY_OF', 'ALL_OF', 'QUORUM')),
    assignee_id   BIGINT REFERENCES app_user (id),
    group_id      BIGINT REFERENCES user_group (id),
    quorum        INTEGER     NOT NULL DEFAULT 0 CHECK (quorum >= 0),
    sla_minutes   INTEGER     NOT NULL CHECK (sla_minutes >= 1),
    CHECK (
        (kind = 'SINGLE' AND assignee_id IS NOT NULL AND group_id IS NULL AND quorum = 0)
        OR (kind = 'QUORUM' AND group_id IS NOT NULL AND assignee_id IS NULL AND quorum >= 1)
        OR (kind IN ('ANY_OF', 'ALL_OF') AND group_id IS NOT NULL AND assignee_id IS NULL AND quorum = 0)
    )
);
CREATE INDEX step_definition_definition ON step_definition (definition_id, step_order);

-- An address identifies one account; the lower-cased address is stored.
CREATE UNIQUE INDEX app_user_email ON app_user (email);
