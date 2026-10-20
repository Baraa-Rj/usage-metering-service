-- Sequential behaviour tests for scratch_consume. Run against a throwaway
-- database that already has migrations/001_init.sql and consume.sql applied.
-- Statements that are expected to fail are noted; psql keeps going after them.

INSERT INTO plans (scope, name, monthly_allowance, max_per_request, is_predefined) VALUES
  ('account', 'TinyAcct', 100, 40, true),
  ('user',    'TinyUser',  60, 25, true);

INSERT INTO accounts (name, api_key_hash, plan_id)
SELECT 'Acme', 'k1', id FROM plans WHERE name = 'TinyAcct';

INSERT INTO users (account_id, external_user_id, plan_id)
SELECT a.id, 'u1', p.id FROM accounts a, plans p WHERE p.name = 'TinyUser';

SELECT id AS acct FROM accounts \gset

\echo '--- 1: 20 units (expect accepted, acct left 80, user left 40)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r1', 20);

\echo '--- 2: replay r1 (expect same decision, replayed = t, remaining unchanged)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r1', 20);

\echo '--- 3: r1 again with 21 units (expect P0409 error)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r1', 21);

\echo '--- 4: 30 units (expect rejected user_max_per_request)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r4', 30);

\echo '--- 5: 45 units (expect rejected account_max_per_request: account checked first)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r5', 45);

\echo '--- 6: 25 units (expect accepted, acct left 55, user left 15)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r6', 25);

\echo '--- 7: 25 units (expect rejected user_monthly_allowance: 45 + 25 > 60)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r7', 25);

\echo '--- 8: usage must be 45/45: rejections consumed nothing'
SELECT (SELECT used FROM account_usage) AS acct_used, (SELECT used FROM user_usage) AS user_used;

\echo '--- 9: lower the user allowance to 10 below current usage (expect remaining 0, reject)'
UPDATE plans SET monthly_allowance = 10 WHERE name = 'TinyUser';
SELECT * FROM scratch_consume(:'acct', 'u1', 'r9', 1);

\echo '--- 10: next UTC month starts fresh (expect accepted, user left 0 because allowance is now 10 - 5)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r10', 5, '2026-11-01 00:00:00+00');

\echo '--- 11: month boundary in UTC, not local time (23:59:59 on Oct 31 UTC is still October)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r11', 1, '2026-10-31 23:59:59+00');

\echo '--- 12: unknown user (expect P0404 error)'
SELECT * FROM scratch_consume(:'acct', 'nobody', 'r12', 1);

\echo '--- 13: units 0 (expect 22023 error)'
SELECT * FROM scratch_consume(:'acct', 'u1', 'r13', 0);

\echo '--- final state'
SELECT month, used FROM account_usage ORDER BY month;
SELECT month, used FROM user_usage ORDER BY month;
SELECT request_id, units, decision, rejection_rule, account_used_before, user_used_before
  FROM requests ORDER BY created_at, request_id;
