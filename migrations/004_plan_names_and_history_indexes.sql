-- 004: case-insensitive plan names, name reuse after archiving, and history indexes.

-- Custom plan names are unique per account and scope, ignoring case ("Gold" = "gold"),
-- among active plans only: an archived plan keeps its name but no longer blocks it.
DROP INDEX plans_custom_name_uq;
CREATE UNIQUE INDEX plans_custom_name_lower_uq
    ON plans (owner_account_id, scope, lower(name))
    WHERE NOT is_predefined AND archived_at IS NULL;

DROP INDEX plans_predefined_name_uq;
CREATE UNIQUE INDEX plans_predefined_name_lower_uq
    ON plans (scope, lower(name))
    WHERE is_predefined;

-- Monthly history counts accepted and rejected requests per month.
CREATE INDEX requests_account_month_idx ON requests (account_id, month);
CREATE INDEX requests_user_month_idx ON requests (user_id, month);
