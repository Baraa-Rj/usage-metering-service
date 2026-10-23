// The example client: the demo runs end to end, and the SDK retries consume safely.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MeteringClient, MeteringError } from "../client/sdk.js";
import { runDemo } from "../client/demo.js";
import { ADMIN_KEY, resetWithSeed, startServer, type TestServer } from "./api.js";
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

async function newAccount(fetchImpl?: typeof fetch) {
    const created = await MeteringClient.createAccount({ baseUrl: server.url, adminApiKey: ADMIN_KEY }, { name: "Acme" });
    const client = new MeteringClient({ baseUrl: server.url, apiKey: created.apiKey, fetch: fetchImpl });
    await client.registerUser({ externalUserId: "u1" });
    return client;
}

describe("demo client", () => {
    it("runs the whole walkthrough against the service", async () => {
        const lines: string[] = [];
        const summary = await runDemo({ baseUrl: server.url, adminApiKey: ADMIN_KEY, log: (line) => lines.push(line) });
        expect(summary.decisions.map((d) => [d.requestId, d.decision, d.rejectionRule, d.replayed])).toEqual([
            ["doc:intro.pdf", "accepted", null, false],
            ["doc:contract.pdf", "accepted", null, false],
            ["doc:thesis.pdf", "rejected", "user_max_per_request", false],
            ["doc:invoice.pdf", "rejected", "user_monthly_allowance", false],
            ["doc:annual-report.pdf", "accepted", null, false],
            ["doc:archive.pdf", "rejected", "account_max_per_request", false],
            ["doc:intro.pdf", "accepted", null, true],
            ["doc:invoice.pdf:attempt-2", "accepted", null, false],
        ]);
        expect(lines.at(-1)).toContain("every decision matched");
    });
});

describe("MeteringClient", () => {
    it("turns error responses into MeteringError with status and code", async () => {
        const client = await newAccount();
        const error = await client.getUser("nobody").catch((err: unknown) => err);
        expect(error).toBeInstanceOf(MeteringError);
        expect(error).toMatchObject({ status: 404, code: "not_found" });
    });

    it("retries consume after a network error before the request arrived", async () => {
        let calls = 0;
        const flaky: typeof fetch = async (input, init) => {
            calls += 1;
            if (calls === 3) throw new TypeError("fetch failed"); // the consume, first attempt
            return fetch(input, init);
        };
        const client = await newAccount(flaky);
        const result = await client.consume({ externalUserId: "u1", requestId: "r1", units: 5 });
        expect(result).toMatchObject({ decision: "accepted", replayed: false });
        expect((await client.getUserUsage("u1")).user.used).toBe(5);
    });

    it("retries safely when the response was lost after the server counted the units", async () => {
        let lostOne = false;
        const losesFirstConsumeResponse: typeof fetch = async (input, init) => {
            const response = await fetch(input, init);
            if (!lostOne && String(input).endsWith("/v1/consume")) {
                lostOne = true;
                throw new TypeError("socket hang up"); // the server already committed
            }
            return response;
        };
        const client = await newAccount(losesFirstConsumeResponse);
        const result = await client.consume({ externalUserId: "u1", requestId: "r1", units: 5 });
        expect(result).toMatchObject({ decision: "accepted", replayed: true });
        expect((await client.getUserUsage("u1")).user.used).toBe(5);
    });

    it("does not retry non-idempotent calls such as registering a user", async () => {
        let calls = 0;
        const failing: typeof fetch = async (input, init) => {
            if (String(input).endsWith("/v1/users") && init?.method === "POST") {
                calls += 1;
                throw new TypeError("fetch failed");
            }
            return fetch(input, init);
        };
        const created = await MeteringClient.createAccount({ baseUrl: server.url, adminApiKey: ADMIN_KEY }, { name: "Acme" });
        const client = new MeteringClient({ baseUrl: server.url, apiKey: created.apiKey, fetch: failing });
        await expect(client.registerUser({ externalUserId: "u1" })).rejects.toThrow("fetch failed");
        expect(calls).toBe(1);
    });
});
