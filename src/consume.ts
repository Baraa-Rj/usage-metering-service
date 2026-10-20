// The consume transaction: lock counters in fixed order, replay by request_id, decide, record.
import type pg from "pg";
import { utcMonthStart, type Clock } from "./clock.js";
import { withTransaction } from "./db.js";
import { decide, remaining, type RejectionRule } from "./decision.js";
import { idempotencyError, notFoundError, validationError } from "./errors.js";

export interface ConsumeInput {
    accountId: string;
    externalUserId: string;
    requestId: string;
    units: number;
}

export interface ConsumeResult {
    requestId: string;
    decision: "accepted" | "rejected";
    rejectionRule: RejectionRule | null;
    units: number;
    /** true when this was a retry and the stored decision was returned. */
    replayed: boolean;
    accountRemaining: number;
    userRemaining: number;
}

export async function consume(
    pool: pg.Pool,
    clock: Clock,
    input: ConsumeInput,
): Promise<ConsumeResult> {
    const { accountId, externalUserId, requestId, units } = input;
    if (!Number.isSafeInteger(units) || units <= 0) {
        throw validationError("units must be a positive integer");
    }
    const month = utcMonthStart(clock.now());

    return withTransaction(pool, async (db) => {
        // Current plan limits are read on every call, so plan edits apply to the next request.
        const context = await db.query(
            `SELECT
                 u.id                 AS user_id,
                 a.plan_id            AS account_plan_id,
                 pa.monthly_allowance AS account_allowance,
                 pa.max_per_request   AS account_max,
                 u.plan_id            AS user_plan_id,
                 pu.monthly_allowance AS user_allowance,
                 pu.max_per_request   AS user_max
               FROM accounts a
               JOIN plans pa ON pa.id = a.plan_id
               JOIN users u  ON u.account_id = a.id
               JOIN plans pu ON pu.id = u.plan_id
              WHERE a.id = $1 AND u.external_user_id = $2`,
            [accountId, externalUserId],
        );
        const row = context.rows[0];
        if (!row) {
            throw notFoundError("account or user not found");
        }
        const userId: string = row.user_id;

        // Make sure this month's counter rows exist. DO NOTHING keeps it safe when
        // several first-of-month requests arrive together.
        await db.query(
            "INSERT INTO account_usage (account_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [accountId, month],
        );
        await db.query(
            "INSERT INTO user_usage (user_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [userId, month],
        );

        // Lock the account counter first, then the user counter. Every consume uses this
        // order, so two consumes can never deadlock. Holding the account lock also makes
        // concurrent retries of one request_id wait here and see the first one's row below.
        const accountUsed: number = (
            await db.query(
                "SELECT used FROM account_usage WHERE account_id = $1 AND month = $2 FOR UPDATE",
                [accountId, month],
            )
        ).rows[0].used;
        const userUsed: number = (
            await db.query(
                "SELECT used FROM user_usage WHERE user_id = $1 AND month = $2 FOR UPDATE",
                [userId, month],
            )
        ).rows[0].used;

        const account = {
            monthlyAllowance: row.account_allowance,
            maxPerRequest: row.account_max,
            used: accountUsed,
        };
        const user = {
            monthlyAllowance: row.user_allowance,
            maxPerRequest: row.user_max,
            used: userUsed,
        };

        // Idempotency: a retry gets the stored decision back and counts nothing again.
        const existing = (
            await db.query(
                `SELECT user_id, units, decision, rejection_rule
                   FROM requests
                  WHERE account_id = $1 AND request_id = $2`,
                [accountId, requestId],
            )
        ).rows[0];
        if (existing) {
            if (existing.user_id !== userId || existing.units !== units) {
                throw idempotencyError("request_id was already used with different parameters");
            }
            return {
                requestId,
                decision: existing.decision,
                rejectionRule: existing.rejection_rule,
                units,
                replayed: true,
                accountRemaining: remaining(account),
                userRemaining: remaining(user),
            };
        }

        // Decide. A rejection consumes nothing.
        const outcome = decide(units, account, user);
        const accepted = outcome.decision === "accepted";

        if (accepted) {
            await db.query(
                "UPDATE account_usage SET used = used + $3 WHERE account_id = $1 AND month = $2",
                [accountId, month, units],
            );
            await db.query(
                "UPDATE user_usage SET used = used + $3 WHERE user_id = $1 AND month = $2",
                [userId, month, units],
            );
        }

        // Record the decision with a snapshot of what was enforced.
        await db.query(
            `INSERT INTO requests (
                 account_id, user_id, request_id, units, month, decision, rejection_rule,
                 account_plan_id, user_plan_id,
                 account_monthly_allowance, account_max_per_request,
                 user_monthly_allowance, user_max_per_request,
                 account_used_before, user_used_before)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
                accountId,
                userId,
                requestId,
                units,
                month,
                outcome.decision,
                outcome.rejectionRule,
                row.account_plan_id,
                row.user_plan_id,
                account.monthlyAllowance,
                account.maxPerRequest,
                user.monthlyAllowance,
                user.maxPerRequest,
                accountUsed,
                userUsed,
            ],
        );

        return {
            requestId,
            decision: outcome.decision,
            rejectionRule: outcome.rejectionRule,
            units,
            replayed: false,
            accountRemaining: remaining({ ...account, used: accountUsed + (accepted ? units : 0) }),
            userRemaining: remaining({ ...user, used: userUsed + (accepted ? units : 0) }),
        };
    });
}
