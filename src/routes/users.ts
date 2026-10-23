// User endpoints: register users under the caller's account, list them, change their plan,
// and show their usage. A user is addressed by the caller's own id (externalUserId).
import { Router } from "express";
import type pg from "pg";
import { utcMonthStart, type Clock } from "../clock.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { isUniqueViolation } from "../dbErrors.js";
import { conflictError, validationError } from "../errors.js";
import { planRefFrom, resolveAssignablePlan } from "../plans.js";
import { accountUsage, monthLabel, monthlyHistory, userUsage } from "../reports.js";
import { findUser, USER_SELECT, userJson } from "../users.js";
import {
    bodyObject,
    onlyFields,
    pathString,
    queryInteger,
    queryString,
    requiredString,
} from "../validate.js";

const DEFAULT_PLAN = "Basic";

export function usersRouter(pool: pg.Pool, clock: Clock): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const accountId = req.account!.id;
        const body = bodyObject(req.body);
        const externalUserId = requiredString(body, "externalUserId");
        // A user plan is either predefined or one of this account's own custom plans.
        const plan = await resolveAssignablePlan(
            pool,
            accountId,
            "user",
            planRefFrom(body) ?? { name: DEFAULT_PLAN },
        );

        try {
            await pool.query(
                `INSERT INTO users (account_id, external_user_id, plan_id)
                 VALUES ($1, $2, $3)`,
                [accountId, externalUserId, plan.id],
            );
        } catch (error) {
            if (isUniqueViolation(error, "users_account_external_key")) {
                throw conflictError(`user "${externalUserId}" already exists`);
            }
            throw error;
        }
        res.status(201).json(userJson(await findUser(pool, accountId, externalUserId)));
    });

    // Ordered by externalUserId; pass nextCursor back as ?cursor= for the next page.
    router.get("/", async (req, res) => {
        const accountId = req.account!.id;
        const limit = queryInteger(req.query, "limit", { min: 1, max: 100, defaultValue: 50 });
        const cursor = queryString(req.query, "cursor", 500);
        const params: unknown[] = [accountId];
        let after = "";
        if (cursor !== undefined) {
            const [lastId] = decodeCursor(cursor, 1);
            params.push(lastId);
            after = `AND u.external_user_id > $${params.length}`;
        }
        params.push(limit + 1);
        const { rows } = await pool.query(
            `${USER_SELECT}
              WHERE u.account_id = $1 ${after}
              ORDER BY u.external_user_id
              LIMIT $${params.length}`,
            params,
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        res.json({
            users: page.map(userJson),
            nextCursor: rows.length > limit && last ? encodeCursor([last.external_user_id]) : null,
        });
    });

    router.get("/:externalUserId", async (req, res) => {
        const externalUserId = pathString(req.params.externalUserId, "externalUserId");
        res.json(userJson(await findUser(pool, req.account!.id, externalUserId)));
    });

    // Switch the user's plan. Applies to the user's next consume; usage is kept.
    router.patch("/:externalUserId", async (req, res) => {
        const accountId = req.account!.id;
        const externalUserId = pathString(req.params.externalUserId, "externalUserId");
        const user = await findUser(pool, accountId, externalUserId);
        const body = bodyObject(req.body);
        onlyFields(body, ["plan", "planId"]);
        const ref = planRefFrom(body);
        if (ref === undefined) {
            throw validationError("nothing to update: give plan or planId");
        }
        const plan = await resolveAssignablePlan(pool, accountId, "user", ref);
        await pool.query("UPDATE users SET plan_id = $2 WHERE id = $1", [user.id, plan.id]);
        res.json(userJson(await findUser(pool, accountId, externalUserId)));
    });

    // This month's usage for the user and for the account it shares limits with.
    // maxConsumableNow is the largest single consume that both plans would accept now.
    router.get("/:externalUserId/usage", async (req, res) => {
        const accountId = req.account!.id;
        const externalUserId = pathString(req.params.externalUserId, "externalUserId");
        const user = await findUser(pool, accountId, externalUserId);
        const month = utcMonthStart(clock.now());
        const [userSummary, accountSummary] = await Promise.all([
            userUsage(pool, user.id, month),
            accountUsage(pool, accountId, month),
        ]);
        res.json({
            month: monthLabel(month),
            externalUserId,
            user: userSummary,
            account: accountSummary,
            maxConsumableNow: Math.min(
                userSummary.remaining,
                accountSummary.remaining,
                userSummary.maxPerRequest,
                accountSummary.maxPerRequest,
            ),
        });
    });

    router.get("/:externalUserId/usage/history", async (req, res) => {
        const externalUserId = pathString(req.params.externalUserId, "externalUserId");
        const user = await findUser(pool, req.account!.id, externalUserId);
        const months = queryInteger(req.query, "months", { min: 1, max: 120, defaultValue: 12 });
        res.json({
            externalUserId,
            history: await monthlyHistory(pool, "user", user.id, utcMonthStart(clock.now()), months),
        });
    });

    return router;
}
