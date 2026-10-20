-- Account names are unique, ignoring case ("Acme" and "acme" are the same account).
-- Enforced by the database, not by a check-then-insert, so two concurrent
-- requests cannot both create the same name.

CREATE UNIQUE INDEX accounts_name_lower_uq ON accounts (lower(name));
