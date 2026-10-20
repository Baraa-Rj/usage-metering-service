#!/usr/bin/env bash
# Concurrency check for scratch_consume against a throwaway database.
# Usage: scratch/concurrency.sh <database>
set -euo pipefail
DB=${1:?database name}
Q="psql -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"

$Q <<'SQL'
INSERT INTO plans (scope, name, monthly_allowance, max_per_request, is_predefined) VALUES
  ('account', 'CAcct', 100, 40, true),
  ('user',    'CUser', 1000, 100, true);
INSERT INTO accounts (name, api_key_hash, plan_id)
  SELECT 'Race', 'race-key', id FROM plans WHERE name = 'CAcct';
INSERT INTO users (account_id, external_user_id, plan_id)
  SELECT a.id, 'u' || n, p.id
    FROM accounts a, plans p, generate_series(1, 3) n WHERE p.name = 'CUser';
SQL
ACCT=$($Q -c "SELECT id FROM accounts WHERE name = 'Race'")

echo "--- A: 60 concurrent requests of 10 units over 3 users; allowance 100 => exactly 10 accepted"
seq 1 60 | xargs -P 30 -I{} sh -c \
  "psql -U postgres -d $DB -qAt -c \"SELECT out_decision FROM scratch_consume('$ACCT', 'u' || (({}%3)+1), 'a{}', 10)\"" \
  | sort | uniq -c
$Q -c "SELECT 'account used = ' || used FROM account_usage"
$Q -c "SELECT 'sum of user used = ' || sum(used) FROM user_usage"

echo "--- B: 20 concurrent retries of the SAME request id (1 unit, next month) => counted once"
seq 1 20 | xargs -P 20 -I{} sh -c \
  "psql -U postgres -d $DB -qAt -c \"SELECT out_replayed FROM scratch_consume('$ACCT', 'u1', 'same', 1, '2099-01-05 00:00:00+00')\" 2>&1" \
  | sort | uniq -c
$Q -c "SELECT 'rows for request same = ' || count(*) FROM requests WHERE request_id = 'same'"
$Q -c "SELECT 'account used in that month = ' || used FROM account_usage WHERE month = '2099-01-01'"
