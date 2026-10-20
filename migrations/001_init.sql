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