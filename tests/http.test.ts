// App-level behaviour: health, routing, body parsing, and API key authentication.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, api, createAccount, resetWithSeed, startServer, type TestServer } from "./api.js";
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

describe("app", () => {
    it("reports health, checking the database", async () => {
        expect(await api(server.url).get("/health")).toEqual({ status: 200, body: { status: "ok" } });
    });

    it("answers unknown routes with a 404 in the error envelope", async () => {
        const { status, body } = await api(server.url).get("/nope");
        expect(status).toBe(404);
        expect(body).toEqual({ error: { code: "not_found", message: "route not found" } });
    });

    it("rejects malformed JSON with a 400, not a 500", async () => {
        const { status, body } = await api(server.url, ADMIN_KEY).send("POST", "/v1/accounts", {
            body: "{bad",
        });
        expect(status).toBe(400);
        expect(body.error.code).toBe("validation_error");
    });

    it("rejects a body over 10kb with a 413", async () => {
        const { status, body } = await api(server.url, ADMIN_KEY).post("/v1/accounts", {
            name: "x".repeat(20_000),
        });
        expect(status).toBe(413);
        expect(body.error.code).toBe("payload_too_large");
    });

    it("rejects a body that is not a JSON object", async () => {
        const { status } = await api(server.url, ADMIN_KEY).post("/v1/accounts", [1, 2]);
        expect(status).toBe(400);
    });

    it("does not advertise the framework", async () => {
        const response = await fetch(`${server.url}/health`);
        expect(response.headers.get("x-powered-by")).toBeNull();
    });
});

describe("api key authentication", () => {
    it("rejects a request with no API key (401)", async () => {
        for (const path of ["/v1/account", "/v1/plans", "/v1/users", "/v1/usage", "/v1/requests"]) {
            const { status, body } = await api(server.url).get(path);
            expect(status, path).toBe(401);
            expect(body.error.code).toBe("unauthorized");
        }
        expect((await api(server.url).post("/v1/consume", {})).status).toBe(401);
    });

    it("rejects an unknown or malformed API key (401)", async () => {
        expect((await api(server.url, "ums_not-a-real-key").get("/v1/account")).status).toBe(401);
        const malformed = await api(server.url).send("GET", "/v1/account", {
            headers: { authorization: "Token abc" },
        });
        expect(malformed.status).toBe(401);
    });

    it("accepts a valid key, with the Bearer scheme in any case", async () => {
        const acme = await createAccount(server.url, "Acme");
        expect((await acme.api.get("/v1/account")).status).toBe(200);
        const lower = await api(server.url).send("GET", "/v1/account", {
            headers: { authorization: `bearer ${acme.apiKey}` },
        });
        expect(lower.status).toBe(200);
    });

    it("authenticates before routing, so unknown /v1 paths do not reveal what exists", async () => {
        expect((await api(server.url).get("/v1/secret-admin-thing")).status).toBe(401);
        const acme = await createAccount(server.url, "Acme");
        expect((await acme.api.get("/v1/secret-admin-thing")).status).toBe(404);
    });

    it("requires the admin key to create accounts; an account key is not enough (403)", async () => {
        const acme = await createAccount(server.url, "Acme");
        expect((await api(server.url).post("/v1/accounts", { name: "Evil" })).status).toBe(403);
        expect((await acme.api.post("/v1/accounts", { name: "Evil" })).status).toBe(403);
    });

    it("the admin key is not an account key", async () => {
        expect((await api(server.url, ADMIN_KEY).get("/v1/account")).status).toBe(401);
    });

    it("stores only a hash of the key", async () => {
        const acme = await createAccount(server.url, "Acme");
        expect(acme.apiKey).toMatch(/^ums_[0-9a-f]{64}$/);
        const { rows } = await pool.query("SELECT api_key_hash FROM accounts WHERE id = $1", [acme.id]);
        expect(rows[0].api_key_hash).not.toContain(acme.apiKey);
        expect(rows[0].api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
