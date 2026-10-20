// Unit tests for decide() and remaining().
import { describe, expect, it } from "vitest";
import { decide, remaining } from "../src/decision.js";

const limits = (monthlyAllowance: number, maxPerRequest: number, used = 0) => ({
    monthlyAllowance,
    maxPerRequest,
    used,
});

describe("decide", () => {
    it("accepts when both account and user allow", () => {
        expect(decide(10, limits(100, 40), limits(60, 25))).toEqual({
            decision: "accepted",
            rejectionRule: null,
        });
    });

    it("accepts a request that exactly reaches the allowance", () => {
        expect(decide(10, limits(100, 40, 90), limits(60, 25)).decision).toBe("accepted");
    });

    it("rejects a request one unit over the account allowance", () => {
        expect(decide(11, limits(100, 40, 90), limits(60, 25))).toEqual({
            decision: "rejected",
            rejectionRule: "account_monthly_allowance",
        });
    });

    it("reports the user max when only the user's per-request limit is exceeded", () => {
        expect(decide(30, limits(100, 40), limits(60, 25)).rejectionRule).toBe("user_max_per_request");
    });

    it("reports the user allowance when only the user's monthly allowance is exceeded", () => {
        expect(decide(10, limits(100, 40), limits(60, 25, 55)).rejectionRule).toBe(
            "user_monthly_allowance",
        );
    });

    it("reports the account max first when every rule fails", () => {
        expect(decide(500, limits(10, 5, 10), limits(10, 5, 10)).rejectionRule).toBe(
            "account_max_per_request",
        );
    });

    it("reports the account allowance first when only both allowances fail", () => {
        expect(decide(5, limits(10, 50, 10), limits(10, 50, 10)).rejectionRule).toBe(
            "account_monthly_allowance",
        );
    });
});

describe("remaining", () => {
    it("is the allowance minus usage", () => {
        expect(remaining(limits(100, 5, 45))).toBe(55);
    });

    it("is 0, never negative, when the allowance was lowered below usage", () => {
        expect(remaining(limits(10, 5, 45))).toBe(0);
    });
});
