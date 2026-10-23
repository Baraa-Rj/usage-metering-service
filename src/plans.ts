// Plan rows, their JSON shape, and finding the plan a request refers to.
import type pg from "pg";
import { notFoundError, validationError } from "./errors.js";
import { isUuid, optionalString } from "./validate.js";

export type Db = pg.Pool | pg.PoolClient;

export const PLAN_SCOPES = ["account", "user"] as const;
export type PlanScope = (typeof PLAN_SCOPES)[number];

const PLAN_FIELDS = [
    "id",
    "scope",
    "name",
    "monthly_allowance",
    "max_per_request",
    "is_predefined",
    "archived_at",
    "created_at",
    "updated_at",
] as const;

export const PLAN_COLUMNS = PLAN_FIELDS.join(", ");

export interface PlanRow {
    id: string;
    scope: PlanScope;
    name: string;
    monthly_allowance: number;
    max_per_request: number;
    is_predefined: boolean;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

// For queries that join plans to another table: "p.id AS plan_id, p.scope AS plan_scope, ..."
// so the plan's columns cannot collide with the other table's id or created_at.
export function planColumns(alias: string, prefix: string): string {
    return PLAN_FIELDS.map((field) => `${alias}.${field} AS ${prefix}${field}`).join(", ");
}

export function planFromRow(row: Record<string, unknown>, prefix: string): PlanRow {
    return Object.fromEntries(PLAN_FIELDS.map((field) => [field, row[prefix + field]])) as unknown as PlanRow;
}

export function planJson(row: PlanRow) {
    return {
        id: row.id,
        scope: row.scope,
        name: row.name,
        monthlyAllowance: row.monthly_allowance,
        maxPerRequest: row.max_per_request,
        isPredefined: row.is_predefined,
        archivedAt: row.archived_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// Which plan a request body names: by name ("plan") or by id ("planId"), never both.
export interface PlanRef {
    name?: string;
    id?: string;
}

export function planRefFrom(body: Record<string, unknown>): PlanRef | undefined {
    const name = optionalString(body, "plan");
    const id = optionalString(body, "planId", 36);
    if (name !== undefined && id !== undefined) {
        throw validationError("give either plan or planId, not both");
    }
    if (name !== undefined) return { name };
    if (id !== undefined) return { id };
    return undefined;
}

/**
 * A plan that may be assigned: the right scope, not archived, and either predefined or
 * a custom plan owned by `accountId` (null allows predefined plans only, which is the
 * case while an account is being created). Names match case-insensitively. Another
 * account's plan is reported exactly like a plan that does not exist.
 */
export async function resolveAssignablePlan(
    db: Db,
    accountId: string | null,
    scope: PlanScope,
    ref: PlanRef,
): Promise<PlanRow> {
    const label = ref.name !== undefined ? `"${ref.name}"` : String(ref.id);
    if (ref.id !== undefined && !isUuid(ref.id)) {
        throw validationError(`unknown ${scope} plan: ${label}`);
    }
    const match = ref.id !== undefined ? "id = $3" : "lower(name) = lower($3)";
    const { rows } = await db.query<PlanRow>(
        `SELECT ${PLAN_COLUMNS}
           FROM plans
          WHERE scope = $1
            AND (is_predefined OR owner_account_id = $2)
            AND ${match}
          ORDER BY archived_at IS NOT NULL, is_predefined
          LIMIT 1`,
        [scope, accountId, ref.id ?? ref.name],
    );
    const plan = rows[0];
    if (!plan) {
        throw validationError(`unknown ${scope} plan: ${label}`);
    }
    if (plan.archived_at !== null) {
        throw validationError(`plan ${label} is archived and cannot be assigned`);
    }
    return plan;
}

/** A plan the account may see: any predefined plan, or one of its own custom plans. */
export async function findVisiblePlan(db: Db, accountId: string, planId: string | undefined): Promise<PlanRow> {
    if (planId === undefined || !isUuid(planId)) {
        throw notFoundError("plan not found");
    }
    const { rows } = await db.query<PlanRow>(
        `SELECT ${PLAN_COLUMNS}
           FROM plans
          WHERE id = $1 AND (is_predefined OR owner_account_id = $2)`,
        [planId, accountId],
    );
    const plan = rows[0];
    if (!plan) {
        throw notFoundError("plan not found");
    }
    return plan;
}

/** Where the caller uses a plan. Counts only the caller's own account and users. */
export async function planAssignments(db: Db, accountId: string, planId: string) {
    const { rows } = await db.query<{ account: boolean; users: number }>(
        `SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND plan_id = $2) AS account,
                (SELECT count(*) FROM users WHERE account_id = $1 AND plan_id = $2)::int AS users`,
        [accountId, planId],
    );
    return rows[0] ?? { account: false, users: 0 };
}
