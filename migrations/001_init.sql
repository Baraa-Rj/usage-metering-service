CREATE TYPE plan_scope AS ENUM ('account', 'user');

CREATE TYPE decision AS ENUM ('accepted', 'rejected');

CREATE TYPE rejection_rule AS ENUM (
    'account_max_per_request',
    'user_max_per_request',
    'account_monthly_allowance',
    'user_monthly_allowance'
);

CREATE TABLE
    plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
        scope plan_scope NOT NULL,
        name text NOT NULL,
        monthly_allowance bigint NOT NULL,
        max_per_request bigint NOT NULL,
        is_predefined boolean NOT NULL DEFAULT false,
        owner_account_id uuid,
        created_at timestamptz NOT NULL DEFAULT now (),
        updated_at timestamptz NOT NULL DEFAULT now (),
        archived_at timestamptz,
        CONSTRAINT plans_allowance_nonneg CHECK (monthly_allowance >= 0),
        CONSTRAINT plans_max_per_request_positive CHECK (max_per_request > 0),
        CONSTRAINT plans_name_not_blank CHECK (btrim (name) <> ''),
        CONSTRAINT plans_owner_matches_kind CHECK ((is_predefined = (owner_account_id IS NULL))),
        CONSTRAINT plans_id_scope_key UNIQUE (id, scope)
    );

CREATE UNIQUE INDEX plans_predefined_name_uq ON plans (scope, name)
WHERE
    is_predefined;

CREATE UNIQUE INDEX plans_custom_name_uq ON plans (owner_account_id, scope, name)
WHERE
    NOT is_predefined;

CREATE FUNCTION plans_forbid_scope_change() RETURNS trigger AS $$
BEGIN
    IF NEW.scope <> OLD.scope THEN
        RAISE EXCEPTION 'Cannot change the scope of a plan';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER plans_forbid_scope_change_trigger
    BEFORE UPDATE OF scope ON plans
    FOR EACH ROW
    EXECUTE FUNCTION plans_forbid_scope_change();

CREATE TABLE accounts (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL,
    api_key_hash  text        NOT NULL UNIQUE,
    plan_id       uuid        NOT NULL,
    plan_scope    plan_scope  NOT NULL DEFAULT 'account',
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT accounts_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT accounts_plan_scope_is_account CHECK (plan_scope = 'account'),
    CONSTRAINT accounts_plan_fk
        FOREIGN KEY (plan_id, plan_scope)
        REFERENCES plans (id, scope)
        ON DELETE RESTRICT
);

ALTER TABLE plans
    ADD CONSTRAINT plans_owner_account_fk
    FOREIGN KEY (owner_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT;

CREATE INDEX accounts_plan_id_idx ON accounts (plan_id);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL
        REFERENCES accounts (id)
        ON DELETE RESTRICT,
    external_user_id text NOT NULL,
    plan_id uuid NOT NULL,
    plan_scope plan_scope NOT NULL DEFAULT 'user',
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_external_id_not_blank CHECK (btrim(external_user_id) <> ''),
    CONSTRAINT users_plan_scope_is_user CHECK (plan_scope = 'user'),
    CONSTRAINT users_plan_fk
        FOREIGN KEY (plan_id, plan_scope)
        REFERENCES plans (id, scope)
        ON DELETE RESTRICT,
    CONSTRAINT users_account_external_key
        UNIQUE (account_id, external_user_id)
);

CREATE INDEX users_plan_id_idx ON users (plan_id);

CREATE FUNCTION check_plan_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    plan_owner     uuid;
    entity_account uuid;
BEGIN
    SELECT owner_account_id
      INTO plan_owner
      FROM plans
     WHERE id = NEW.plan_id;

    IF TG_TABLE_NAME = 'accounts' THEN
        entity_account := NEW.id;
    ELSE
        entity_account := NEW.account_id;
    END IF;

    IF plan_owner IS NOT NULL AND plan_owner <> entity_account THEN
        RAISE EXCEPTION 'plan % is owned by another account', NEW.plan_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER accounts_check_plan_ownership
    BEFORE INSERT OR UPDATE OF plan_id ON accounts
    FOR EACH ROW EXECUTE FUNCTION check_plan_ownership();

CREATE TRIGGER users_check_plan_ownership
    BEFORE INSERT OR UPDATE OF plan_id, account_id ON users
    FOR EACH ROW EXECUTE FUNCTION check_plan_ownership();

CREATE TABLE account_usage (
    account_id uuid   NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    month      date   NOT NULL,
    used       bigint NOT NULL DEFAULT 0,

    PRIMARY KEY (account_id, month),
    CONSTRAINT account_usage_used_nonneg CHECK (used >= 0),
    CONSTRAINT account_usage_month_is_first
        CHECK (month = date_trunc('month', month)::date)
);

CREATE TABLE user_usage (
    user_id uuid    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    month   date    NOT NULL,
    used    bigint  NOT NULL DEFAULT 0,

    PRIMARY KEY (user_id, month),
    CONSTRAINT user_usage_used_nonneg CHECK (used >= 0),
    CONSTRAINT user_usage_month_is_first
        CHECK (month = date_trunc('month', month)::date)
);

ALTER TABLE users
    ADD CONSTRAINT users_id_account_key UNIQUE (id, account_id);

CREATE TABLE requests (
    id          uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid   NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    user_id     uuid   NOT NULL,
    request_id  text   NOT NULL,

    units          bigint         NOT NULL,
    month          date           NOT NULL,
    decision       decision       NOT NULL,
    rejection_rule rejection_rule,

    account_plan_id            uuid   NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
    user_plan_id               uuid   NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
    account_monthly_allowance  bigint NOT NULL,
    account_max_per_request    bigint NOT NULL,
    user_monthly_allowance     bigint NOT NULL,
    user_max_per_request       bigint NOT NULL,
    account_used_before        bigint NOT NULL,
    user_used_before           bigint NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT requests_user_account_fk
        FOREIGN KEY (user_id, account_id)
        REFERENCES users (id, account_id) ON DELETE RESTRICT,

    CONSTRAINT requests_account_request_key UNIQUE (account_id, request_id),

    CONSTRAINT requests_request_id_not_blank CHECK (btrim(request_id) <> ''),
    CONSTRAINT requests_units_positive       CHECK (units > 0),
    CONSTRAINT requests_month_is_first
        CHECK (month = date_trunc('month', month)::date),

    CONSTRAINT requests_decision_rule_match
        CHECK ((decision = 'rejected') = (rejection_rule IS NOT NULL)),

    CONSTRAINT requests_snapshot_nonneg CHECK (
        account_monthly_allowance >= 0 AND user_monthly_allowance >= 0
        AND account_max_per_request > 0 AND user_max_per_request > 0
        AND account_used_before >= 0 AND user_used_before >= 0
    ),

    CONSTRAINT requests_accepted_within_limits CHECK (
        decision <> 'accepted' OR (
            units <= account_max_per_request
            AND units <= user_max_per_request
            AND account_used_before + units <= account_monthly_allowance
            AND user_used_before   + units <= user_monthly_allowance
        )
    )
);

CREATE INDEX requests_account_created_idx
    ON requests (account_id, created_at DESC, id DESC);

CREATE INDEX requests_user_created_idx
    ON requests (user_id, created_at DESC, id DESC);
