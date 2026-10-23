// API key auth and cross-account isolation tests: one account must never see or affect another.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    api,
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
let globex: TestAccount;

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
    globex = await createAccount(server.url, "Globex");
    await registerUsers(acme, { "acme-user": undefined });
    await consumeVia(acme, "acme-user", "acme-request", 7);
});

describe("api key auth", () => {
    it("rejects a request with no API key (401)", async () => {
        const anonymous = api(server.url);
        expect((await anonymous.get("/v1/users/acme-user")).status).toBe(401);
        expect((await anonymous.get("/v1/requests/acme-request")).status).toBe(401);
        expect((await anonymous.post("/v1/consume", { externalUserId: "acme-user", requestId: "x", units: 1 })).status).toBe(401);
    });

    it("rejects a request with an unknown API key (401)", async () => {
        const forged = api(server.url, `${acme.apiKey}0`);
        expect((await forged.get("/v1/usage")).status).toBe(401);
        expect((await forged.post("/v1/consume", { externalUserId: "acme-user", requestId: "x", units: 1 })).status).toBe(401);
    });
});

describe("account isolation", () => {
    it("an account cannot read another account's users, usage or requests", async () => {
        expect((await globex.api.get("/v1/users/acme-user")).status).toBe(404);
        expect((await globex.api.get("/v1/users/acme-user/usage")).status).toBe(404);
        expect((await globex.api.get("/v1/users/acme-user/usage/history")).status).toBe(404);
        expect((await globex.api.get("/v1/requests/acme-request")).status).toBe(404);
        expect((await globex.api.get("/v1/requests?externalUserId=acme-user")).status).toBe(404);

        expect((await globex.api.get("/v1/users")).body.users).toEqual([]);
        expect((await globex.api.get("/v1/requests")).body.requests).toEqual([]);
        expect((await globex.api.get("/v1/usage")).body.used).toBe(0);
        expect((await globex.api.get("/v1/usage/history?months=1")).body.history[0].used).toBe(0);
        expect((await globex.api.get("/v1/account")).body.name).toBe("Globex");
    });

    it("an account cannot consume for another account's user", async () => {
        const { status } = await consumeVia(globex, "acme-user", "steal", 1);
        expect(status).toBe(404);
        expect((await acme.api.get("/v1/users/acme-user/usage")).body.user.used).toBe(7);
        expect((await acme.api.get("/v1/requests")).body.requests).toHaveLength(1);
    });

    it("an account cannot assign or edit another account's custom plan", async () => {
        const userPlan = await createPlan(acme, { scope: "user", name: "Acme VIP", monthlyAllowance: 1e6, maxPerRequest: 1e5 });
        const accountPlan = await createPlan(acme, { scope: "account", name: "Acme Max", monthlyAllowance: 1e9, maxPerRequest: 1e6 });

        expect((await globex.api.get(`/v1/plans/${userPlan}`)).status).toBe(404);
        expect((await globex.api.patch(`/v1/plans/${userPlan}`, { monthlyAllowance: 0 })).status).toBe(404);
        expect((await globex.api.delete(`/v1/plans/${userPlan}`)).status).toBe(404);
        const listed = (await globex.api.get("/v1/plans?includeArchived=true")).body.plans;
        expect(listed.map((p: { id: string }) => p.id)).not.toContain(userPlan);

        expect((await globex.api.post("/v1/users", { externalUserId: "g1", planId: userPlan })).status).toBe(400);
        expect((await globex.api.post("/v1/users", { externalUserId: "g1", plan: "Acme VIP" })).status).toBe(400);
        expect((await globex.api.patch("/v1/account", { planId: accountPlan })).status).toBe(400);
        expect((await globex.api.patch("/v1/account", { plan: "Acme Max" })).status).toBe(400);

        // Acme's plan is untouched.
        expect((await acme.api.get(`/v1/plans/${userPlan}`)).body).toMatchObject({ monthlyAllowance: 1e6, archivedAt: null });
    });

    it("the same request_id under two accounts is two independent requests", async () => {
        await registerUsers(globex, { "globex-user": undefined });
        const result = await consumeVia(globex, "globex-user", "acme-request", 3);
        expect(result.body).toMatchObject({ decision: "accepted", replayed: false });
        // Acme's request with that id is unchanged, and so is its usage.
        expect((await acme.api.get("/v1/requests/acme-request")).body.units).toBe(7);
        expect((await acme.api.get("/v1/usage")).body.used).toBe(7);
        expect((await globex.api.get("/v1/usage")).body.used).toBe(3);
    });

    it("the same external user id under two accounts is two different users", async () => {
        await registerUsers(globex, { "acme-user": "Premium" });
        await consumeVia(globex, "acme-user", "g-1", 100);

        const inAcme = (await acme.api.get("/v1/users/acme-user/usage")).body;
        const inGlobex = (await globex.api.get("/v1/users/acme-user/usage")).body;
        expect(inAcme.user).toMatchObject({ used: 7, plan: { name: "Basic" } });
        expect(inGlobex.user).toMatchObject({ used: 100, plan: { name: "Premium" } });
        const ids = [(await acme.api.get("/v1/users/acme-user")).body.id, (await globex.api.get("/v1/users/acme-user")).body.id];
        expect(ids[0]).not.toBe(ids[1]);
    });
});
