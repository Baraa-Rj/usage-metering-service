// The AI agent: its metered tools against the real service, and the agent loop with a
// scripted model (a fake transport answers the Messages API), so no API key is needed.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAgent, MODEL } from "../agent/agent.js";
import { createTools, loadDocuments, type AgentDocument } from "../agent/tools.js";
import { MeteringClient } from "../client/sdk.js";
import { ADMIN_KEY, resetWithSeed, startServer, type TestServer } from "./api.js";
import { fixedClock, testPool } from "./helpers.js";

let pool: pg.Pool;
let server: TestServer;
let documents: Map<string, AgentDocument>;
let metering: MeteringClient;

const USER = "reader-1";

beforeAll(async () => {
    pool = testPool(10);
    server = await startServer(pool, fixedClock("2026-10-15T12:00:00Z"));
    documents = await loadDocuments();
});

afterAll(async () => {
    await server.close();
    await pool.end();
});

async function setUp(plan: { monthlyAllowance: number; maxPerRequest: number }) {
    const created = await MeteringClient.createAccount({ baseUrl: server.url, adminApiKey: ADMIN_KEY }, { name: "DocuFlow" });
    metering = new MeteringClient({ baseUrl: server.url, apiKey: created.apiKey });
    await metering.createPlan({ scope: "user", name: "Agent Trial", ...plan });
    await metering.registerUser({ externalUserId: USER, plan: "Agent Trial" });
}

beforeEach(async () => {
    await resetWithSeed(pool);
    await setUp({ monthlyAllowance: 10, maxPerRequest: 5 });
});

function tools(sessionId = "session-1") {
    return createTools({ metering, externalUserId: USER, sessionId, documents });
}

async function runTool(name: string, input: unknown, sessionId?: string): Promise<string> {
    const tool = tools(sessionId).find((t) => (t as { name: string }).name === name) as BetaRunnableTool & {
        run: (input: unknown) => Promise<unknown>;
    };
    const output = await tool.run(input);
    if (typeof output !== "string") throw new Error(`${name} returned content blocks, expected text`);
    return output;
}

describe("documents", () => {
    it("cost one credit per started 500 characters", () => {
        expect([...documents.values()].map((d) => [d.name, d.credits])).toEqual([
            ["onboarding-guide.md", 2],
            ["product-roadmap.md", 6],
            ["q3-sales-report.md", 3],
            ["security-policy.md", 3],
        ]);
    });
});

describe("agent tools", () => {
    it("list_documents and check_quota are free", async () => {
        const list = JSON.parse(await runTool("list_documents", {}));
        expect(list).toHaveLength(4);
        expect(list[0]).toEqual({ name: "onboarding-guide.md", title: "DocuFlow Onboarding Guide", credits: 2 });

        const quota = JSON.parse(await runTool("check_quota", {}));
        expect(quota).toMatchObject({
            userCreditsLeft: 10,
            userPlan: { name: "Agent Trial", monthlyAllowance: 10, maxPerRead: 5, usedThisMonth: 0 },
            largestReadAllowedNow: 5,
        });
        expect((await metering.getUserUsage(USER)).user.used).toBe(0);
    });

    it("read_document consumes credits before returning the text; a re-read is free", async () => {
        const first = await runTool("read_document", { name: "security-policy.md" });
        expect(first).toContain('credits_charged="3" user_credits_left="7"');
        expect(first).toContain("Information Security Policy");

        const again = await runTool("read_document", { name: "security-policy.md" });
        expect(again).toContain('credits_charged="0"');
        expect((await metering.getUserUsage(USER)).user.used).toBe(3);
    });

    it("a refused read returns the service's explanation and no document text", async () => {
        const tooBig = JSON.parse(await runTool("read_document", { name: "product-roadmap.md" }));
        expect(tooBig).toMatchObject({
            status: "refused",
            creditsRequired: 6,
            refusedBy: "the user's own plan",
            rule: "user_max_per_request",
        });
        expect(tooBig.explanation).toContain("6 units is more than its limit of 5");
        expect(JSON.stringify(tooBig)).not.toContain("Roadmap");

        await runTool("read_document", { name: "security-policy.md" });
        await runTool("read_document", { name: "q3-sales-report.md" });
        await runTool("read_document", { name: "onboarding-guide.md" });
        // 8 of 10 used: a 3-credit read no longer fits.
        const overQuota = JSON.parse(await runTool("read_document", { name: "q3-sales-report.md" }, "session-2"));
        expect(overQuota).toMatchObject({ status: "refused", rule: "user_monthly_allowance" });
        expect((await metering.getUserUsage(USER)).user.used).toBe(8);
    });

    it("an unknown document is an error, so the model can correct itself", async () => {
        await expect(runTool("read_document", { name: "secrets.md" })).rejects.toThrow("list_documents");
    });

    it("recent_activity shows decisions with explanations", async () => {
        await runTool("read_document", { name: "onboarding-guide.md" });
        await runTool("read_document", { name: "product-roadmap.md" });
        const activity = JSON.parse(await runTool("recent_activity", { limit: 5 }));
        expect(activity.map((a: { decision: string }) => a.decision)).toEqual(["rejected", "accepted"]);
        expect(activity[0].explanation).toContain("Rejected");
    });
});

