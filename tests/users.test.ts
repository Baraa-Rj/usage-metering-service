// Users: registration, listing, plan changes, and per-user usage and history.
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
    pool = testPool(10);
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
});

describe("POST /v1/users", () => {
    it("registers a user on Basic by default", async () => {
        const { status, body } = await acme.api.post("/v1/users", { externalUserId: "alice" });
        expect(status).toBe(201);
        expect(body).toMatchObject({ externalUserId: "alice", plan: { name: "Basic", scope: "user" } });
    });

    it("accepts a predefined or own custom user plan, by name (any case) or id", async () => {
        const trialId = await createPlan(acme, { scope: "user", name: "Trial", monthlyAllowance: 20, maxPerRequest: 10 });
        expect((await acme.api.post("/v1/users", { externalUserId: "a", plan: "premium" })).body.plan.name).toBe("Premium");
        expect((await acme.api.post("/v1/users", { externalUserId: "b", plan: "TRIAL" })).body.plan.id).toBe(trialId);
        expect((await acme.api.post("/v1/users", { externalUserId: "c", planId: trialId })).body.plan.name).toBe("Trial");
    });

    it("rejects account plans, unknown plans and missing ids", async () => {
        const accountPlan = await acme.api.post("/v1/users", { externalUserId: "a", plan: "Pro" });
        expect(accountPlan.status).toBe(400);
        expect(accountPlan.body.error.message).toContain("unknown user plan");
        expect((await acme.api.post("/v1/users", { externalUserId: "a", plan: "Gold" })).status).toBe(400);
        expect((await acme.api.post("/v1/users", {})).status).toBe(400);
        expect((await acme.api.post("/v1/users", { externalUserId: "x".repeat(101) })).status).toBe(400);
    });

    it("a duplicate id within the account is a 409", async () => {
        await registerUsers(acme, { alice: undefined });
        const { status, body } = await acme.api.post("/v1/users", { externalUserId: "alice" });
        expect(status).toBe(409);
        expect(body.error.code).toBe("conflict");
    });
});

describe("GET /v1/users", () => {
    it("pages through users in id order with a cursor", async () => {
        const ids = ["g", "a", "e", "c", "b", "f", "d"];
        await registerUsers(acme, Object.fromEntries(ids.map((id) => [id, undefined])));

        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const path: string = `/v1/users?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
            const { body } = await acme.api.get(path);
            seen.push(...body.users.map((u: { externalUserId: string }) => u.externalUserId));
            cursor = body.nextCursor;
            pages += 1;
        } while (cursor);

        expect(pages).toBe(3);
        expect(seen).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    });

    it("validates limit and cursor", async () => {
        expect((await acme.api.get("/v1/users?limit=0")).status).toBe(400);
        expect((await acme.api.get("/v1/users?limit=101")).status).toBe(400);
        expect((await acme.api.get("/v1/users?limit=abc")).status).toBe(400);
        expect((await acme.api.get("/v1/users?cursor=garbage")).status).toBe(400);
        expect((await acme.api.get("/v1/users?limit=1&limit=2")).status).toBe(400);
    });
});

describe("GET and PATCH /v1/users/:id", () => {
    it("returns a user; ids with special characters work when URL-encoded", async () => {
        await registerUsers(acme, { "ann@example.com": undefined, "team/42": "Premium" });
        expect((await acme.api.get("/v1/users/ann%40example.com")).body.externalUserId).toBe("ann@example.com");
        expect((await acme.api.get(`/v1/users/${encodeURIComponent("team/42")}`)).body.plan.name).toBe("Premium");
        expect((await acme.api.get("/v1/users/nobody")).status).toBe(404);
    });

    it("changes a user's plan; the next consume uses it and usage is kept", async () => {
        await registerUsers(acme, { alice: undefined });
        await consumeVia(acme, "alice", "r1", 40);
        // Basic allows 50 per request.
        expect((await consumeVia(acme, "alice", "r2", 60)).body.rejectionRule).toBe("user_max_per_request");

        const { status, body } = await acme.api.patch("/v1/users/alice", { plan: "Premium" });
        expect(status).toBe(200);
        expect(body.plan.name).toBe("Premium");
        expect((await consumeVia(acme, "alice", "r3", 60)).body.decision).toBe("accepted");
        expect((await acme.api.get("/v1/users/alice/usage")).body.user.used).toBe(100);
    });

    it("rejects bad plan changes", async () => {
        await registerUsers(acme, { alice: undefined });
        expect((await acme.api.patch("/v1/users/alice", {})).status).toBe(400);
        expect((await acme.api.patch("/v1/users/alice", { plan: "Starter" })).status).toBe(400);
        expect((await acme.api.patch("/v1/users/alice", { externalUserId: "bob" })).status).toBe(400);
        expect((await acme.api.patch("/v1/users/nobody", { plan: "Premium" })).status).toBe(404);
    });
});

describe("GET /v1/users/:id/usage", () => {
    it("shows the user's and the account's usage this month", async () => {
        await registerUsers(acme, { alice: undefined });
        const fresh = (await acme.api.get("/v1/users/alice/usage")).body;
        expect(fresh).toMatchObject({
            month: "2026-10",
            externalUserId: "alice",
            user: { plan: { name: "Basic" }, used: 0, monthlyAllowance: 500, maxPerRequest: 50, remaining: 500 },
            account: { plan: { name: "Starter" }, used: 0, monthlyAllowance: 10000, maxPerRequest: 100, remaining: 10000 },
            maxConsumableNow: 50,
        });

        await consumeVia(acme, "alice", "r1", 30);
        const after = (await acme.api.get("/v1/users/alice/usage")).body;
        expect(after.user).toMatchObject({ used: 30, remaining: 470 });
        expect(after.account).toMatchObject({ used: 30, remaining: 9970 });
    });

    it("maxConsumableNow is limited by whichever limit is tightest", async () => {
        await createPlan(acme, { scope: "user", name: "Tiny", monthlyAllowance: 12, maxPerRequest: 10 });
        await registerUsers(acme, { bob: "Tiny" });
        await consumeVia(acme, "bob", "r1", 5);
        expect((await acme.api.get("/v1/users/bob/usage")).body.maxConsumableNow).toBe(7);
    });

    it("lists monthly history with every month present, newest first", async () => {
        await registerUsers(acme, { alice: undefined });
        clock.set("2026-08-03T00:00:00Z");
        await consumeVia(acme, "alice", "aug-1", 10);
        await consumeVia(acme, "alice", "aug-2", 99); // rejected: over Basic's 50 per request
        clock.set("2026-10-31T23:59:59Z");
        await consumeVia(acme, "alice", "oct-1", 7);

        const { status, body } = await acme.api.get("/v1/users/alice/usage/history?months=4");
        expect(status).toBe(200);
        expect(body.history).toEqual([
            { month: "2026-10", used: 7, requests: { accepted: 1, rejected: 0 } },
            { month: "2026-09", used: 0, requests: { accepted: 0, rejected: 0 } },
            { month: "2026-08", used: 10, requests: { accepted: 1, rejected: 1 } },
            { month: "2026-07", used: 0, requests: { accepted: 0, rejected: 0 } },
        ]);
        expect((await acme.api.get("/v1/users/alice/usage/history")).body.history).toHaveLength(12);
        expect((await acme.api.get("/v1/users/alice/usage/history?months=0")).status).toBe(400);
    });
});
