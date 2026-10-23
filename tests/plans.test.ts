// Plans: predefined plans are read-only, custom plans are owned by one account and edited live.
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
import { fixedClock, testPool } from "./helpers.js";

let pool: pg.Pool;
let server: TestServer;
let acme: TestAccount;

const TRIAL = { scope: "user", name: "Trial", monthlyAllowance: 20, maxPerRequest: 10 } as const;

beforeAll(async () => {
    pool = testPool(10);
    server = await startServer(pool, fixedClock("2026-10-15T12:00:00Z"));
});

afterAll(async () => {
    await server.close();
    await pool.end();
});

beforeEach(async () => {
    await resetWithSeed(pool);
    acme = await createAccount(server.url, "Acme");
});

const predefinedId = async (name: string) => {
    const { body } = await acme.api.get("/v1/plans");
    return body.plans.find((plan: { name: string }) => plan.name === name).id as string;
};

describe("GET /v1/plans", () => {
    it("lists the predefined plans and the account's own custom plans", async () => {
        await createPlan(acme, TRIAL);
        const other = await createAccount(server.url, "Globex");
        await createPlan(other, { ...TRIAL, name: "Globex Secret" });

        const { status, body } = await acme.api.get("/v1/plans");
        expect(status).toBe(200);
        expect(body.plans.map((p: { name: string }) => p.name)).toEqual([
            "Pro",
            "Starter",
            "Basic",
            "Premium",
            "Trial",
        ]);
        expect(body.plans[4]).toMatchObject({ scope: "user", isPredefined: false, archivedAt: null });
    });

    it("filters by scope and hides archived plans unless asked", async () => {
        const trialId = await createPlan(acme, TRIAL);
        await acme.api.delete(`/v1/plans/${trialId}`);

        const accountPlans = await acme.api.get("/v1/plans?scope=account");
        expect(accountPlans.body.plans.map((p: { name: string }) => p.name)).toEqual(["Pro", "Starter"]);
        expect((await acme.api.get("/v1/plans")).body.plans).toHaveLength(4);
        const all = await acme.api.get("/v1/plans?includeArchived=true");
        expect(all.body.plans).toHaveLength(5);

        expect((await acme.api.get("/v1/plans?scope=team")).status).toBe(400);
        expect((await acme.api.get("/v1/plans?includeArchived=yes")).status).toBe(400);
    });
});

describe("GET /v1/plans/:id", () => {
    it("returns a predefined or own plan with where the account uses it", async () => {
        await registerUsers(acme, { u1: undefined, u2: undefined });
        const { status, body } = await acme.api.get(`/v1/plans/${await predefinedId("Basic")}`);
        expect(status).toBe(200);
        expect(body).toMatchObject({ name: "Basic", assignments: { account: false, users: 2 } });

        const starter = await acme.api.get(`/v1/plans/${await predefinedId("Starter")}`);
        expect(starter.body.assignments).toEqual({ account: true, users: 0 });
    });

    it("is a 404 for another account's plan, an unknown id, or a malformed id", async () => {
        const other = await createAccount(server.url, "Globex");
        const otherPlan = await createPlan(other, TRIAL);
        expect((await acme.api.get(`/v1/plans/${otherPlan}`)).status).toBe(404);
        expect((await acme.api.get("/v1/plans/00000000-0000-0000-0000-000000000000")).status).toBe(404);
        expect((await acme.api.get("/v1/plans/not-a-uuid")).status).toBe(404);
    });
});

describe("POST /v1/plans", () => {
    it("creates a custom plan owned by the account", async () => {
        const { status, body } = await acme.api.post("/v1/plans", TRIAL);
        expect(status).toBe(201);
        expect(body).toMatchObject({
            scope: "user",
            name: "Trial",
            monthlyAllowance: 20,
            maxPerRequest: 10,
            isPredefined: false,
            archivedAt: null,
        });
    });

    it("validates scope and limits; an allowance of 0 is allowed, a max per request of 0 is not", async () => {
        expect((await acme.api.post("/v1/plans", { ...TRIAL, monthlyAllowance: 0 })).status).toBe(201);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, name: "B", maxPerRequest: 0 })).status).toBe(400);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, name: "C", monthlyAllowance: -1 })).status).toBe(400);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, name: "D", monthlyAllowance: 1.5 })).status).toBe(400);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, name: "E", scope: "team" })).status).toBe(400);
        expect((await acme.api.post("/v1/plans", { scope: "user", name: "F" })).status).toBe(400);
        const typo = await acme.api.post("/v1/plans", { ...TRIAL, name: "G", maxPerRequst: 5 });
        expect(typo.status).toBe(400);
    });

    it("cannot reuse a predefined plan's name in the same scope (any case)", async () => {
        const clash = await acme.api.post("/v1/plans", { ...TRIAL, name: "basic" });
        expect(clash.status).toBe(409);
        expect(clash.body.error.message).toContain("predefined user plan");
        // "Basic" is a user plan name, so an account plan may use it.
        expect((await acme.api.post("/v1/plans", { ...TRIAL, scope: "account", name: "Basic" })).status).toBe(201);
    });

    it("rejects a duplicate name in the same account and scope, ignoring case", async () => {
        await createPlan(acme, TRIAL);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, name: "TRIAL" })).status).toBe(409);
        expect((await acme.api.post("/v1/plans", { ...TRIAL, scope: "account" })).status).toBe(201);
        const other = await createAccount(server.url, "Globex");
        expect((await other.api.post("/v1/plans", TRIAL)).status).toBe(201);
    });
});

