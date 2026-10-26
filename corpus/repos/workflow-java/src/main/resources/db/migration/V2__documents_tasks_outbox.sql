CREATE TABLE document (
    id            BIGSERIAL PRIMARY KEY,
    title         VARCHAR(200)   NOT NULL,
    body          VARCHAR(10000) NOT NULL,
    owner_id      BIGINT         NOT NULL REFERENCES app_user (id),
    definition_id BIGINT         NOT NULL REFERENCES workflow_definition (id),
    status        VARCHAR(16)    NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    round         INTEGER        NOT NULL DEFAULT 0 CHECK (round >= 0),
    current_order INTEGER        NOT NULL DEFAULT 0 CHECK (current_order >= 0),
    created_at    TIMESTAMPTZ    NOT NULL,
    updated_at    TIMESTAMPTZ    NOT NULL,
    version       BIGINT         NOT NULL DEFAULT 0
);
CREATE INDEX document_owner ON document (owner_id);
CREATE INDEX document_status_id ON document (status, id);

CREATE TABLE approval_task (
    id              BIGSERIAL PRIMARY KEY,
    document_id     BIGINT      NOT NULL REFERENCES document (id),
    round           INTEGER     NOT NULL CHECK (round >= 1),
    step_order      INTEGER     NOT NULL CHECK (step_order >= 1),
    step_id         BIGINT      NOT NULL REFERENCES step_definition (id),
    assignee_id     BIGINT      NOT NULL REFERENCES app_user (id),
    status          VARCHAR(16) NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED')),
    due_at          TIMESTAMPTZ NOT NULL,
    decided_at      TIMESTAMPTZ,
    decision_comment VARCHAR(1000),
    escalated_at    TIMESTAMPTZ,
    version         BIGINT      NOT NULL DEFAULT 0,
    UNIQUE (document_id, round, step_id, assignee_id)
);
CREATE INDEX approval_task_assignee_status ON approval_task (assignee_id, status);
CREATE INDEX approval_task_overdue ON approval_task (status, due_at);
CREATE INDEX approval_task_round ON approval_task (document_id, round, step_order);

CREATE TABLE document_permission (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT      NOT NULL REFERENCES document (id),
    user_id     BIGINT      NOT NULL REFERENCES app_user (id),
    level       VARCHAR(16) NOT NULL CHECK (level IN ('VIEW', 'COMMENT')),
    granted_at  TIMESTAMPTZ NOT NULL,
    UNIQUE (document_id, user_id)
);
CREATE INDEX document_permission_user ON document_permission (user_id, document_id);

CREATE TABLE audit_event (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT       NOT NULL REFERENCES document (id),
    actor_id    BIGINT       NOT NULL REFERENCES app_user (id),
    action      VARCHAR(40)  NOT NULL,
    details     VARCHAR(2000) NOT NULL,
    occurred_at TIMESTAMPTZ  NOT NULL
);
CREATE INDEX audit_event_document ON audit_event (document_id, id);

CREATE TABLE outbox_event (
    id              BIGSERIAL PRIMARY KEY,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    event_type      VARCHAR(40)  NOT NULL,
    recipient_user_id BIGINT     NOT NULL REFERENCES app_user (id),
    recipient_email VARCHAR(254) NOT NULL,
    payload         VARCHAR(4000) NOT NULL,
    status          VARCHAR(16)  NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    attempts        INTEGER      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ  NOT NULL,
    last_error      VARCHAR(200),
    created_at      TIMESTAMPTZ  NOT NULL,
    sent_at         TIMESTAMPTZ
);
CREATE INDEX outbox_event_due ON outbox_event (status, next_attempt_at);
CREATE INDEX outbox_event_recipient ON outbox_event (recipient_user_id, id);
