-- Scratch prototype of the consume transaction. Not a migration.
-- The service will run these same statements from TypeScript inside one
-- transaction (READ COMMITTED). Wrapping them in a function here just makes
-- them easy to call from psql.
--
-- Rejection order (first failing rule wins):
--   account_max_per_request, user_max_per_request,
--   account_monthly_allowance, user_monthly_allowance
--
-- Custom SQLSTATEs the API layer should map:
--   P0404  unknown account or user          -> 404
--   P0409  request_id reused with a different user or units -> 409

CREATE OR REPLACE FUNCTION scratch_consume(
    p_account_id       uuid,
    p_external_user_id text,
    p_request_id       text,
    p_units            bigint,
    p_now              timestamptz DEFAULT now()
)
RETURNS TABLE (
    out_decision          decision,
    out_rejection_rule    rejection_rule,
    out_replayed          boolean,
    out_account_remaining bigint,
    out_user_remaining    bigint
)
LANGUAGE plpgsql AS $$
DECLARE
    v_month         date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
    v_user_id       uuid;
    v_acct_plan_id  uuid;
    v_user_plan_id  uuid;
    v_acct_allow    bigint;
    v_acct_max      bigint;
    v_user_allow    bigint;
    v_user_max      bigint;
    v_acct_used     bigint;
    v_user_used     bigint;
    v_existing      requests%ROWTYPE;
    v_decision      decision;
    v_rule          rejection_rule;
BEGIN
    IF p_units IS NULL OR p_units <= 0 THEN
        RAISE EXCEPTION 'units must be a positive integer' USING ERRCODE = '22023';
    END IF;

    -- 1. Resolve the user and read the CURRENT plan limits (live edits apply
    --    to new requests because nothing is copied onto accounts or users).
    SELECT u.id, u.plan_id, pu.monthly_allowance, pu.max_per_request
      INTO v_user_id, v_user_plan_id, v_user_allow, v_user_max
      FROM users u
      JOIN plans pu ON pu.id = u.plan_id
     WHERE u.account_id = p_account_id
       AND u.external_user_id = p_external_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0404';
    END IF;

    SELECT a.plan_id, pa.monthly_allowance, pa.max_per_request
      INTO v_acct_plan_id, v_acct_allow, v_acct_max
      FROM accounts a
      JOIN plans pa ON pa.id = a.plan_id
     WHERE a.id = p_account_id;

    -- 2. Make sure this month's counter rows exist. DO NOTHING makes it safe
    --    when several first-of-month requests arrive together.
    INSERT INTO account_usage (account_id, month)
         VALUES (p_account_id, v_month) ON CONFLICT DO NOTHING;
    INSERT INTO user_usage (user_id, month)
         VALUES (v_user_id, v_month) ON CONFLICT DO NOTHING;

    -- 3. Lock account counter first, then user counter. Every consume uses
    --    this order, so two consumes can never deadlock. Holding the account
    --    lock also serializes retries of the same request_id: the second one
    --    waits here, then sees the first one's committed row in step 4.
    SELECT used INTO v_acct_used FROM account_usage
     WHERE account_id = p_account_id AND month = v_month FOR UPDATE;
    SELECT used INTO v_user_used FROM user_usage
     WHERE user_id = v_user_id AND month = v_month FOR UPDATE;

    -- 4. Idempotency: replay the stored decision, count nothing again.
    SELECT * INTO v_existing FROM requests
     WHERE account_id = p_account_id AND request_id = p_request_id;
    IF FOUND THEN
        IF v_existing.user_id <> v_user_id OR v_existing.units <> p_units THEN
            RAISE EXCEPTION 'request_id already used with different parameters'
                USING ERRCODE = 'P0409';
        END IF;
        RETURN QUERY SELECT v_existing.decision, v_existing.rejection_rule, true,
            greatest(0, v_acct_allow - v_acct_used),
            greatest(0, v_user_allow - v_user_used);
        RETURN;
    END IF;

    -- 5. Decide. A rejection consumes nothing.
    IF p_units > v_acct_max THEN
        v_decision := 'rejected'; v_rule := 'account_max_per_request';
    ELSIF p_units > v_user_max THEN
        v_decision := 'rejected'; v_rule := 'user_max_per_request';
    ELSIF v_acct_used + p_units > v_acct_allow THEN
        v_decision := 'rejected'; v_rule := 'account_monthly_allowance';
    ELSIF v_user_used + p_units > v_user_allow THEN
        v_decision := 'rejected'; v_rule := 'user_monthly_allowance';
    ELSE
        v_decision := 'accepted'; v_rule := NULL;
    END IF;

    -- 6. Count the usage only when accepted.
    IF v_decision = 'accepted' THEN
        UPDATE account_usage SET used = used + p_units
         WHERE account_id = p_account_id AND month = v_month;
        UPDATE user_usage SET used = used + p_units
         WHERE user_id = v_user_id AND month = v_month;
    END IF;

    -- 7. Record the decision with a snapshot of what was enforced.
    INSERT INTO requests (
        account_id, user_id, request_id, units, month, decision, rejection_rule,
        account_plan_id, user_plan_id,
        account_monthly_allowance, account_max_per_request,
        user_monthly_allowance, user_max_per_request,
        account_used_before, user_used_before, created_at
    ) VALUES (
        p_account_id, v_user_id, p_request_id, p_units, v_month, v_decision, v_rule,
        v_acct_plan_id, v_user_plan_id,
        v_acct_allow, v_acct_max, v_user_allow, v_user_max,
        v_acct_used, v_user_used, p_now
    );

    IF v_decision = 'accepted' THEN
        v_acct_used := v_acct_used + p_units;
        v_user_used := v_user_used + p_units;
    END IF;

    RETURN QUERY SELECT v_decision, v_rule, false,
        greatest(0, v_acct_allow - v_acct_used),
        greatest(0, v_user_allow - v_user_used);
END $$;
