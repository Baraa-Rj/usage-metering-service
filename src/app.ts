// Builds the Express app (middleware + routes) without listening, so tests can use it.
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type pg from "pg";
import { authenticate, requireAdmin } from "./auth.js";
import { AppError } from "./errors.js";
import { accountsRouter } from "./routes/accounts.js";
import { userRouter } from "./routes/users.js";
import { consumeRouter } from "./routes/consume.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

type ErrorBody = { error: { code: string; message: string } };

const errorBody = (code: string, message: string): ErrorBody => ({ error: { code, message } });

// express.json() reports bad bodies with a `type` property, not an AppError.
function bodyParserErrorType(err: unknown): string | null {
    if (typeof err === "object" && err !== null && "type" in err && typeof err.type === "string") {
        return err.type;
    }
    return null;
}

export function createApp(pool: pg.Pool, clock: Clock = systemClock): express.Express {
    const app = express();
    app.use(express.json({ limit: "10kb" }));

    // Infrastructure probe: public, unversioned, and it checks the database too.
    app.get("/health", async (_req, res) => {
        try {
            await pool.query("SELECT 1");
            res.json({ status: "ok" });
        } catch {
            res.status(503).json({ status: "unavailable" });
        }
    });

    const v1 = Router();
    // Admin-only routes (POST /accounts) are mounted here, before authenticate.
    v1.use("/accounts", requireAdmin, accountsRouter(pool));
    // Everything below needs a valid API key, so a route added later is protected by default.
    v1.use(authenticate(pool));
    // Account-scoped routes (plans, users, consume, usage) are mounted here.
    v1.use("/users", userRouter(pool));
    v1.use("/consume", consumeRouter(pool, clock));
    app.use("/v1", v1);

    app.use((_req, _res, next) => next(new AppError(404, "not_found", "route not found")));

    // Error handler: must have four parameters for Express to treat it as one.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof AppError) {
            res.status(err.status).json(errorBody(err.code, err.message));
            return;
        }
        const bodyError = bodyParserErrorType(err);
        if (bodyError === "entity.parse.failed") {
            res.status(400).json(errorBody("validation_error", "request body is not valid JSON"));
            return;
        }
        if (bodyError === "entity.too.large") {
            res.status(413).json(errorBody("payload_too_large", "request body is too large"));
            return;
        }
        // Unexpected: the real error goes to the log, the client gets a generic message.
        console.error(err);
        res.status(500).json(errorBody("internal_error", "internal server error"));
    });

    return app;
}
