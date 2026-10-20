// Test pool, fixed clock, reset(), and seed helpers.
import type pg from "pg";
import type { Clock } from "../src/clock.js";
import { createPool } from "../src/db.js";

export const ADMIN_URL =
    process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
export const TEST_DB = "usage_metering_test";
export const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

export function testPool(max = 40): pg.Pool {
    return createPool(TEST_URL, max);
}

export type TestClock = Clock & { set(iso: string): void };

export function fixedClock(iso: string): TestClock {
    let current = new Date(iso);
    return {
        now: () => current,
        set: (next) => {
            current = new Date(next);
        },
    };
}

/** Empties every table, including the seeded plans, so each test owns its data. */
export async function reset(pool: pg.Pool): Promise<void> {
    await pool.query(
        "TRUNCATE requests, user_usage, account_usage, users, accounts, plans RESTART IDENTITY CASCADE",
    );
}

export interface PlanSpec {
    allowance: number;
    max: number;
}

export interface Seeded {
    accountId: string;
    accountPlanId: string;
    userPlanId: string;
}

/** One account on its own plans, with the given external users registered. */
export async function seed(
    pool: pg.Pool,
    opts: { account: PlanSpec; user: PlanSpec; users: string[] },
): Promise<Seeded> {
    const plan = async (scope: "account" | "user", name: string, spec: PlanSpec) =>
        (
            await pool.query(
                `INSERT INTO plans (scope, name, monthly_allowance, max_per_request, is_predefined)
                 VALUES ($1, $2, $3, $4, true) RETURNING id`,
                [scope, name, spec.allowance, spec.max],
            )
        ).rows[0].id as string;

    const accountPlanId = await plan("account", "TestAccountPlan", opts.account);
    const userPlanId = await plan("user", "TestUserPlan", opts.user);
    const accountId = (
        await pool.query(
            `INSERT INTO accounts (name, api_key_hash, plan_id)
             VALUES ('Acme', 'test-hash', $1) RETURNING id`,
            [accountPlanId],
        )
    ).rows[0].id as string;

    for (const externalUserId of opts.users) {
        await pool.query(
            "INSERT INTO users (account_id, external_user_id, plan_id) VALUES ($1, $2, $3)",
            [accountId, externalUserId, userPlanId],
        );
    }
    return { accountId, accountPlanId, userPlanId };
}

/** Counted usage for an account in one month: its own counter and the sum of its users'. */
export async function usage(pool: pg.Pool, accountId: string, month: string) {
    const account = await pool.query(
        "SELECT used FROM account_usage WHERE account_id = $1 AND month = $2",
        [accountId, month],
    );
    const users = await pool.query(
        `SELECT COALESCE(SUM(uu.used), 0)::int AS used
           FROM user_usage uu JOIN users u ON u.id = uu.user_id
          WHERE u.account_id = $1 AND uu.month = $2`,
        [accountId, month],
    );
    return {
        account: (account.rows[0]?.used ?? 0) as number,
        users: users.rows[0].used as number,
    };
}

export async function requestCount(pool: pg.Pool, accountId: string, requestId?: string) {
    const result = requestId
        ? await pool.query(
              "SELECT count(*)::int AS n FROM requests WHERE account_id = $1 AND request_id = $2",
              [accountId, requestId],
          )
        : await pool.query("SELECT count(*)::int AS n FROM requests WHERE account_id = $1", [
              accountId,
          ]);
    return result.rows[0].n as number;
}
