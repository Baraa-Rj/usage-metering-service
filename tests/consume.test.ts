// Integration tests: replay, rejection order, plan edits, month rollover, concurrency.
//
// Error contract the tests rely on: failures reject with an object that has a
// numeric `status` (the HTTP status the API will return), e.g. AppError.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consume } from "../src/consume.js";
import {
    fixedClock,
    requestCount,
    reset,
    seed,
    testPool,
    usage,
    type Seeded,
    type TestClock,
} from "./helpers.js";

const OCT = "2026-10-01";
const NOV = "2026-11-01";

let pool: pg.Pool;
let clock: TestClock;
let ctx: Seeded;

// Account: 100 units/month, 40 per request. User: 60 units/month, 25 per request.
const ACCOUNT = { allowance: 100, max: 40 };
const USER = { allowance: 60, max: 25 };

const call = (requestId: string, units: number, externalUserId = "u1") =>
    consume(pool, clock, { accountId: ctx.accountId, externalUserId, requestId, units });

beforeAll(() => {
    pool = testPool();
});

afterAll(async () => {
    await pool.end();
});

beforeEach(async () => {
    await reset(pool);
    clock = fixedClock("2026-10-15T12:00:00Z");
    ctx = await seed(pool, { account: ACCOUNT, user: USER, users: ["u1", "u2"] });
});

describe("consume", () => {
    it("accepts and counts usage on both the account and the user", async () => {
        const result = await call("r1", 20);

        expect(result).toMatchObject({
            requestId: "r1",
            decision: "accepted",
            rejectionRule: null,
            rejectedBy: null,
            units: 20,
            month: "2026-10",
            replayed: false,
            accountRemaining: 80,
            userRemaining: 40,
        });
        expect(result.explanation).toBe(
            'Accepted: 20 units counted. 80 units left this month for the account and 40 units for user "u1".',
        );
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 20, users: 20 });
    });

    it("a replay explains the original decision from its snapshot, even after a plan edit", async () => {
        const first = await call("r1", 30); // rejected: over the user's max of 25
        await pool.query("UPDATE plans SET max_per_request = 50 WHERE id = $1", [ctx.userPlanId]);
        const retry = await call("r1", 30);

        expect(retry).toMatchObject({ replayed: true, decision: "rejected", rejectedBy: "user" });
        expect(retry.explanation).toBe(first.explanation);
        expect(retry.explanation).toContain("limit of 25 units per request");
    });

    it("a rejection consumes nothing but is still recorded", async () => {
        const result = await call("r1", 30); // above the user's max of 25

        expect(result).toMatchObject({
            decision: "rejected",
            rejectionRule: "user_max_per_request",
            accountRemaining: 100,
            userRemaining: 60,
        });
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 0, users: 0 });
        expect(await requestCount(pool, ctx.accountId, "r1")).toBe(1);
    });

    it("stores a snapshot of the limits that were enforced", async () => {
        await call("r1", 20);
        await call("r2", 30);

        const { rows } = await pool.query(
            `SELECT request_id, account_monthly_allowance, account_max_per_request,
                    user_monthly_allowance, user_max_per_request,
                    account_used_before, user_used_before
               FROM requests ORDER BY request_id`,
        );
        expect(rows[0]).toMatchObject({
            account_monthly_allowance: 100,
            account_max_per_request: 40,
            user_monthly_allowance: 60,
            user_max_per_request: 25,
            account_used_before: 0,
            user_used_before: 0,
        });
        expect(rows[1]).toMatchObject({ account_used_before: 20, user_used_before: 20 });
    });

    it("replays the stored decision for a retried request_id without counting again", async () => {
        const first = await call("r1", 20);
        const retry = await call("r1", 20);

        expect(first.replayed).toBe(false);
        expect(retry).toMatchObject({ decision: "accepted", units: 20, replayed: true });
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 20, users: 20 });
        expect(await requestCount(pool, ctx.accountId, "r1")).toBe(1);
    });

    it("replays a stored rejection as a rejection", async () => {
        await call("r1", 30);
        const retry = await call("r1", 30);

        expect(retry).toMatchObject({
            decision: "rejected",
            rejectionRule: "user_max_per_request",
            replayed: true,
        });
    });

    it("rejects a reused request_id with different units (409)", async () => {
        await call("r1", 20);
        await expect(call("r1", 21)).rejects.toMatchObject({ status: 409 });
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 20, users: 20 });
    });

    it("rejects a reused request_id for a different user (409)", async () => {
        await call("r1", 20, "u1");
        await expect(call("r1", 20, "u2")).rejects.toMatchObject({ status: 409 });
    });

    it("reports the first failing rule in order: account max, user max, account allowance, user allowance", async () => {
        // everything fails: account max wins
        expect((await call("a", 500)).rejectionRule).toBe("account_max_per_request");
        // within the account max, over the user's max
        expect((await call("b", 30)).rejectionRule).toBe("user_max_per_request");

        // user allowance: u1 uses 50 of 60, then asks for 25 more
        await call("c1", 25);
        await call("c2", 25);
        expect((await call("c3", 25)).rejectionRule).toBe("user_monthly_allowance");

        // account allowance: u2 brings the account to 100, then asks for 10 more
        await call("d1", 25, "u2");
        await call("d2", 25, "u2");
        expect((await call("d3", 10, "u2")).rejectionRule).toBe("account_monthly_allowance");
    });

    it("applies a plan edit to the next request and keeps existing usage", async () => {
        await call("r1", 20);

        await pool.query("UPDATE plans SET monthly_allowance = 100 WHERE id = $1", [ctx.userPlanId]);
        const raised = await call("r2", 25);
        expect(raised.decision).toBe("accepted");
        expect(raised.userRemaining).toBe(55); // 100 - 45

        await pool.query("UPDATE plans SET max_per_request = 5 WHERE id = $1", [ctx.userPlanId]);
        expect((await call("r3", 6)).rejectionRule).toBe("user_max_per_request");

        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 45, users: 45 });
    });

    it("shows 0 remaining when the allowance is lowered below usage", async () => {
        await call("r1", 20);
        await pool.query("UPDATE plans SET monthly_allowance = 10 WHERE id = $1", [ctx.userPlanId]);

        const result = await call("r2", 1);
        expect(result).toMatchObject({
            decision: "rejected",
            rejectionRule: "user_monthly_allowance",
            userRemaining: 0,
            accountRemaining: 80,
        });
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 20, users: 20 });
    });

    it("starts a fresh counter in a new UTC month", async () => {
        await call("r1", 25);
        await call("r2", 25);

        clock.set("2026-11-01T00:00:00Z");
        const result = await call("r3", 25);

        expect(result).toMatchObject({ decision: "accepted", userRemaining: 35 });
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 50, users: 50 });
        expect(await usage(pool, ctx.accountId, NOV)).toEqual({ account: 25, users: 25 });
    });

    it("keeps 23:59:59 UTC on the last day of the month in the old month", async () => {
        clock.set("2026-10-31T23:59:59Z");
        await call("r1", 10);
        clock.set("2026-11-01T00:00:00Z");
        await call("r2", 10);

        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 10, users: 10 });
        expect(await usage(pool, ctx.accountId, NOV)).toEqual({ account: 10, users: 10 });
    });

    it("rejects an unknown user (404)", async () => {
        await expect(call("r1", 1, "nobody")).rejects.toMatchObject({ status: 404 });
        expect(await requestCount(pool, ctx.accountId)).toBe(0);
    });

    it("rejects non-positive or non-integer units (400)", async () => {
        await expect(call("r1", 0)).rejects.toMatchObject({ status: 400 });
        await expect(call("r2", -5)).rejects.toMatchObject({ status: 400 });
        await expect(call("r3", 1.5)).rejects.toMatchObject({ status: 400 });
        expect(await requestCount(pool, ctx.accountId)).toBe(0);
    });
});

