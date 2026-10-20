// The consume transaction: lock counters in fixed order, replay by request_id, decide, record.
// Skeleton: tests/consume.test.ts describes the behaviour this must have.
import type pg from "pg";
import type { Clock } from "./clock.js";
import type { RejectionRule } from "./decision.js";

export interface ConsumeInput {
    accountId: string;
    externalUserId: string;
    requestId: string;
    units: number;
}

export interface ConsumeResult {
    requestId: string;
    decision: "accepted" | "rejected";
    rejectionRule: RejectionRule | null;
    units: number;
    /** true when this was a retry and the stored decision was returned. */
    replayed: boolean;
    accountRemaining: number;
    userRemaining: number;
}

export async function consume(
    pool: pg.Pool,
    clock: Clock,
    input: ConsumeInput,
): Promise<ConsumeResult> {
    void pool;
    void clock;
    void input;
    throw new Error("not implemented");
}
