// User endpoints: register a user under the caller's account, assign a plan.
import { Router } from "express";
import type pg from "pg";
import { bodyObject, optionalString, requiredString } from "../validate.js";
import { isUniqueViolation } from "../dbErrors.js";
import { conflictError, validationError } from "../errors.js";

const DEFAULT_PLAN = "Basic";

export function userRouter(pool: pg.Pool): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const accountId = req.account!.id;
        const body = bodyObject(req.body);
        const externalUserId = requiredString(body, "externalUserId");
        const planName = optionalString(body, "plan") ?? DEFAULT_PLAN;

        // A user plan is either predefined or one of this account's own custom plans.
        // If both exist under one name, the custom plan wins (false sorts before true).
        const planResult = await pool.query(
            `SELECT id, name, monthly_allowance, max_per_request
               FROM plans
              WHERE scope = 'user'
                AND archived_at IS NULL
                AND name = $1
                AND (is_predefined OR owner_account_id = $2)
              ORDER BY is_predefined
              LIMIT 1`,
            [planName, accountId],
        );
        const plan = planResult.rows[0];
        if (!plan) {
            throw validationError(`unknown user plan: ${planName}`);
        }

        let user;
        try {
            const inserted = await pool.query(
                `INSERT INTO users (account_id, external_user_id, plan_id)
                 VALUES ($1, $2, $3)
                 RETURNING id, created_at`,
                [accountId, externalUserId, plan.id],
            );
            user = inserted.rows[0];
        } catch (error) {
            if (isUniqueViolation(error, "users_account_external_key")) {
                throw conflictError(`user "${externalUserId}" already exists`);
            }
            throw error;
        }

        res.status(201).json({
            id: user.id,
            externalUserId,
            plan: {
                id: plan.id,
                name: plan.name,
                monthlyAllowance: plan.monthly_allowance,
                maxPerRequest: plan.max_per_request,
            },
            createdAt: user.created_at,
        });
    });

    return router;
}
