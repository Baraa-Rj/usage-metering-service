// Creating accounts (admin) and managing the calling account's own name and plan.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    ADMIN_KEY,
    api,
    consumeVia,
    createAccount,
    createPlan,
    registerUsers,
    resetWithSeed,
    startServer,
    type TestServer,
} from "./api.js";
import { fixedClock, testPool } from "./helpers.js";

let pool: pg.Pool;
let server: TestServer;

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
});

const admin = () => api(server.url, ADMIN_KEY);

describe("POST /v1/accounts", () => {
    it("creates an account on Starter by default and returns its key once", async () => {
        const { status, body } = await admin().post("/v1/accounts", { name: "  Acme  " });
        expect(status).toBe(201);
        expect(body).toMatchObject({
            name: "Acme",
            plan: { name: "Starter", scope: "account", isPredefined: true, monthlyAllowance: 10000, maxPerRequest: 100 },
        });
        expect(body.apiKey).toMatch(/^ums_/);
        // The key is never shown again: the account endpoint does not include it.
        const self = await api(server.url, body.apiKey).get("/v1/account");
        expect(self.body.apiKey).toBeUndefined();
    });

    it("accepts a predefined plan by name (any case) or by id", async () => {
        const byName = await admin().post("/v1/accounts", { name: "A", plan: "pro" });
        expect(byName.body.plan.name).toBe("Pro");
        const byId = await admin().post("/v1/accounts", { name: "B", planId: byName.body.plan.id });
        expect(byId.status).toBe(201);
        expect(byId.body.plan.name).toBe("Pro");
    });

    it("rejects unknown plans, user plans, and plan together with planId", async () => {
        expect((await admin().post("/v1/accounts", { name: "A", plan: "Gold" })).status).toBe(400);
        const userPlan = await admin().post("/v1/accounts", { name: "A", plan: "Basic" });
        expect(userPlan.status).toBe(400);
        expect(userPlan.body.error.message).toContain("unknown account plan");
        expect((await admin().post("/v1/accounts", { name: "A", planId: "not-a-uuid" })).status).toBe(400);
        const both = await admin().post("/v1/accounts", { name: "A", plan: "Pro", planId: "x" });
        expect(both.status).toBe(400);
    });

    it("requires a non-blank name of at most 100 characters", async () => {
        expect((await admin().post("/v1/accounts", {})).status).toBe(400);
        expect((await admin().post("/v1/accounts", { name: "   " })).status).toBe(400);
        expect((await admin().post("/v1/accounts", { name: 42 })).status).toBe(400);
        expect((await admin().post("/v1/accounts", { name: "x".repeat(101) })).status).toBe(400);
    });

    it("treats names case-insensitively: a duplicate is a 409", async () => {
        expect((await admin().post("/v1/accounts", { name: "Acme" })).status).toBe(201);
        const duplicate = await admin().post("/v1/accounts", { name: "ACME" });
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.error.code).toBe("conflict");
    });

    it("creates exactly one account when the same name is submitted concurrently", async () => {
        const statuses = await Promise.all(
            Array.from({ length: 8 }, () => admin().post("/v1/accounts", { name: "Race" }).then((r) => r.status)),
        );
        expect(statuses.filter((s) => s === 201)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    });
});

describe("GET /v1/account", () => {
    it("returns the calling account with its plan", async () => {
        const acme = await createAccount(server.url, "Acme", "Pro");
        const { status, body } = await acme.api.get("/v1/account");
        expect(status).toBe(200);
        expect(body).toMatchObject({ id: acme.id, name: "Acme", plan: { name: "Pro" } });
    });
});

describe("PATCH /v1/account", () => {
    it("switches to another predefined plan; the next consume uses it and usage is kept", async () => {
        const acme = await createAccount(server.url, "Acme");
        await registerUsers(acme, { u1: "Premium" });
        expect((await consumeVia(acme, "u1", "r1", 80)).body.decision).toBe("accepted");
        // Starter allows at most 100 per request.
        expect((await consumeVia(acme, "u1", "r2", 150)).body.rejectionRule).toBe("account_max_per_request");

        const { status, body } = await acme.api.patch("/v1/account", { plan: "Pro" });
        expect(status).toBe(200);
        expect(body.plan.name).toBe("Pro");

        const retry = await consumeVia(acme, "u1", "r3", 150);
        expect(retry.body.decision).toBe("accepted");
        expect((await acme.api.get("/v1/usage")).body).toMatchObject({ used: 230, plan: { name: "Pro" } });
    });

    it("switches to one of its own custom account plans, by name or id", async () => {
        const acme = await createAccount(server.url, "Acme");
        const planId = await createPlan(acme, { scope: "account", name: "Enterprise", monthlyAllowance: 1_000_000, maxPerRequest: 5000 });
        expect((await acme.api.patch("/v1/account", { plan: "enterprise" })).body.plan.id).toBe(planId);
        expect((await acme.api.patch("/v1/account", { plan: "Starter" })).body.plan.name).toBe("Starter");
        expect((await acme.api.patch("/v1/account", { planId })).body.plan.name).toBe("Enterprise");
    });

    it("cannot use a user plan or an archived plan", async () => {
        const acme = await createAccount(server.url, "Acme");
        expect((await acme.api.patch("/v1/account", { plan: "Premium" })).status).toBe(400);
        const planId = await createPlan(acme, { scope: "account", name: "Old", monthlyAllowance: 10, maxPerRequest: 1 });
        await acme.api.delete(`/v1/plans/${planId}`);
        const archived = await acme.api.patch("/v1/account", { planId });
        expect(archived.status).toBe(400);
        expect(archived.body.error.message).toContain("archived");
    });

    it("renames the account; a name taken by another account is a 409", async () => {
        const acme = await createAccount(server.url, "Acme");
        await createAccount(server.url, "Globex");
        expect((await acme.api.patch("/v1/account", { name: "Acme Corp" })).body.name).toBe("Acme Corp");
        expect((await acme.api.patch("/v1/account", { name: "globex" })).status).toBe(409);
        // Changing only the case of its own name is fine.
        expect((await acme.api.patch("/v1/account", { name: "ACME CORP" })).status).toBe(200);
    });

    it("rejects empty updates and unknown fields", async () => {
        const acme = await createAccount(server.url, "Acme");
        expect((await acme.api.patch("/v1/account", {})).status).toBe(400);
        const typo = await acme.api.patch("/v1/account", { pln: "Pro" });
        expect(typo.status).toBe(400);
        expect(typo.body.error.message).toContain("unknown field");
    });
});
