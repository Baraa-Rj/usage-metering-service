// Example client: the backend of "DocuFlow", a document-processing app, metering its users
// through the service. It walks through onboarding, custom plans, consume decisions,
// retries, a live plan edit, and the read endpoints, and checks each outcome, so it also
// works as an end-to-end smoke test (exit code 1 if anything is unexpected).
//
//   SERVICE_URL=http://localhost:3000 ADMIN_API_KEY=dev-admin-key npm run demo
import { pathToFileURL } from "node:url";
import { MeteringClient, type ConsumeResult } from "./sdk.js";

export interface DemoOptions {
    baseUrl: string;
    adminApiKey: string;
    accountName?: string;
    log?: (line: string) => void;
}

export interface DemoSummary {
    accountId: string;
    decisions: Array<Pick<ConsumeResult, "requestId" | "decision" | "rejectionRule" | "replayed">>;
}

function check(condition: boolean, message: string): void {
    if (!condition) throw new Error(`demo expectation failed: ${message}`);
}

export async function runDemo(options: DemoOptions): Promise<DemoSummary> {
    const log = options.log ?? console.log;
    const service = new MeteringClient({ baseUrl: options.baseUrl });
    const decisions: DemoSummary["decisions"] = [];

    log(`Waiting for ${options.baseUrl} ...`);
    await service.waitUntilHealthy();

    // 1. Onboarding: the operator creates the account; its key is shown once.
    const accountName = options.accountName ?? `DocuFlow ${new Date().toISOString()}`;
    const created = await MeteringClient.createAccount(
        { baseUrl: options.baseUrl, adminApiKey: options.adminApiKey },
        { name: accountName, plan: "Starter" },
    );
    const docuflow = service.withApiKey(created.apiKey);
    log(`\n1. Created account "${created.name}" on ${created.plan.name}: ` +
        `${created.plan.monthlyAllowance} units/month, at most ${created.plan.maxPerRequest} per request.`);

    // 2. A custom plan for trial users, and two users.
    const trial = await docuflow.createPlan({ scope: "user", name: "Trial", monthlyAllowance: 20, maxPerRequest: 10 });
    await docuflow.registerUser({ externalUserId: "alice", plan: "Premium" });
    await docuflow.registerUser({ externalUserId: "bob", plan: "Trial" });
    log(`2. Created custom user plan "Trial" (20/month, 10 per request); registered alice (Premium) and bob (Trial).`);

    // 3. Process documents: one page = one unit, consumed before the work is done.
    log("\n3. Processing documents (1 page = 1 unit):");
    const processDocument = async (externalUserId: string, document: string, pages: number, requestId = `doc:${document}`) => {
        const result = await docuflow.consume({ externalUserId, requestId, units: pages });
        decisions.push({
            requestId: result.requestId,
            decision: result.decision,
            rejectionRule: result.rejectionRule,
            replayed: result.replayed,
        });
        const mark = result.decision === "accepted" ? "OK  " : "NO  ";
        log(`   ${mark}${externalUserId.padEnd(6)} ${document.padEnd(22)} ${String(pages).padStart(3)} pages${result.replayed ? " (retry)" : ""}`);
        log(`       ${result.explanation}`);
        return result;
    };

    check((await processDocument("bob", "intro.pdf", 8)).decision === "accepted", "bob's 8 pages are accepted");
    check((await processDocument("bob", "contract.pdf", 7)).decision === "accepted", "bob's 7 pages are accepted");
    const tooBig = await processDocument("bob", "thesis.pdf", 12);
    check(tooBig.rejectionRule === "user_max_per_request", "12 pages exceed Trial's 10 per request");
    const overQuota = await processDocument("bob", "invoice.pdf", 6);
    check(overQuota.rejectionRule === "user_monthly_allowance", "15 + 6 pages exceed Trial's 20 per month");
    check((await processDocument("alice", "annual-report.pdf", 40)).decision === "accepted", "alice's 40 pages are accepted");
    const huge = await processDocument("alice", "archive.pdf", 150);
    check(huge.rejectionRule === "account_max_per_request", "150 pages exceed Starter's 100 per request");

    // 4. A network retry with the same request id is answered from the stored decision.
    log("\n4. Retrying intro.pdf with the same request id (e.g. after a timeout):");
    const retry = await processDocument("bob", "intro.pdf", 8);
    check(retry.replayed && retry.decision === "accepted", "the retry is replayed");
    check((await docuflow.getUserUsage("bob")).user.used === 15, "the retry counted nothing");

    // 5. Raise the Trial allowance live. A new attempt needs a new request id: retrying the
    //    old id would replay its stored rejection.
    await docuflow.updatePlan(trial.id, { monthlyAllowance: 50 });
    log('\n5. Raised "Trial" to 50 units/month (no redeploy). Trying invoice.pdf again as a new request:');
    const second = await processDocument("bob", "invoice.pdf", 6, "doc:invoice.pdf:attempt-2");
    check(second.decision === "accepted", "the new attempt is accepted under the edited plan");

    // 6. Read side: usage, remaining, history, and the request log with explanations.
    const usage = await docuflow.getUsage();
    const bob = await docuflow.getUserUsage("bob");
    log(`\n6. Usage in ${usage.month}:`);
    log(`   account: ${usage.used} used of ${usage.monthlyAllowance}, ${usage.remaining} left`);
    log(`   bob:     ${bob.user.used} used of ${bob.user.monthlyAllowance}, ${bob.user.remaining} left; ` +
        `largest request possible now: ${bob.maxConsumableNow} units`);
    check(usage.used === 15 + 40 + 6, "account usage counts accepted documents only");

    const [thisMonth] = await docuflow.getUsageHistory(1);
    log(`   history: ${thisMonth?.month} -> ${thisMonth?.requests.accepted} accepted, ${thisMonth?.requests.rejected} rejected`);

    const rejected = await docuflow.listRequests({ decision: "rejected", limit: 10 });
    log(`   rejected requests (${rejected.requests.length}), newest first:`);
    for (const record of rejected.requests) {
        log(`     ${record.requestId.padEnd(22)} rejected by the ${record.rejectedBy} plan (${record.rejectionRule})`);
    }
    check(rejected.requests.length === 3, "three rejections are on record");

    log("\nDemo finished: every decision matched what was expected.");
    return { accountId: created.id, decisions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runDemo({
        baseUrl: process.env.SERVICE_URL ?? "http://localhost:3000",
        adminApiKey: process.env.ADMIN_API_KEY ?? "dev-admin-key",
    }).catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    });
}
