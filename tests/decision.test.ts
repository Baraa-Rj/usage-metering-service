// Unit tests for decide(), remaining(), rejectedBy() and explainDecision().
import { describe, expect, it } from "vitest";
import { decide, explainDecision, rejectedBy, remaining } from "../src/decision.js";

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

describe("rejectedBy", () => {
    it("names the plan that made the decision", () => {
        expect(rejectedBy(null)).toBeNull();
        expect(rejectedBy("account_max_per_request")).toBe("account");
        expect(rejectedBy("account_monthly_allowance")).toBe("account");
        expect(rejectedBy("user_max_per_request")).toBe("user");
        expect(rejectedBy("user_monthly_allowance")).toBe("user");
    });
});

describe("explainDecision", () => {
    const snapshot = (monthlyAllowance: number, maxPerRequest: number, usedBefore: number) => ({
        monthlyAllowance,
        maxPerRequest,
        usedBefore,
    });
    const record = { units: 25, externalUserId: "u1", account: snapshot(100, 40, 30), user: snapshot(60, 25, 45) };

    it("states what is left after an accepted request", () => {
        expect(explainDecision({ ...record, units: 1, rejectionRule: null })).toBe(
            'Accepted: 1 unit counted. 69 units left this month for the account and 14 units for user "u1".',
        );
    });

    it("names the per-request limit that was exceeded", () => {
        expect(explainDecision({ ...record, units: 41, rejectionRule: "account_max_per_request" })).toBe(
            "Rejected by the account's plan: 41 units is more than its limit of 40 units per request.",
        );
        expect(explainDecision({ ...record, rejectionRule: "user_max_per_request", units: 26 })).toBe(
            'Rejected by the plan of user "u1": 26 units is more than its limit of 25 units per request.',
        );
    });

    it("shows used, allowance and what is left for an exhausted allowance", () => {
        expect(explainDecision({ ...record, units: 71, rejectionRule: "account_monthly_allowance" })).toBe(
            "Rejected by the account's plan: 30 of its 100 monthly units are already used, " +
                "so 71 units more would exceed the allowance (70 units left).",
        );
        expect(explainDecision({ ...record, rejectionRule: "user_monthly_allowance" })).toBe(
            'Rejected by the plan of user "u1": 45 of its 60 monthly units are already used, ' +
                "so 25 units more would exceed the allowance (15 units left).",
        );
    });

    it("never reports a negative amount left when usage is above a lowered allowance", () => {
        const lowered = { ...record, user: snapshot(10, 25, 45), units: 1 };
        expect(explainDecision({ ...lowered, rejectionRule: "user_monthly_allowance" })).toContain("(0 units left)");
    });
});