// ---- the agent loop with a scripted model ----

type Block = Record<string, unknown>;

function message(id: string, content: Block[], stopReason: "tool_use" | "end_turn") {
    return {
        id,
        type: "message",
        role: "assistant",
        model: MODEL,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
    };
}

function scriptedAnthropic(replies: object[]) {
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
        });
        const reply = replies[requests.length - 1];
        if (!reply) throw new Error("the agent made more model calls than scripted");
        return new Response(JSON.stringify(reply), {
            status: 200,
            headers: { "content-type": "application/json", "request-id": `req_${requests.length}` },
        });
    };
    const anthropic = new Anthropic({ apiKey: "test-key", fetch: fakeFetch as typeof fetch, maxRetries: 0 });
    return { anthropic, requests };
}

describe("runAgent", () => {
    it("runs the tool loop: lists, reads, gets refused, and reports the refusal", async () => {
        const { anthropic, requests } = scriptedAnthropic([
            message("msg_1", [{ type: "tool_use", id: "toolu_1", name: "list_documents", input: {} }], "tool_use"),
            message(
                "msg_2",
                [
                    { type: "tool_use", id: "toolu_2", name: "read_document", input: { name: "security-policy.md" } },
                    { type: "tool_use", id: "toolu_3", name: "read_document", input: { name: "product-roadmap.md" } },
                ],
                "tool_use",
            ),
            message(
                "msg_3",
                [{ type: "text", text: "The security policy requires 2FA. The roadmap could not be read: it costs 6 credits and your plan allows 5 per read." }],
                "end_turn",
            ),
        ]);
        const events: string[] = [];

        const result = await runAgent({
            anthropic,
            tools: tools(),
            task: "Summarize the security policy and the roadmap.",
            externalUserId: USER,
            onEvent: (event) => events.push(event.type === "tool_call" ? event.name : "text"),
        });

        expect(result.stopReason).toBe("end_turn");
        expect(result.text).toContain("could not be read");
        expect(result.toolCalls.map((c) => c.name)).toEqual(["list_documents", "read_document", "read_document"]);
        expect(events).toEqual(["list_documents", "read_document", "read_document", "text"]);

        // The request: current model, server-side refusal fallback, the four tools, the user in the system prompt.
        const first = requests[0]!;
        expect(first.url).toContain("/v1/messages");
        expect(first.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", max_tokens: 16000 });
        expect(first.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
        expect(first.body.tools.map((t: { name: string }) => t.name)).toEqual([
            "list_documents",
            "check_quota",
            "read_document",
            "recent_activity",
        ]);
        expect(first.body.system).toContain(`"${USER}"`);

        // Both tool results went back in one user message: the text, and the refusal with its reason.
        const lastTurn = requests[2]!.body.messages.at(-1);
        expect(lastTurn.role).toBe("user");
        const results = lastTurn.content.map((block: { tool_use_id: string; content: unknown }) => [
            block.tool_use_id,
            JSON.stringify(block.content),
        ]);
        expect(results[0][0]).toBe("toolu_2");
        expect(results[0][1]).toContain("Information Security Policy");
        expect(results[1][0]).toBe("toolu_3");
        expect(results[1][1]).toContain("user_max_per_request");

        // The metering service counted the one read that was allowed, and recorded both decisions.
        expect((await metering.getUserUsage(USER)).user.used).toBe(3);
        const log = await metering.listRequests({ externalUserId: USER });
        expect(log.requests.map((r) => r.decision)).toEqual(["rejected", "accepted"]);
    });

    it("reports a refusal stop reason instead of an empty answer", async () => {
        const { anthropic } = scriptedAnthropic([message("msg_1", [], "end_turn")].map((m) => ({ ...m, stop_reason: "refusal" })));
        const result = await runAgent({ anthropic, tools: tools(), task: "anything", externalUserId: USER });
        expect(result).toMatchObject({ stopReason: "refusal", text: "The model declined this request." });
    });
});