describe("consume under concurrency", () => {
    it("accepts exactly the allowed number of concurrent requests", async () => {
        // 3 users with roomy limits; the account allowance (100) is the bottleneck.
        await reset(pool);
        ctx = await seed(pool, {
            account: { allowance: 100, max: 40 },
            user: { allowance: 1000, max: 100 },
            users: ["u1", "u2", "u3"],
        });

        const results = await Promise.all(
            Array.from({ length: 60 }, (_, i) => call(`c${i}`, 10, `u${(i % 3) + 1}`)),
        );

        expect(results.filter((r) => r.decision === "accepted")).toHaveLength(10);
        expect(results.filter((r) => r.decision === "rejected")).toHaveLength(50);
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 100, users: 100 });
        expect(await requestCount(pool, ctx.accountId)).toBe(60);
    });

    it("counts concurrent retries of one request_id once", async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => call("same", 5)));

        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(results.filter((r) => r.replayed)).toHaveLength(19);
        expect(new Set(results.map((r) => r.decision))).toEqual(new Set(["accepted"]));
        expect(await usage(pool, ctx.accountId, OCT)).toEqual({ account: 5, users: 5 });
        expect(await requestCount(pool, ctx.accountId, "same")).toBe(1);
    });

    it("does not deadlock when two users interleave on the same account", async () => {
        const results = await Promise.all(
            Array.from({ length: 40 }, (_, i) => call(`x${i}`, 1, i % 2 === 0 ? "u1" : "u2")),
        );
        expect(results).toHaveLength(40);
        const accepted = results.filter((r) => r.decision === "accepted").length;
        const { account } = await usage(pool, ctx.accountId, OCT);
        expect(account).toBe(accepted);
    });
});
