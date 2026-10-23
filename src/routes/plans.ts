// Plan endpoints: list predefined and own custom plans; create, edit and archive custom plans.
import { Router } from "express";
import type pg from "pg";
import { isUniqueViolation } from "../dbErrors.js";
import { conflictError, forbiddenError, validationError } from "../errors.js";
import {
    findVisiblePlan,
    PLAN_COLUMNS,
    PLAN_SCOPES,
    planAssignments,
    planJson,
    type Db,
    type PlanRow,
    type PlanScope,
} from "../plans.js";
import {
    bodyObject,
    onlyFields,
    optionalInteger,
    optionalString,
    queryBoolean,
    queryEnum,
    requiredEnum,
    requiredInteger,
    requiredString,
} from "../validate.js";

const CUSTOM_NAME_INDEX = "plans_custom_name_lower_uq";

// Custom plans may not reuse a predefined plan's name in the same scope, so a name
// such as "Basic" always means the same plan to every account.
async function rejectPredefinedName(db: Db, scope: PlanScope, name: string): Promise<void> {
    const { rowCount } = await db.query(
        "SELECT 1 FROM plans WHERE is_predefined AND scope = $1 AND lower(name) = lower($2)",
        [scope, name],
    );
    if (rowCount) {
        throw conflictError(`"${name}" is the name of a predefined ${scope} plan`);
    }
}

async function editablePlan(db: Db, accountId: string, planId: string | undefined): Promise<PlanRow> {
    const plan = await findVisiblePlan(db, accountId, planId);
    if (plan.is_predefined) {
        throw forbiddenError("predefined plans are read-only; create a custom plan instead");
    }
    return plan;
}

export function plansRouter(pool: pg.Pool): Router {
    const router = Router();

    // ?scope=account|user narrows the list; archived custom plans are hidden unless
    // ?includeArchived=true.
    router.get("/", async (req, res) => {
        const params: unknown[] = [req.account!.id];
        const where = ["(is_predefined OR owner_account_id = $1)"];
        const scope = queryEnum(req.query, "scope", PLAN_SCOPES);
        if (scope !== undefined) {
            params.push(scope);
            where.push(`scope = $${params.length}`);
        }
        if (!(queryBoolean(req.query, "includeArchived") ?? false)) {
            where.push("archived_at IS NULL");
        }
        const { rows } = await pool.query<PlanRow>(
            `SELECT ${PLAN_COLUMNS}
               FROM plans
              WHERE ${where.join(" AND ")}
              ORDER BY scope, is_predefined DESC, lower(name)`,
            params,
        );
        res.json({ plans: rows.map(planJson) });
    });

    router.get("/:planId", async (req, res) => {
        const accountId = req.account!.id;
        const plan = await findVisiblePlan(pool, accountId, req.params.planId);
        res.json({ ...planJson(plan), assignments: await planAssignments(pool, accountId, plan.id) });
    });

    router.post("/", async (req, res) => {
        const accountId = req.account!.id;
        const body = bodyObject(req.body);
        onlyFields(body, ["scope", "name", "monthlyAllowance", "maxPerRequest"]);
        const scope = requiredEnum(body, "scope", PLAN_SCOPES);
        const name = requiredString(body, "name");
        const monthlyAllowance = requiredInteger(body, "monthlyAllowance", 0);
        const maxPerRequest = requiredInteger(body, "maxPerRequest", 1);
        await rejectPredefinedName(pool, scope, name);

        try {
            const { rows } = await pool.query<PlanRow>(
                `INSERT INTO plans (scope, name, monthly_allowance, max_per_request, owner_account_id)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING ${PLAN_COLUMNS}`,
                [scope, name, monthlyAllowance, maxPerRequest, accountId],
            );
            res.status(201).json(planJson(rows[0]!));
        } catch (err) {
            if (isUniqueViolation(err, CUSTOM_NAME_INDEX)) {
                throw conflictError(`a ${scope} plan named "${name}" already exists`);
            }
            throw err;
        }
    });

    // Edits apply to the next consume of every account or user on the plan. Usage already
    // counted is kept, and past decisions keep the limits recorded in their snapshot.
    router.patch("/:planId", async (req, res) => {
        const plan = await editablePlan(pool, req.account!.id, req.params.planId);
        const body = bodyObject(req.body);
        if ("scope" in body) {
            throw validationError("scope cannot be changed; create a new plan instead");
        }
        onlyFields(body, ["name", "monthlyAllowance", "maxPerRequest"]);
        const name = optionalString(body, "name");
        const monthlyAllowance = optionalInteger(body, "monthlyAllowance", 0);
        const maxPerRequest = optionalInteger(body, "maxPerRequest", 1);
        if (name === undefined && monthlyAllowance === undefined && maxPerRequest === undefined) {
            throw validationError("nothing to update: give name, monthlyAllowance or maxPerRequest");
        }
        if (name !== undefined) {
            await rejectPredefinedName(pool, plan.scope, name);
        }

        try {
            const { rows } = await pool.query<PlanRow>(
                `UPDATE plans
                    SET name = COALESCE($2, name),
                        monthly_allowance = COALESCE($3, monthly_allowance),
                        max_per_request = COALESCE($4, max_per_request),
                        updated_at = now()
                  WHERE id = $1
                  RETURNING ${PLAN_COLUMNS}`,
                [plan.id, name ?? null, monthlyAllowance ?? null, maxPerRequest ?? null],
            );
            res.json(planJson(rows[0]!));
        } catch (err) {
            if (isUniqueViolation(err, CUSTOM_NAME_INDEX)) {
                throw conflictError(`a ${plan.scope} plan named "${name}" already exists`);
            }
            throw err;
        }
    });

    // Archive instead of delete: requests reference plans, and accounts or users still on
    // the plan keep working. An archived plan just cannot be newly assigned.
    // Archiving twice is a no-op.
    router.delete("/:planId", async (req, res) => {
        const accountId = req.account!.id;
        const plan = await editablePlan(pool, accountId, req.params.planId);
        const { rows } = await pool.query<PlanRow>(
            `UPDATE plans
                SET archived_at = COALESCE(archived_at, now()),
                    updated_at = CASE WHEN archived_at IS NULL THEN now() ELSE updated_at END
              WHERE id = $1
              RETURNING ${PLAN_COLUMNS}`,
            [plan.id],
        );
        res.json({ ...planJson(rows[0]!), assignments: await planAssignments(pool, accountId, plan.id) });
    });

    return router;
}
