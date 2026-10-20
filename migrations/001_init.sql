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