describe("PATCH /v1/plans/:id", () => {
    it("predefined plans are read-only (403)", async () => {
        const { status, body } = await acme.api.patch(`/v1/plans/${await predefinedId("Basic")}`, {
            monthlyAllowance: 1,
        });
        expect(status).toBe(403);
        expect(body.error.code).toBe("forbidden");
        expect((await acme.api.delete(`/v1/plans/${await predefinedId("Basic")}`)).status).toBe(403);
    });

    it("another account's plan looks like it does not exist (404)", async () => {
        const other = await createAccount(server.url, "Globex");
        const planId = await createPlan(other, TRIAL);
        expect((await acme.api.patch(`/v1/plans/${planId}`, { monthlyAllowance: 1 })).status).toBe(404);
        expect((await acme.api.delete(`/v1/plans/${planId}`)).status).toBe(404);
    });

    it("updates limits and name, and bumps updatedAt", async () => {
        const planId = await createPlan(acme, TRIAL);
        const { status, body } = await acme.api.patch(`/v1/plans/${planId}`, {
            name: "Trial Plus",
            monthlyAllowance: 50,
        });
        expect(status).toBe(200);
        expect(body).toMatchObject({ name: "Trial Plus", monthlyAllowance: 50, maxPerRequest: 10 });
        // Compared in SQL: microsecond precision, where JS Dates would round to milliseconds.
        const { rows } = await pool.query("SELECT updated_at > created_at AS bumped FROM plans WHERE id = $1", [planId]);
        expect(rows[0].bumped).toBe(true);
    });

    it("rejects scope changes, unknown fields, empty updates and predefined names", async () => {
        const planId = await createPlan(acme, TRIAL);
        expect((await acme.api.patch(`/v1/plans/${planId}`, { scope: "account" })).status).toBe(400);
        expect((await acme.api.patch(`/v1/plans/${planId}`, { allowance: 5 })).status).toBe(400);
        expect((await acme.api.patch(`/v1/plans/${planId}`, {})).status).toBe(400);
        expect((await acme.api.patch(`/v1/plans/${planId}`, { maxPerRequest: 0 })).status).toBe(400);
        expect((await acme.api.patch(`/v1/plans/${planId}`, { name: "Premium" })).status).toBe(409);
    });

    it("applies to the very next consume without a redeploy", async () => {
        const planId = await createPlan(acme, TRIAL);
        await registerUsers(acme, { bob: "Trial" });
        expect((await consumeVia(acme, "bob", "r1", 12)).body.rejectionRule).toBe("user_max_per_request");

        await acme.api.patch(`/v1/plans/${planId}`, { maxPerRequest: 15 });
        expect((await consumeVia(acme, "bob", "r2", 12)).body.decision).toBe("accepted");
    });

    it("lowering the allowance below usage keeps the usage and shows 0 remaining", async () => {
        const planId = await createPlan(acme, TRIAL);
        await registerUsers(acme, { bob: "Trial" });
        await consumeVia(acme, "bob", "r1", 10);
        await consumeVia(acme, "bob", "r2", 5);

        await acme.api.patch(`/v1/plans/${planId}`, { monthlyAllowance: 8 });
        const usage = (await acme.api.get("/v1/users/bob/usage")).body;
        expect(usage.user).toMatchObject({ used: 15, monthlyAllowance: 8, remaining: 0 });
        expect(usage.maxConsumableNow).toBe(0);
        expect((await consumeVia(acme, "bob", "r3", 1)).body.rejectionRule).toBe("user_monthly_allowance");

        // Past decisions keep the limits that were enforced when they were made.
        const old = (await acme.api.get("/v1/requests/r1")).body;
        expect(old.limits.user.monthlyAllowance).toBe(20);
        expect(old.explanation).toContain("Accepted");
    });
});

describe("DELETE /v1/plans/:id (archive)", () => {
    it("archives: existing users keep the plan, but it cannot be newly assigned", async () => {
        const planId = await createPlan(acme, TRIAL);
        await registerUsers(acme, { bob: "Trial" });

        const { status, body } = await acme.api.delete(`/v1/plans/${planId}`);
        expect(status).toBe(200);
        expect(body.archivedAt).not.toBeNull();
        expect(body.assignments).toEqual({ account: false, users: 1 });

        expect((await consumeVia(acme, "bob", "r1", 5)).body.decision).toBe("accepted");
        const assign = await acme.api.post("/v1/users", { externalUserId: "carol", plan: "Trial" });
        expect(assign.status).toBe(400);
        expect(assign.body.error.message).toContain("archived");
    });

    it("is idempotent and frees the name for a new plan", async () => {
        const planId = await createPlan(acme, TRIAL);
        const first = (await acme.api.delete(`/v1/plans/${planId}`)).body;
        const second = (await acme.api.delete(`/v1/plans/${planId}`)).body;
        expect(second.archivedAt).toBe(first.archivedAt);

        const replacement = await acme.api.post("/v1/plans", TRIAL);
        expect(replacement.status).toBe(201);
        expect((await acme.api.post("/v1/users", { externalUserId: "dan", plan: "Trial" })).body.plan.id).toBe(
            replacement.body.id,
        );
    });
});
