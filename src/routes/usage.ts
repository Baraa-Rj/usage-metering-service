// Account-level usage: this month's usage and remaining, and the monthly history.
import { Router } from "express";
import type pg from "pg";
import { utcMonthStart, type Clock } from "../clock.js";
import { accountUsage, monthLabel, monthlyHistory } from "../reports.js";
import { queryInteger } from "../validate.js";

export function usageRouter(pool: pg.Pool, clock: Clock): Router {
    const router = Router();

    router.get("/", async (req, res) => {
        const month = utcMonthStart(clock.now());
        res.json({ month: monthLabel(month), ...(await accountUsage(pool, req.account!.id, month)) });
    });

    // ?months=N (1-120, default 12): the last N UTC months including the current one.
    router.get("/history", async (req, res) => {
        const months = queryInteger(req.query, "months", { min: 1, max: 120, defaultValue: 12 });
        res.json({
            history: await monthlyHistory(
                pool,
                "account",
                req.account!.id,
                utcMonthStart(clock.now()),
                months,
            ),
        });
    });

    return router;
}
