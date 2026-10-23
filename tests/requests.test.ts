// Consume over HTTP, account usage and history, and the paginated request log.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    consumeVia,
    createAccount,
    createPlan,
    registerUsers,
    resetWithSeed,
    startServer,
    type TestAccount,
    type TestServer,
} from "./api.js";
import { fixedClock, testPool, type TestClock } from "./helpers.js";

let pool: pg.Pool;
let server: TestServer;
let clock: TestClock;
let acme: TestAccount;

beforeAll(async () => {
    pool = testPool(20);
    clock = fixedClock("2026-10-15T12:00:00Z");
    server = await startServer(pool, clock);
});

afterAll(async () => {
    await server.close();
    await pool.end();
});

beforeEach(async () => {
    await resetWithSeed(pool);
    clock.set("2026-10-15T12:00:00Z");
    acme = await createAccount(server.url, "Acme");
    await createPlan(acme, { scope: "user", name: "Trial", monthlyAllowance: 20, maxPerRequest: 10 });
    await registerUsers(acme, { alice: undefined, bob: "Trial" });
});

async function allPages(path: string, limit: number) {
    const rows: Array<{ requestId: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
        const separator = path.includes("?") ? "&" : "?";
        const url: string = `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const { status, body } = await acme.api.get(url);
        expect(status).toBe(200);
        rows.push(...body.requests);
        cursor = body.nextCursor;
        pages += 1;
    } while (cursor);
    return { ids: rows.map((r) => r.requestId), pages };
}

describe("POST /v1/consume", () => {
    it("explains each decision and says which plan made it", async () => {
        const accepted = await consumeVia(acme, "bob", "r1", 8);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({
            requestId: "r1",
            decision: "accepted",
            rejectionRule: null,
            rejectedBy: null,
            units: 8,
            month: "2026-10",
            replayed: false,
            accountRemaining: 9992,
            userRemaining: 12,
            explanation: 'Accepted: 8 units counted. 9992 units left this month for the account and 12 units for user "bob".',
        });

        const overMax = await consumeVia(acme, "bob", "r2", 11);
        expect(overMax.status).toBe(200);
        expect(overMax.body).toMatchObject({ decision: "rejected", rejectionRule: "user_max_per_request", rejectedBy: "user" });
        expect(overMax.body.explanation).toBe(
            'Rejected by the plan of user "bob": 11 units is more than its limit of 10 units per request.',
        );

        await consumeVia(acme, "bob", "r3", 10);
        const overAllowance = await consumeVia(acme, "bob", "r4", 5);
        expect(overAllowance.body.explanation).toBe(
            'Rejected by the plan of user "bob": 18 of its 20 monthly units are already used, ' +
                "so 5 units more would exceed the allowance (2 units left).",
        );

        const accountMax = await consumeVia(acme, "alice", "r5", 101);
        expect(accountMax.body).toMatchObject({ rejectionRule: "account_max_per_request", rejectedBy: "account" });
    });

    it("a retry replays the original decision and explanation, counting nothing", async () => {
        const first = (await consumeVia(acme, "bob", "r1", 8)).body;
        await consumeVia(acme, "bob", "r2", 4);
        const retry = (await consumeVia(acme, "bob", "r1", 8)).body;
        expect(retry).toMatchObject({ replayed: true, decision: "accepted", explanation: first.explanation });
        expect(retry.userRemaining).toBe(8);
        expect((await consumeVia(acme, "bob", "r1", 9)).status).toBe(409);
    });

    it("validates the body", async () => {
        expect((await consumeVia(acme, "bob", "r1", 0)).status).toBe(400);
        expect((await acme.api.post("/v1/consume", { externalUserId: "bob", requestId: "r1", units: "5" })).status).toBe(400);
        expect((await acme.api.post("/v1/consume", { externalUserId: "bob", units: 5 })).status).toBe(400);
        expect((await consumeVia(acme, "nobody", "r1", 1)).status).toBe(404);
    });

    it("stays exact under concurrent HTTP requests", async () => {
        await createPlan(acme, { scope: "account", name: "Small", monthlyAllowance: 100, maxPerRequest: 50 });
        await acme.api.patch("/v1/account", { plan: "Small" });
        await registerUsers(acme, { carol: "Premium" });
        const results = await Promise.all(
            Array.from({ length: 30 }, (_, i) => consumeVia(acme, "carol", `c${i}`, 10).then((r) => r.body)),
        );
        expect(results.filter((r) => r.decision === "accepted")).toHaveLength(10);
        expect((await acme.api.get("/v1/usage")).body.used).toBe(100);
    });
});

describe("GET /v1/usage and /v1/usage/history", () => {
    it("shows the account's usage and remaining this month", async () => {
        await consumeVia(acme, "alice", "r1", 30);
        await consumeVia(acme, "bob", "r2", 5);
        const { status, body } = await acme.api.get("/v1/usage");
        expect(status).toBe(200);
        expect(body).toEqual({
            month: "2026-10",
            plan: { id: expect.any(String), name: "Starter" },
            used: 35,
            monthlyAllowance: 10000,
            maxPerRequest: 100,
            remaining: 9965,
        });
    });

    it("lists the account's monthly history", async () => {
        clock.set("2026-09-30T23:00:00Z");
        await consumeVia(acme, "alice", "sep", 40);
        clock.set("2026-10-01T00:00:00Z");
        await consumeVia(acme, "alice", "oct", 2);
        await consumeVia(acme, "bob", "oct-big", 11); // rejected

        const { body } = await acme.api.get("/v1/usage/history?months=3");
        expect(body.history).toEqual([
            { month: "2026-10", used: 2, requests: { accepted: 1, rejected: 1 } },
            { month: "2026-09", used: 40, requests: { accepted: 1, rejected: 0 } },
            { month: "2026-08", used: 0, requests: { accepted: 0, rejected: 0 } },
        ]);
        expect((await acme.api.get("/v1/usage/history?months=121")).status).toBe(400);
    });
});

describe("GET /v1/requests", () => {
    it("lists decisions newest first with explanations and the enforced limits", async () => {
        await consumeVia(acme, "bob", "first", 4);
        await consumeVia(acme, "bob", "second", 11);
        const { body } = await acme.api.get("/v1/requests");
        expect(body.nextCursor).toBeNull();
        expect(body.requests.map((r: { requestId: string }) => r.requestId)).toEqual(["second", "first"]);
        expect(body.requests[0]).toMatchObject({
            requestId: "second",
            externalUserId: "bob",
            units: 11,
            month: "2026-10",
            decision: "rejected",
            rejectionRule: "user_max_per_request",
            rejectedBy: "user",
            limits: {
                account: { monthlyAllowance: 10000, maxPerRequest: 100, usedBefore: 4 },
                user: { monthlyAllowance: 20, maxPerRequest: 10, usedBefore: 4 },
            },
        });
        expect(body.requests[0].explanation).toContain("11 units is more than its limit of 10");
    });

    it("pages through every request exactly once", async () => {
        for (let i = 0; i < 25; i++) {
            await consumeVia(acme, i % 2 ? "alice" : "bob", `r${String(i).padStart(2, "0")}`, 1);
        }
        const { ids, pages } = await allPages("/v1/requests", 10);
        expect(pages).toBe(3);
        expect(ids).toHaveLength(25);
        expect(new Set(ids).size).toBe(25);
        expect(ids[0]).toBe("r24");
        expect(ids.at(-1)).toBe("r00");
    });

    it("pages correctly when many requests share the same timestamp", async () => {
        // now() is the transaction start time, so rows inserted in one transaction tie on created_at.
        const { rows } = await pool.query(
            "SELECT u.id AS user_id, a.plan_id AS ap, u.plan_id AS up FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.external_user_id = 'alice'",
        );
        const { user_id, ap, up } = rows[0];
        await pool.query(
            `INSERT INTO requests (account_id, user_id, request_id, units, month, decision, rejection_rule,
                 account_plan_id, user_plan_id, account_monthly_allowance, account_max_per_request,
                 user_monthly_allowance, user_max_per_request, account_used_before, user_used_before)
             SELECT $1, $2, 'tie-' || n, 1, '2026-10-01', 'rejected', 'user_max_per_request',
                    $3, $4, 10000, 100, 500, 50, 0, 0
               FROM generate_series(1, 7) n`,
            [acme.id, user_id, ap, up],
        );
        const { ids } = await allPages("/v1/requests", 3);
        expect(ids).toHaveLength(7);
        expect(new Set(ids).size).toBe(7);
    });

    it("filters by user, decision and month", async () => {
        clock.set("2026-09-10T00:00:00Z");
        await consumeVia(acme, "alice", "sep-a", 1);
        clock.set("2026-10-10T00:00:00Z");
        await consumeVia(acme, "alice", "oct-a", 1);
        await consumeVia(acme, "bob", "oct-b", 1);
        await consumeVia(acme, "bob", "oct-b-big", 50);

        const ids = async (query: string) =>
            (await acme.api.get(`/v1/requests?${query}`)).body.requests.map((r: { requestId: string }) => r.requestId);
        expect(await ids("externalUserId=alice")).toEqual(["oct-a", "sep-a"]);
        expect(await ids("decision=rejected")).toEqual(["oct-b-big"]);
        expect(await ids("month=2026-09")).toEqual(["sep-a"]);
        expect(await ids("externalUserId=bob&decision=accepted&month=2026-10")).toEqual(["oct-b"]);
    });

    it("validates filters and cursors", async () => {
        expect((await acme.api.get("/v1/requests?externalUserId=nobody")).status).toBe(404);
        expect((await acme.api.get("/v1/requests?decision=maybe")).status).toBe(400);
        expect((await acme.api.get("/v1/requests?month=2026-13")).status).toBe(400);
        expect((await acme.api.get("/v1/requests?month=October")).status).toBe(400);
        expect((await acme.api.get("/v1/requests?cursor=abc")).status).toBe(400);
        const forged = Buffer.from(JSON.stringify(["2026-10-01 garbage", "x"])).toString("base64url");
        expect((await acme.api.get(`/v1/requests?cursor=${forged}`)).status).toBe(400);
    });
});

describe("GET /v1/requests/:requestId", () => {
    it("explains one past decision", async () => {
        await consumeVia(acme, "bob", "doc/42", 12);
        const { status, body } = await acme.api.get(`/v1/requests/${encodeURIComponent("doc/42")}`);
        expect(status).toBe(200);
        expect(body).toMatchObject({ requestId: "doc/42", decision: "rejected", rejectedBy: "user" });
        expect(body.explanation).toContain('plan of user "bob"');
        expect((await acme.api.get("/v1/requests/unknown")).status).toBe(404);
    });
});
