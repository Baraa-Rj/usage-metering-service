// HTTP test harness: runs the real app on a random port against the test database.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { createApp } from "../src/app.js";
import type { Clock } from "../src/clock.js";
import { config } from "../src/config.js";
import { reset } from "./helpers.js";

export const ADMIN_KEY = config.adminApiKey;

export interface TestServer {
    url: string;
    close(): Promise<void>;
}

export async function startServer(pool: pg.Pool, clock: Clock): Promise<TestServer> {
    const server = createApp(pool, clock).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

/** Empties every table, then restores the predefined plans the API relies on. */
export async function resetWithSeed(pool: pg.Pool): Promise<void> {
    await reset(pool);
    const seed = await readFile(new URL("../migrations/002_seed_plans.sql", import.meta.url), "utf8");
    await pool.query(seed);
}

export interface ApiResponse {
    status: number;
    // Response bodies are checked field by field in the tests.
    body: any;
}

export interface Api {
    get(path: string): Promise<ApiResponse>;
    post(path: string, body?: unknown): Promise<ApiResponse>;
    patch(path: string, body?: unknown): Promise<ApiResponse>;
    delete(path: string): Promise<ApiResponse>;
    send(method: string, path: string, init?: { body?: string; headers?: Record<string, string> }): Promise<ApiResponse>;
}

export function api(baseUrl: string, key?: string): Api {
    const send: Api["send"] = async (method, path, init = {}) => {
        const response = await fetch(baseUrl + path, {
            method,
            headers: {
                ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
                ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
                ...init.headers,
            },
            body: init.body,
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const withBody = (method: string) => (path: string, body?: unknown) =>
        send(method, path, body === undefined ? {} : { body: JSON.stringify(body) });
    return {
        get: (path) => send("GET", path),
        post: withBody("POST"),
        patch: withBody("PATCH"),
        delete: (path) => send("DELETE", path),
        send,
    };
}

export interface TestAccount {
    id: string;
    apiKey: string;
    api: Api;
}

export async function createAccount(baseUrl: string, name: string, plan?: string): Promise<TestAccount> {
    const { status, body } = await api(baseUrl, ADMIN_KEY).post("/v1/accounts", { name, plan });
    if (status !== 201) {
        throw new Error(`creating account ${name} failed: ${status} ${JSON.stringify(body)}`);
    }
    return { id: body.id, apiKey: body.apiKey, api: api(baseUrl, body.apiKey) };
}

/** Registers users, failing loudly so a broken setup does not look like a broken test. */
export async function registerUsers(account: TestAccount, users: Record<string, string | undefined>) {
    for (const [externalUserId, plan] of Object.entries(users)) {
        const { status, body } = await account.api.post("/v1/users", { externalUserId, plan });
        if (status !== 201) {
            throw new Error(`registering ${externalUserId} failed: ${status} ${JSON.stringify(body)}`);
        }
    }
}

/** A custom plan owned by the account; returns its id. */
export async function createPlan(
    account: TestAccount,
    plan: { scope: "account" | "user"; name: string; monthlyAllowance: number; maxPerRequest: number },
): Promise<string> {
    const { status, body } = await account.api.post("/v1/plans", plan);
    if (status !== 201) {
        throw new Error(`creating plan ${plan.name} failed: ${status} ${JSON.stringify(body)}`);
    }
    return body.id;
}

export async function consumeVia(account: TestAccount, externalUserId: string, requestId: string, units: number) {
    return account.api.post("/v1/consume", { externalUserId, requestId, units });
}
