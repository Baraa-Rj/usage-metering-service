// The agent's tools. Reading a document is the metered action: it consumes the document's
// credit cost for the current end user through the metering service BEFORE the text is
// returned, exactly as the brief describes ("before processing a document, the backend
// asks the service to consume units for that user").
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import type { MeteringClient } from "../client/sdk.js";

/** One credit per started 500 characters, so longer documents cost more. */
export const CHARS_PER_CREDIT = 500;

export interface AgentDocument {
    name: string;
    title: string;
    credits: number;
    content: string;
    /** Content hash, part of the request id so a changed document is a new read. */
    digest: string;
}

export async function loadDocuments(
    directory: URL = new URL("./documents/", import.meta.url),
): Promise<Map<string, AgentDocument>> {
    const documents = new Map<string, AgentDocument>();
    for (const name of (await readdir(directory)).filter((file) => file.endsWith(".md")).sort()) {
        const content = await readFile(new URL(name, directory), "utf8");
        documents.set(name, {
            name,
            title: content.split("\n", 1)[0]!.replace(/^#\s*/, ""),
            credits: Math.max(1, Math.ceil(content.length / CHARS_PER_CREDIT)),
            content,
            digest: createHash("sha256").update(content).digest("hex").slice(0, 16),
        });
    }
    return documents;
}

export interface ToolContext {
    /** A client authenticated as the application's account. */
    metering: MeteringClient;
    /** The end user the agent works for. Fixed by the application, never chosen by the model. */
    externalUserId: string;
    /** One id per agent run; re-reading a document in the same run is a free replay. */
    sessionId: string;
    documents: Map<string, AgentDocument>;
}

export function createTools(ctx: ToolContext): BetaRunnableTool[] {
    const listDocuments = betaZodTool({
        name: "list_documents",
        description:
            "List the documents available to the user, with each document's credit cost. Free. " +
            "Call this first to see what exists and what reading it would cost.",
        inputSchema: z.object({}),
        run: async () =>
            JSON.stringify(
                [...ctx.documents.values()].map(({ name, title, credits }) => ({ name, title, credits })),
            ),
    });

    const checkQuota = betaZodTool({
        name: "check_quota",
        description:
            "Check how many credits the current user can still spend this month, under both their own " +
            "plan and the company's shared plan, and the largest single read allowed right now. Free. " +
            "Call this before reading documents when you need to know what fits, and whenever the user " +
            "asks about their credits.",
        inputSchema: z.object({}),
        run: async () => {
            const usage = await ctx.metering.getUserUsage(ctx.externalUserId);
            return JSON.stringify({
                month: usage.month,
                userCreditsLeft: usage.user.remaining,
                userPlan: {
                    name: usage.user.plan.name,
                    monthlyAllowance: usage.user.monthlyAllowance,
                    maxPerRead: usage.user.maxPerRequest,
                    usedThisMonth: usage.user.used,
                },
                companyCreditsLeft: usage.account.remaining,
                companyPlan: {
                    name: usage.account.plan.name,
                    monthlyAllowance: usage.account.monthlyAllowance,
                    maxPerRead: usage.account.maxPerRequest,
                },
                largestReadAllowedNow: usage.maxConsumableNow,
            });
        },
    });

    const readDocument = betaZodTool({
        name: "read_document",
        description:
            "Read the full text of one document so you can summarize it or answer questions about it. " +
            "Billed to the current user: the document's credit cost is consumed from their monthly quota " +
            "before the text is returned, and the metering service may refuse the read. Read only the " +
            "documents the task needs. Re-reading a document already read in this conversation is free.",
        inputSchema: z.object({
            name: z.string().describe("The document's file name exactly as list_documents returns it"),
        }),
        run: async ({ name }) => {
            const document = ctx.documents.get(name);
            if (!document) {
                throw new Error(`No document named "${name}". Call list_documents for the available names.`);
            }
            // The same document in the same run has the same request id, so a repeated read
            // (or a network retry inside the client) replays the first decision: no double charge.
            const result = await ctx.metering.consume({
                externalUserId: ctx.externalUserId,
                requestId: `agent:${ctx.sessionId}:${document.name}:${document.digest}`,
                units: document.credits,
            });
            if (result.decision === "rejected") {
                return JSON.stringify({
                    status: "refused",
                    document: name,
                    creditsRequired: document.credits,
                    refusedBy: result.rejectedBy === "account" ? "the company's shared plan" : "the user's own plan",
                    rule: result.rejectionRule,
                    explanation: result.explanation,
                    note: "The document was NOT read. Do not guess its contents.",
                });
            }
            const charged = result.replayed ? 0 : document.credits;
            return (
                `<document name="${name}" credits_charged="${charged}" user_credits_left="${result.userRemaining}">\n` +
                `${document.content}\n</document>`
            );
        },
    });

    const recentActivity = betaZodTool({
        name: "recent_activity",
        description:
            "List the user's most recent metered reads, newest first, each with its decision and the " +
            "metering service's explanation. Free. Call this when the user asks what they spent credits " +
            "on or why a read was refused.",
        inputSchema: z.object({
            limit: z.number().int().min(1).max(20).optional().describe("How many entries, default 10"),
        }),
        run: async ({ limit }) => {
            const page = await ctx.metering.listRequests({ externalUserId: ctx.externalUserId, limit: limit ?? 10 });
            return JSON.stringify(
                page.requests.map((r) => ({
                    when: r.createdAt,
                    credits: r.units,
                    decision: r.decision,
                    explanation: r.explanation,
                })),
            );
        },
    });

    return [listDocuments, checkQuota, readDocument, recentActivity];
}
