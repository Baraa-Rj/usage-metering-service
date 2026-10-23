// GET/PATCH /account: the calling account itself (identified by its API key).
import { Router } from "express";
import type pg from "pg";
import { isUniqueViolation } from "../dbErrors.js";
import { conflictError, validationError } from "../errors.js";
import {
    planColumns,
    planFromRow,
    planJson,
    planRefFrom,
    resolveAssignablePlan,
    type Db,
} from "../plans.js";
import { bodyObject, onlyFields, optionalString } from "../validate.js";

async function loadAccount(db: Db, accountId: string) {
    const { rows } = await db.query(
        `SELECT a.id, a.name, a.created_at, ${planColumns("p", "plan_")}
           FROM accounts a
           JOIN plans p ON p.id = a.plan_id
          WHERE a.id = $1`,
        [accountId],
    );
    const row = rows[0]!; // the account exists: authenticate just found it
    return {
        id: row.id,
        name: row.name,
        plan: planJson(planFromRow(row, "plan_")),
        createdAt: row.created_at,
    };
}

export function accountRouter(pool: pg.Pool): Router {
    const router = Router();

    router.get("/", async (req, res) => {
        res.json(await loadAccount(pool, req.account!.id));
    });

    // Rename the account and/or switch its plan. A plan switch applies to the next
    // consume; usage already counted this month is kept.
    router.patch("/", async (req, res) => {
        const accountId = req.account!.id;
        const body = bodyObject(req.body);
        onlyFields(body, ["name", "plan", "planId"]);
        const name = optionalString(body, "name");
        const ref = planRefFrom(body);
        if (name === undefined && ref === undefined) {
            throw validationError("nothing to update: give name, plan or planId");
        }
        const plan = ref ? await resolveAssignablePlan(pool, accountId, "account", ref) : undefined;

        try {
            await pool.query(
                `UPDATE accounts
                    SET name = COALESCE($2, name),
                        plan_id = COALESCE($3, plan_id)
                  WHERE id = $1`,
                [accountId, name ?? null, plan?.id ?? null],
            );
        } catch (err) {
            if (isUniqueViolation(err, "accounts_name_lower_uq")) {
                throw conflictError(`an account named "${name}" already exists`);
            }
            throw err;
        }
        res.json(await loadAccount(pool, accountId));
    });

    return router;
}
