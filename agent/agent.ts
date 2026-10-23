// The agent loop: Claude with the metered document tools, driven by the SDK's tool runner.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

export const MODEL = "claude-opus-5-5";

export function systemPrompt(externalUserId: string): string {
    return [
        `You are the document assistant inside DocuFlow, a document-processing app. You work for one end user ("${externalUserId}"), and every document you read is billed to that user's monthly credits by a usage-metering service.`,
        "",
        "Reading a document costs credits, and the metering service can refuse a read when the user's own plan or the company's shared plan does not allow it. So:",
        "- Use list_documents to see what exists and what each document costs, and check_quota when you need to know whether a read will fit.",
        "- Read only the documents the task needs.",
        "- If a read is refused, do not guess the document's contents. Tell the user which document could not be read and why, using the metering service's explanation, and finish the rest of the task with what you could read.",
        "- When the user asks about their credits or spending, answer from check_quota and recent_activity.",
        "",
        "Keep answers short and concrete.",
    ].join("\n");
}

export type AgentEvent =
    | { type: "tool_call"; name: string; input: unknown }
    | { type: "text"; text: string };

export interface AgentResult {
    /** The final answer, or a short notice when the run could not finish normally. */
    text: string;
    stopReason: string | null;
    toolCalls: Array<{ name: string; input: unknown }>;
}

export interface RunAgentOptions {
    anthropic: Anthropic;
    tools: BetaRunnableTool[];
    task: string;
    externalUserId: string;
    maxIterations?: number;
    onEvent?: (event: AgentEvent) => void;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
    const runner = options.anthropic.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // If a safety classifier declines a turn, Anthropic re-runs it on a recommended
        // fallback model instead of returning a refusal.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: systemPrompt(options.externalUserId),
        tools: options.tools,
        messages: [{ role: "user", content: options.task }],
        max_iterations: options.maxIterations ?? 12,
    });

    const toolCalls: AgentResult["toolCalls"] = [];
    let last: Anthropic.Beta.BetaMessage | undefined;
    // Each iteration yields Claude's message before its tool calls run; the runner then
    // executes the tools and sends the results back until Claude stops calling tools.
    for await (const message of runner) {
        last = message;
        for (const block of message.content) {
            if (block.type === "tool_use") {
                toolCalls.push({ name: block.name, input: block.input });
                options.onEvent?.({ type: "tool_call", name: block.name, input: block.input });
            } else if (block.type === "text" && block.text.trim() !== "") {
                options.onEvent?.({ type: "text", text: block.text });
            }
        }
    }

    const stopReason = last?.stop_reason ?? null;
    if (stopReason === "refusal") {
        return { text: "The model declined this request.", stopReason, toolCalls };
    }
    const text = (last?.content ?? [])
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (stopReason === "tool_use") {
        return { text: text || "Stopped: the agent reached its step limit before finishing.", stopReason, toolCalls };
    }
    return { text, stopReason, toolCalls };
}
