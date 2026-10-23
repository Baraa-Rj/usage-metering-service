// A small typed client for the Usage Metering API, as a calling application would use it.
// No dependencies beyond fetch. Used by the demo client and by the AI agent.

export type PlanScope = "account" | "user";
export type Decision = "accepted" | "rejected";
export type RejectionRule =
    | "account_max_per_request"
    | "user_max_per_request"
    | "account_monthly_allowance"
    | "user_monthly_allowance";

export interface Plan {
    id: string;
    scope: PlanScope;
    name: string;
    monthlyAllowance: number;
    maxPerRequest: number;
    isPredefined: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface PlanWithAssignments extends Plan {
    assignments: { account: boolean; users: number };
}

export interface Account {
    id: string;
    name: string;
    plan: Plan;
    createdAt: string;
}

export interface CreatedAccount extends Account {
    /** Shown only once, at creation. Store it securely. */
    apiKey: string;
}

export interface User {
    id: string;
    externalUserId: string;
    plan: Plan;
    createdAt: string;
}

export interface ConsumeResult {
    requestId: string;
    decision: Decision;
    rejectionRule: RejectionRule | null;
    rejectedBy: "account" | "user" | null;
    units: number;
    month: string;
    replayed: boolean;
    accountRemaining: number;
    userRemaining: number;
    explanation: string;
}

export interface UsageSummary {
    plan: { id: string; name: string };
    used: number;
    monthlyAllowance: number;
    maxPerRequest: number;
    remaining: number;
}

export interface AccountUsage extends UsageSummary {
    month: string;
}

export interface UserUsage {
    month: string;
    externalUserId: string;
    user: UsageSummary;
    account: UsageSummary;
    /** The largest single consume both plans would accept right now. */
    maxConsumableNow: number;
}

export interface MonthUsage {
    month: string;
    used: number;
    requests: { accepted: number; rejected: number };
}

export interface LimitsSnapshot {
    planId: string;
    monthlyAllowance: number;
    maxPerRequest: number;
    usedBefore: number;
}

export interface RequestRecord {
    requestId: string;
    externalUserId: string;
    units: number;
    month: string;
    decision: Decision;
    rejectionRule: RejectionRule | null;
    rejectedBy: "account" | "user" | null;
    explanation: string;
    limits: { account: LimitsSnapshot; user: LimitsSnapshot };
    createdAt: string;
}

/** An error response from the API: { error: { code, message } } plus the HTTP status. */
export class MeteringError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "MeteringError";
    }
}

export interface MeteringClientOptions {
    baseUrl: string;
    apiKey?: string;
    /**
     * Retries for calls that are safe to repeat: reads, and consume (idempotent by
     * requestId: a retry never counts twice). Network errors and 5xx are retried with
     * exponential backoff. Default 2.
     */
    maxRetries?: number;
    /** Per-attempt timeout. Default 10 s. */
    timeoutMs?: number;
    fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
    body?: unknown;
    query?: Query;
    retry?: boolean;
    key?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const segment = (value: string) => encodeURIComponent(value);

export class MeteringClient {
    private readonly baseUrl: string;
    private readonly apiKey: string | undefined;
    private readonly maxRetries: number;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: MeteringClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.apiKey = options.apiKey;
        this.maxRetries = options.maxRetries ?? 2;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.fetchImpl = options.fetch ?? fetch;
    }

    /** Creates an account with the operator's admin key and returns it with its API key. */
    static async createAccount(
        options: Omit<MeteringClientOptions, "apiKey"> & { adminApiKey: string },
        body: { name: string; plan?: string; planId?: string },
    ): Promise<CreatedAccount> {
        const admin = new MeteringClient(options);
        return admin.request("POST", "/v1/accounts", { body, key: options.adminApiKey });
    }

    /** A client for the new account, using its API key. */
    withApiKey(apiKey: string): MeteringClient {
        return new MeteringClient({
            baseUrl: this.baseUrl,
            apiKey,
            maxRetries: this.maxRetries,
            timeoutMs: this.timeoutMs,
            fetch: this.fetchImpl,
        });
    }

    health(): Promise<{ status: string }> {
        return this.request("GET", "/health", { retry: true });
    }

