// Integration tests: replay, rejection order, plan edits, month rollover, concurrency.
import { describe, it } from "vitest";

describe("consume", () => {
    it.todo("accepts and counts usage on both the account and the user");
    it.todo("a rejection consumes nothing");
    it.todo("replays the stored decision for a retried request_id without counting again");
    it.todo("rejects a reused request_id with different units or user (409)");
    it.todo("reports the first failing rule in order: account max, user max, account allowance, user allowance");
    it.todo("applies a plan edit to the next request and keeps existing usage");
    it.todo("shows 0 remaining when the allowance is lowered below usage");
    it.todo("starts a fresh counter in a new UTC month");
    it.todo("keeps 23:59:59 UTC on the last day of the month in the old month");
    it.todo("rejects an unknown user (404)");
    it.todo("accepts exactly the allowed number of concurrent requests");
    it.todo("counts concurrent retries of one request_id once");
});
