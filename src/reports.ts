// Read-side queries: current usage, monthly history, and the request log with explanations.
import { explainDecision, rejectedBy, remaining, type RejectionRule } from "./decision.js";
import type { Db } from "./plans.js";

/** '2026-10-01' (as stored) -> '2026-10' (as shown in the API). */
export const monthLabel = (month: string): string => month.slice(0, 7);

export interface UsageSummary {
    plan: { id: string; name: string };
    used: number;
    monthlyAllowance: number;
    maxPerRequest: number;
    /** Allowance minus used, never negative (an allowance lowered below usage shows 0). */
    remaining: number;
}

function usageSummary(row: Record<string, any>): UsageSummary {
    const limits = { monthlyAllowance: row.monthly_allowance, maxPerRequest: row.max_per_request, used: row.used };
    return {
        plan: { id: row.plan_id, name: row.plan_name },
        used: row.used,
        monthlyAllowance: row.monthly_allowance,
        maxPerRequest: row.max_per_request,
        remaining: remaining(limits),
    };
}

// A month without a counter row has used nothing yet: the row is created by the first consume.
export async function accountUsage(db: Db, accountId: string, month: string): Promise<UsageSummary> {
    const { rows } = await db.query(
        `SELECT p.id AS plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request,
                COALESCE(c.used, 0) AS used
           FROM accounts a
           JOIN plans p ON p.id = a.plan_id
           LEFT JOIN account_usage c ON c.account_id = a.id AND c.month = $2
          WHERE a.id = $1`,
        [accountId, month],
    );
    return usageSummary(rows[0]!);
}

export async function userUsage(db: Db, userId: string, month: string): Promise<UsageSummary> {
    const { rows } = await db.query(
        `SELECT p.id AS plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request,
                COALESCE(c.used, 0) AS used
           FROM users u
           JOIN plans p ON p.id = u.plan_id
           LEFT JOIN user_usage c ON c.user_id = u.id AND c.month = $2
          WHERE u.id = $1`,
        [userId, month],
    );
    return usageSummary(rows[0]!);
}

export interface MonthUsage {
    month: string;
    used: number;
    requests: { accepted: number; rejected: number };
}

// The table/column names come from this fixed map, never from user input.
const SUBJECTS = {
    account: { usageTable: "account_usage", usageKey: "account_id", requestKey: "account_id" },
    user: { usageTable: "user_usage", usageKey: "user_id", requestKey: "user_id" },
} as const;

/**
 * The last `months` UTC months up to and including `currentMonth`, newest first.
 * Every month is listed, with zeros where nothing happened, so the result can be
 * charted directly.
 */
export async function monthlyHistory(
    db: Db,
    subject: keyof typeof SUBJECTS,
    subjectId: string,
    currentMonth: string,
    months: number,
): Promise<MonthUsage[]> {
    const { usageTable, usageKey, requestKey } = SUBJECTS[subject];
    const { rows } = await db.query(
        `WITH months AS (
             SELECT generate_series(
                        $2::date - make_interval(months => $3::int - 1),
                        $2::date,
                        interval '1 month')::date AS month
         )
         SELECT to_char(m.month, 'YYYY-MM') AS month,
                COALESCE(c.used, 0) AS used,
                COALESCE(r.accepted, 0) AS accepted,
                COALESCE(r.rejected, 0) AS rejected
           FROM months m
           LEFT JOIN ${usageTable} c ON c.${usageKey} = $1 AND c.month = m.month
           LEFT JOIN (
                SELECT month,
                       count(*) FILTER (WHERE decision = 'accepted') AS accepted,
                       count(*) FILTER (WHERE decision = 'rejected') AS rejected
                  FROM requests
                 WHERE ${requestKey} = $1
                   AND month BETWEEN $2::date - make_interval(months => $3::int - 1) AND $2::date
                 GROUP BY month
           ) r ON r.month = m.month
          ORDER BY m.month DESC`,
        [subjectId, currentMonth, months],
    );
    return rows.map((row) => ({
        month: row.month,
        used: row.used,
        requests: { accepted: row.accepted, rejected: row.rejected },
    }));
}

// The request log joined to the caller's user ids. `cursor_ts` is created_at as UTC text
// with all six fractional digits: a JS Date would round it to milliseconds, and a cursor
// built from a rounded timestamp could skip or repeat rows that share a millisecond.
export const REQUEST_SELECT = `
    SELECT r.id, r.request_id, u.external_user_id, r.units, r.month, r.decision, r.rejection_rule,
           r.account_plan_id, r.account_monthly_allowance, r.account_max_per_request, r.account_used_before,
           r.user_plan_id, r.user_monthly_allowance, r.user_max_per_request, r.user_used_before,
           r.created_at,
           to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
      FROM requests r
      JOIN users u ON u.id = r.user_id`;

export function requestJson(row: Record<string, any>) {
    const rule: RejectionRule | null = row.rejection_rule;
    const account = {
        monthlyAllowance: row.account_monthly_allowance,
        maxPerRequest: row.account_max_per_request,
        usedBefore: row.account_used_before,
    };
    const user = {
        monthlyAllowance: row.user_monthly_allowance,
        maxPerRequest: row.user_max_per_request,
        usedBefore: row.user_used_before,
    };
    return {
        requestId: row.request_id,
        externalUserId: row.external_user_id,
        units: row.units,
        month: monthLabel(row.month),
        decision: row.decision,
        rejectionRule: rule,
        rejectedBy: rejectedBy(rule),
        explanation: explainDecision({
            units: row.units,
            externalUserId: row.external_user_id,
            rejectionRule: rule,
            account,
            user,
        }),
        // The limits that were enforced at decision time; later plan edits do not change them.
        limits: {
            account: { planId: row.account_plan_id, ...account },
            user: { planId: row.user_plan_id, ...user },
        },
        createdAt: row.created_at,
    };
}