    /** Polls /health until the service and its database answer, e.g. while containers start. */
    async waitUntilHealthy(timeoutMs = 60_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            try {
                await this.health();
                return;
            } catch (err) {
                if (Date.now() > deadline) throw err;
                await sleep(1000);
            }
        }
    }

    // ---- account ----

    getAccount(): Promise<Account> {
        return this.request("GET", "/v1/account", { retry: true });
    }

    updateAccount(body: { name?: string; plan?: string; planId?: string }): Promise<Account> {
        return this.request("PATCH", "/v1/account", { body });
    }

    // ---- plans ----

    async listPlans(query: { scope?: PlanScope; includeArchived?: boolean } = {}): Promise<Plan[]> {
        return (await this.request<{ plans: Plan[] }>("GET", "/v1/plans", { query, retry: true })).plans;
    }

    getPlan(planId: string): Promise<PlanWithAssignments> {
        return this.request("GET", `/v1/plans/${segment(planId)}`, { retry: true });
    }

    createPlan(body: { scope: PlanScope; name: string; monthlyAllowance: number; maxPerRequest: number }): Promise<Plan> {
        return this.request("POST", "/v1/plans", { body });
    }

    updatePlan(planId: string, body: { name?: string; monthlyAllowance?: number; maxPerRequest?: number }): Promise<Plan> {
        return this.request("PATCH", `/v1/plans/${segment(planId)}`, { body });
    }

    archivePlan(planId: string): Promise<PlanWithAssignments> {
        return this.request("DELETE", `/v1/plans/${segment(planId)}`, { retry: true });
    }

    // ---- users ----

    registerUser(body: { externalUserId: string; plan?: string; planId?: string }): Promise<User> {
        return this.request("POST", "/v1/users", { body });
    }

    listUsers(query: { limit?: number; cursor?: string } = {}): Promise<{ users: User[]; nextCursor: string | null }> {
        return this.request("GET", "/v1/users", { query, retry: true });
    }

    getUser(externalUserId: string): Promise<User> {
        return this.request("GET", `/v1/users/${segment(externalUserId)}`, { retry: true });
    }

    updateUser(externalUserId: string, body: { plan?: string; planId?: string }): Promise<User> {
        return this.request("PATCH", `/v1/users/${segment(externalUserId)}`, { body });
    }

    getUserUsage(externalUserId: string): Promise<UserUsage> {
        return this.request("GET", `/v1/users/${segment(externalUserId)}/usage`, { retry: true });
    }

    async getUserUsageHistory(externalUserId: string, months?: number): Promise<MonthUsage[]> {
        const path = `/v1/users/${segment(externalUserId)}/usage/history`;
        return (await this.request<{ history: MonthUsage[] }>("GET", path, { query: { months }, retry: true })).history;
    }

    // ---- consume ----

    /**
     * Asks to consume units for a user. Accepted and rejected are both normal results;
     * check `decision`. Safe to retry with the same requestId: the original decision is
     * returned (`replayed: true`) and nothing is counted twice.
     */
    consume(body: { externalUserId: string; requestId: string; units: number }): Promise<ConsumeResult> {
        return this.request("POST", "/v1/consume", { body, retry: true });
    }

    // ---- usage and history ----

    getUsage(): Promise<AccountUsage> {
        return this.request("GET", "/v1/usage", { retry: true });
    }

    async getUsageHistory(months?: number): Promise<MonthUsage[]> {
        return (await this.request<{ history: MonthUsage[] }>("GET", "/v1/usage/history", { query: { months }, retry: true })).history;
    }

    listRequests(
        query: { externalUserId?: string; decision?: Decision; month?: string; limit?: number; cursor?: string } = {},
    ): Promise<{ requests: RequestRecord[]; nextCursor: string | null }> {
        return this.request("GET", "/v1/requests", { query, retry: true });
    }

    getRequest(requestId: string): Promise<RequestRecord> {
        return this.request("GET", `/v1/requests/${segment(requestId)}`, { retry: true });
    }

    // ---- transport ----

    private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = new URL(this.baseUrl + path);
        for (const [name, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined) url.searchParams.set(name, String(value));
        }
        const key = options.key ?? this.apiKey;
        const attempts = options.retry ? this.maxRetries + 1 : 1;

        for (let attempt = 1; ; attempt++) {
            let response: Response;
            try {
                response = await this.fetchImpl(url, {
                    method,
                    headers: {
                        accept: "application/json",
                        ...(key ? { authorization: `Bearer ${key}` } : {}),
                        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
                    },
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (err) {
                // Network failure or timeout: the request may or may not have reached the server.
                if (attempt < attempts) {
                    await sleep(100 * 2 ** (attempt - 1));
                    continue;
                }
                throw err;
            }

            if (response.status >= 500 && attempt < attempts) {
                await sleep(100 * 2 ** (attempt - 1));
                continue;
            }
            const text = await response.text();
            const data = text ? JSON.parse(text) : undefined;
            if (!response.ok) {
                const error = data?.error ?? {};
                throw new MeteringError(
                    response.status,
                    error.code ?? "http_error",
                    error.message ?? `HTTP ${response.status}`,
                );
            }
            return data as T;
        }
    }
}
