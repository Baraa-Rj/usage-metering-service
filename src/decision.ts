// Pure decision logic: decide(), remaining(), and a plain-language explanation of a decision.

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

export type Side = "account" | "user";

// Which plan made the decision: the account's shared plan or the user's own plan.
export function rejectedBy(rule: RejectionRule | null): Side | null {
    if (rule === null) return null;
    return rule.startsWith("account_") ? "account" : "user";
}

// The limits that were enforced, as stored in the request's snapshot.
export interface LimitsSnapshot {
    monthlyAllowance: number;
    maxPerRequest: number;
    usedBefore: number;
}

export interface DecisionRecord {
    units: number;
    externalUserId: string;
    rejectionRule: RejectionRule | null;
    account: LimitsSnapshot;
    user: LimitsSnapshot;
}

const unitCount = (n: number) => `${n} ${n === 1 ? "unit" : "units"}`;

// A one-sentence, human-readable reason for a decision. Built only from the snapshot,
// so it stays true after the plans involved are edited.
export function explainDecision(record: DecisionRecord): string {
    const { units, account, user } = record;
    const userName = `user "${record.externalUserId}"`;
    switch (record.rejectionRule) {
        case null: {
            const accountLeft = Math.max(0, account.monthlyAllowance - account.usedBefore - units);
            const userLeft = Math.max(0, user.monthlyAllowance - user.usedBefore - units);
            return (
                `Accepted: ${unitCount(units)} counted. ${unitCount(accountLeft)} left this month ` +
                `for the account and ${unitCount(userLeft)} for ${userName}.`
            );
        }
        case "account_max_per_request":
            return (
                `Rejected by the account's plan: ${unitCount(units)} is more than its limit ` +
                `of ${unitCount(account.maxPerRequest)} per request.`
            );
        case "user_max_per_request":
            return (
                `Rejected by the plan of ${userName}: ${unitCount(units)} is more than its limit ` +
                `of ${unitCount(user.maxPerRequest)} per request.`
            );
        case "account_monthly_allowance":
            return (
                `Rejected by the account's plan: ${account.usedBefore} of its ${account.monthlyAllowance} ` +
                `monthly units are already used, so ${unitCount(units)} more would exceed the allowance ` +
                `(${unitCount(Math.max(0, account.monthlyAllowance - account.usedBefore))} left).`
            );
        case "user_monthly_allowance":
            return (
                `Rejected by the plan of ${userName}: ${user.usedBefore} of its ${user.monthlyAllowance} ` +
                `monthly units are already used, so ${unitCount(units)} more would exceed the allowance ` +
                `(${unitCount(Math.max(0, user.monthlyAllowance - user.usedBefore))} left).`
            );
    }
}