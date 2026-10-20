// Pure decide(units, account, user) -> accepted | rejected(rule), plus remaining().

export type RejectionRule =
    | "account_max_per_request"
    | "user_max_per_request"
    | "account_monthly_allowance"
    | "user_monthly_allowance";

export interface Limits {
    monthlyAllowance: number;
    maxPerRequest: number;
    used: number;
}

export type Decision =
    {
        decision: "accepted";
        rejectionRule: null;
    }
    | {
        decision: "rejected";
        rejectionRule: RejectionRule;
    };

// Both the account and the user must allow the request. When several rules fail,
// the first one in this order is reported: per-request limits before monthly
// allowances, account before user. A request over a per-request max can never
// succeed, so it is not reported as "allowance used up".
export function decide(units: number, account: Limits, user: Limits): Decision {
    if (units > account.maxPerRequest) {
        return { decision: "rejected", rejectionRule: "account_max_per_request" };
    }
    if (units > user.maxPerRequest) {
        return { decision: "rejected", rejectionRule: "user_max_per_request" };
    }
    if (account.used + units > account.monthlyAllowance) {
        return { decision: "rejected", rejectionRule: "account_monthly_allowance" };
    }
    if (user.used + units > user.monthlyAllowance) {
        return { decision: "rejected", rejectionRule: "user_monthly_allowance" };
    }
    return { decision: "accepted", rejectionRule: null };
}

// Never negative: an allowance lowered below current usage shows 0 remaining.
// Call it separately for the account and for the user.
export function remaining(limits: Limits): number {
    return Math.max(0, limits.monthlyAllowance - limits.used);
}