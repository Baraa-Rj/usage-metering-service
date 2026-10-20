// POST /consume
import { Router } from "express";
import type pg from "pg";
import type { Clock } from "../clock.js";
import { consume } from "../consume.js";
import { bodyObject, requiredInteger, requiredString } from "../validate.js";

export function consumeRouter(pool: pg.Pool, clock: Clock): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const body = bodyObject(req.body);
        // The account comes from the API key, never from the body.
        // Accepted and rejected are both normal outcomes, so both answer 200.
        const result = await consume(pool, clock, {
            accountId: req.account!.id,
            externalUserId: requiredString(body, "externalUserId"),
            requestId: requiredString(body, "requestId", 200),
            units: requiredInteger(body, "units"),
        });
        res.status(200).json(result);
    });

    return router;
}

