// POST /accounts (admin key): create an account on a predefined account plan, return its API key once.
import { Router } from "express";
import type pg from "pg";
import { generateApiKey, hashApiKey } from "../auth.js";
import { isUniqueViolation } from "../dbErrors.js";
import { conflictError } from "../errors.js";
import { planJson, planRefFrom, resolveAssignablePlan } from "../plans.js";
import { bodyObject, requiredString } from "../validate.js";

const DEFAULT_PLAN = "Starter";

export function accountsRouter(pool: pg.Pool): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const body = bodyObject(req.body);
        const name = requiredString(body, "name");
        // A new account has no custom plans yet, so only predefined account plans qualify.
        const plan = await resolveAssignablePlan(
            pool,
            null,
            "account",
            planRefFrom(body) ?? { name: DEFAULT_PLAN },
        );

        // The raw key is returned once and never stored; only its hash is.
        const apiKey = generateApiKey();
        let account;
        try {
            const inserted = await pool.query(
                `INSERT INTO accounts (name, api_key_hash, plan_id)
                 VALUES ($1, $2, $3)
                 RETURNING id, created_at`,
                [name, hashApiKey(apiKey), plan.id],
            );
            account = inserted.rows[0];
        } catch (err) {
            if (isUniqueViolation(err, "accounts_name_lower_uq")) {
                throw conflictError(`an account named "${name}" already exists`);
            }
            throw err;
        }

        res.status(201).json({
            id: account.id,
            name,
            plan: planJson(plan),
            apiKey,
            createdAt: account.created_at,
        });
    });

    return router;
}
