// Load tests against a running service. Each scenario measures throughput and latency and
// then checks correctness: counters must equal the accepted decisions exactly.
//
//   npm run build && npm start                     (or: docker compose up service)
//   SERVICE_URL=http://localhost:3000 npm run loadtest
//
// LOADTEST_SCALE multiplies request counts (default 1). LOADTEST_SCENARIOS picks a subset
// (e.g. "hot-account,retries"). Results are printed and written to loadtest/results.md
// (or LOADTEST_OUTPUT). Run it against a disposable database: it creates many accounts.
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { MeteringClient } from "../client/sdk.js";

const BASE_URL = process.env.SERVICE_URL ?? "http://localhost:3000";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "dev-admin-key";
const SCALE = Number(process.env.LOADTEST_SCALE ?? 1);
const RUN_ID = Date.now().toString(36);

interface Outcome {
    status: number;
    decision?: string;
    rejectionRule?: string | null;
    replayed?: boolean;
}

interface ScenarioResult {
    name: string;
    description: string;
    requests: number;
    concurrency: number;
    seconds: number;
    throughput: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    errors: number;
    accepted: number;
    rejected: number;
    replayed: number;
    checks: Array<{ name: string; ok: boolean }>;
}

const admin = { baseUrl: BASE_URL, adminApiKey: ADMIN_API_KEY };
const LOAD_USER_PLAN = { scope: "user", name: "Load", monthlyAllowance: 1_000_000_000, maxPerRequest: 1000 } as const;

/** An account on Pro with `users` users on a plan large enough never to be the limit. */
async function setUpAccount(label: string, users: number, plan = "Pro") {
    const account = await MeteringClient.createAccount(admin, { name: `load ${RUN_ID} ${label}`, plan });
    const client = new MeteringClient({ baseUrl: BASE_URL, apiKey: account.apiKey });
    await client.createPlan(LOAD_USER_PLAN);
    for (let i = 0; i < users; i++) {
        await client.registerUser({ externalUserId: `user-${i}`, plan: LOAD_USER_PLAN.name });
    }
    return { apiKey: account.apiKey, client };
}

async function consumeRaw(apiKey: string, body: { externalUserId: string; requestId: string; units: number }): Promise<Outcome> {
    try {
        const response = await fetch(`${BASE_URL}/v1/consume`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        return { status: response.status, decision: data.decision, rejectionRule: data.rejectionRule, replayed: data.replayed };
    } catch {
        return { status: 0 };
    }
}

const percentile = (sorted: number[], p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** Sends `count` requests with at most `concurrency` in flight. */
async function drive(count: number, concurrency: number, send: (i: number) => Promise<Outcome>) {
    const latencies = new Array<number>(count);
    const outcomes = new Array<Outcome>(count);
    let next = 0;
    const started = performance.now();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            for (;;) {
                const i = next++;
                if (i >= count) return;
                const t0 = performance.now();
                outcomes[i] = await send(i);
                latencies[i] = performance.now() - t0;
            }
        }),
    );
    const seconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    return { seconds, latencies, outcomes };
}

async function scenario(
    name: string,
    description: string,
    count: number,
    concurrency: number,
    send: (i: number) => Promise<Outcome>,
    verify: (outcomes: Outcome[]) => Promise<Array<{ name: string; ok: boolean }>>,
): Promise<ScenarioResult> {
    process.stdout.write(`${name}: ${count} requests, concurrency ${concurrency} ... `);
    const { seconds, latencies, outcomes } = await drive(count, concurrency, send);
    const ok = outcomes.filter((o) => o.status === 200);
    const result: ScenarioResult = {
        name,
        description,
        requests: count,
        concurrency,
        seconds,
        throughput: count / seconds,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.at(-1) ?? 0,
        errors: count - ok.length,
        accepted: ok.filter((o) => o.decision === "accepted" && !o.replayed).length,
        rejected: ok.filter((o) => o.decision === "rejected" && !o.replayed).length,
        replayed: ok.filter((o) => o.replayed).length,
        checks: [],
    };
    result.checks = [{ name: "no errors", ok: result.errors === 0 }, ...(await verify(outcomes))];
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
    console.log(`${result.throughput.toFixed(0)} req/s, p95 ${result.p95.toFixed(1)} ms` +
        (failed.length ? `, FAILED: ${failed.join("; ")}` : ", checks passed"));
    return result;
}

