// CLI for the AI document agent.
//
//   npm run agent -- "Summarize every document, then tell me how many credits I have left"
//
// Environment:
//   ANTHROPIC_API_KEY  Claude credentials (or any credential source the Anthropic SDK resolves)
//   SERVICE_URL        metering service, default http://localhost:3000
//   METERING_API_KEY   an account API key; when unset, a demo account is created with ADMIN_API_KEY
//   ADMIN_API_KEY      default dev-admin-key
//   AGENT_USER_ID      the end user the agent works for, default "reader-1"
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { MeteringClient, MeteringError } from "../client/sdk.js";
import { MODEL, runAgent } from "./agent.js";
import { createTools, loadDocuments } from "./tools.js";

const DEFAULT_TASK =
    "Summarize each available document in two sentences, then tell me how many credits I have left this month.";

// A small user plan, so a "read everything" task meets a limit and the agent has to explain it.
const DEMO_USER_PLAN = { scope: "user", name: "Agent Trial", monthlyAllowance: 10, maxPerRequest: 5 } as const;

async function connectMetering(baseUrl: string, externalUserId: string): Promise<MeteringClient> {
    const service = new MeteringClient({ baseUrl });
    await service.waitUntilHealthy();

    const existingKey = process.env.METERING_API_KEY;
    if (existingKey) {
        const metering = service.withApiKey(existingKey);
        try {
            await metering.registerUser({ externalUserId });
        } catch (err) {
            if (!(err instanceof MeteringError && err.status === 409)) throw err; // already registered
        }
        return metering;
    }

    const account = await MeteringClient.createAccount(
        { baseUrl, adminApiKey: process.env.ADMIN_API_KEY ?? "dev-admin-key" },
        { name: `Agent demo ${new Date().toISOString()}` },
    );
    const metering = service.withApiKey(account.apiKey);
    await metering.createPlan(DEMO_USER_PLAN);
    await metering.registerUser({ externalUserId, plan: DEMO_USER_PLAN.name });
    console.log(
        `Created demo account "${account.name}"; user "${externalUserId}" is on "${DEMO_USER_PLAN.name}" ` +
            `(${DEMO_USER_PLAN.monthlyAllowance} credits/month, at most ${DEMO_USER_PLAN.maxPerRequest} per read).`,
    );
    console.log(`Reuse this account with METERING_API_KEY=${account.apiKey}\n`);
    return metering;
}

// Fails fast, before anything is created in the metering service, when no Claude
// credentials can be found. The Models API lookup is free.
async function checkClaudeCredentials(anthropic: Anthropic): Promise<void> {
    try {
        await anthropic.models.retrieve(MODEL);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Cannot reach Claude: ${reason}\nSet ANTHROPIC_API_KEY (or run \`ant auth login\`) and try again.`,
        );
    }
}

async function main(): Promise<void> {
    const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;
    const externalUserId = process.env.AGENT_USER_ID ?? "reader-1";
    const anthropic = new Anthropic();
    await checkClaudeCredentials(anthropic);
    const metering = await connectMetering(process.env.SERVICE_URL ?? "http://localhost:3000", externalUserId);
    const documents = await loadDocuments();
    const tools = createTools({ metering, externalUserId, sessionId: randomUUID(), documents });

    console.log(`Task: ${task}\n`);
    const result = await runAgent({
        anthropic,
        tools,
        task,
        externalUserId,
        onEvent: (event) => {
            if (event.type === "tool_call") {
                console.log(`  -> ${event.name} ${JSON.stringify(event.input)}`);
            }
        },
    });
    console.log(`\n${result.text}\n`);

    const usage = await metering.getUserUsage(externalUserId);
    console.log(`Metering: ${externalUserId} used ${usage.user.used} of ${usage.user.monthlyAllowance} credits in ${usage.month}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        if (err instanceof Anthropic.AuthenticationError) {
            console.error("Claude rejected the credentials: set ANTHROPIC_API_KEY (or run `ant auth login`).");
        } else if (err instanceof Anthropic.APIError) {
            console.error(`Claude API error ${err.status}: ${err.message}`);
        } else {
            console.error(err instanceof Error ? err.message : err);
        }
        process.exitCode = 1;
    });
}
