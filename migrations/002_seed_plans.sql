-- Predefined plans. They are global (no owner) and read-only through the API.
-- The numbers are product assumptions; they are documented in the README.

INSERT INTO plans (scope, name, monthly_allowance, max_per_request, is_predefined) VALUES
    ('account', 'Starter',   10000,  100, true),
    ('account', 'Pro',      500000, 1000, true),
    ('user',    'Basic',       500,   50, true),
    ('user',    'Premium',    5000,  500, true);