// A deterministic shuffle, so runs are comparable.
function shuffled<T>(items: T[]): T[] {
    const out = [...items];
    let seed = 42;
    for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

async function main() {
    const n = (count: number) => Math.max(1, Math.round(count * SCALE));
    await new MeteringClient({ baseUrl: BASE_URL }).waitUntilHealthy();
    console.log(`Load test against ${BASE_URL} (scale ${SCALE})\n`);
    const results: ScenarioResult[] = [];

    // Warm-up: connections, JIT, Postgres caches. Not reported.
    const warm = await setUpAccount("warmup", 5);
    await drive(500, 32, (i) => consumeRaw(warm.apiKey, { externalUserId: `user-${i % 5}`, requestId: `w${i}`, units: 1 }));

    const scenarios: Record<string, () => Promise<ScenarioResult>> = {
        // Many accounts: the common case, little lock contention.
        spread: async () => {
            const accounts = await Promise.all(Array.from({ length: 20 }, (_, i) => setUpAccount(`spread-${i}`, 5)));
            const count = n(20_000);
            return scenario(
                "spread",
                "20 accounts x 5 users, 1 unit each",
                count,
                64,
                (i) => consumeRaw(accounts[i % 20]!.apiKey, { externalUserId: `user-${(i >> 5) % 5}`, requestId: `s${i}`, units: 1 }),
                async () => {
                    const used = (await Promise.all(accounts.map((a) => a.client.getUsage()))).reduce((sum, u) => sum + u.used, 0);
                    return [{ name: `sum of account counters = ${count}`, ok: used === count }];
                },
            );
        },

        // One busy account: every consume waits for the same account counter lock.
        "hot-account": async () => {
            const hot = await setUpAccount("hot-account", 50);
            const count = n(10_000);
            return scenario(
                "hot-account",
                "1 account x 50 users, 1 unit each",
                count,
                64,
                (i) => consumeRaw(hot.apiKey, { externalUserId: `user-${i % 50}`, requestId: `h${i}`, units: 1 }),
                async () => [{ name: `account counter = ${count}`, ok: (await hot.client.getUsage()).used === count }],
            );
        },

        // One user: both locks contended.
        "hot-user": async () => {
            const single = await setUpAccount("hot-user", 1);
            const count = n(5_000);
            return scenario(
                "hot-user",
                "1 account x 1 user, 1 unit each",
                count,
                64,
                (i) => consumeRaw(single.apiKey, { externalUserId: "user-0", requestId: `u${i}`, units: 1 }),
                async () => [
                    { name: `user counter = ${count}`, ok: (await single.client.getUserUsage("user-0")).user.used === count },
                ],
            );
        },

        // Running out of allowance under load: exactly the allowance may be accepted.
        exhaustion: async () => {
            const tight = await setUpAccount("exhaustion", 10);
            await tight.client.createPlan({ scope: "account", name: "Tight", monthlyAllowance: 1000, maxPerRequest: 10 });
            await tight.client.updateAccount({ plan: "Tight" });
            return scenario(
                "exhaustion",
                "allowance 1,000; 3,000 requests of 1 unit from 10 users",
                3000,
                100,
                (i) => consumeRaw(tight.apiKey, { externalUserId: `user-${i % 10}`, requestId: `x${i}`, units: 1 }),
                async (outcomes) => {
                    const accepted = outcomes.filter((o) => o.decision === "accepted").length;
                    const wrongRule = outcomes.filter(
                        (o) => o.decision === "rejected" && o.rejectionRule !== "account_monthly_allowance",
                    ).length;
                    return [
                        { name: "exactly 1,000 accepted", ok: accepted === 1000 },
                        { name: "every rejection is account_monthly_allowance", ok: wrongRule === 0 },
                        { name: "account counter = 1,000", ok: (await tight.client.getUsage()).used === 1000 },
                    ];
                },
            );
        },

        // Retry storm: every request id is sent 10 times, concurrently and out of order.
        retries: async () => {
            const retry = await setUpAccount("retries", 10);
            const ids = shuffled(Array.from({ length: 3000 }, (_, i) => i % 300));
            return scenario(
                "retries",
                "300 request ids, each sent 10 times, shuffled",
                ids.length,
                100,
                (i) => consumeRaw(retry.apiKey, { externalUserId: `user-${ids[i]! % 10}`, requestId: `r${ids[i]}`, units: 1 }),
                async (outcomes) => [
                    { name: "300 counted, 2,700 replayed", ok: outcomes.filter((o) => o.replayed).length === 2700 },
                    { name: "account counter = 300", ok: (await retry.client.getUsage()).used === 300 },
                ],
            );
        },
    };

    // LOADTEST_SCENARIOS=hot-account,retries runs a subset.
    const selected = process.env.LOADTEST_SCENARIOS?.split(",").map((s) => s.trim()) ?? Object.keys(scenarios);
    for (const name of selected) {
        const run = scenarios[name];
        if (!run) throw new Error(`unknown scenario "${name}"; known: ${Object.keys(scenarios).join(", ")}`);
        results.push(await run());
    }

    await writeResults(results);
    if (results.some((r) => r.checks.some((c) => !c.ok))) {
        process.exitCode = 1;
    }
}

async function writeResults(results: ScenarioResult[]) {
    const ms = (value: number) => value.toFixed(1);
    const lines = [
        "# Load test results",
        "",
        `Run ${new Date().toISOString()} against ${BASE_URL} (scale ${SCALE}).`,
        "",
        `Machine: ${os.cpus()[0]?.model ?? "unknown CPU"}, ${os.cpus().length} threads, ` +
            `${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.type()} ${os.release()}, Node ${process.version}.`,
        process.env.LOADTEST_SERVER_NOTE ? `Server: ${process.env.LOADTEST_SERVER_NOTE}.` : "",
        "The load generator, the service and PostgreSQL ran on the same machine.",
        "",
        "| Scenario | Requests | Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Errors | Accepted | Rejected | Replayed |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ...results.map((r) =>
            `| ${r.name}: ${r.description} | ${r.requests} | ${r.concurrency} | ${r.throughput.toFixed(0)} | ` +
                `${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${r.errors} | ${r.accepted} | ${r.rejected} | ${r.replayed} |`,
        ),
        "",
        "## Correctness checks",
        "",
        ...results.flatMap((r) => r.checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${r.name}: ${c.name}`)),
        "",
    ];
    const markdown = lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n");
    const output = process.env.LOADTEST_OUTPUT ?? new URL("./results.md", import.meta.url);
    await writeFile(output, markdown);
    console.log(`\nWrote ${output instanceof URL ? "loadtest/results.md" : output}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
