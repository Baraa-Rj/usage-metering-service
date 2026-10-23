// The request log: every consume decision, newest first, with the reason it was made.
import { Router } from "express";
import type pg from "pg";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { notFoundError, validationError } from "../errors.js";
import { REQUEST_SELECT, requestJson } from "../reports.js";
import { findUser } from "../users.js";
import { isUuid, pathString, queryEnum, queryInteger, queryMonth, queryString } from "../validate.js";

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function requestsRouter(pool: pg.Pool): Router {
    const router = Router();

    // Filters: ?externalUserId=, ?decision=accepted|rejected, ?month=2026-10.
    // Paging: ?limit= (1-100, default 50) and ?cursor= from the previous page's nextCursor.
    // Keyset paging on (created_at, id) stays correct while new requests keep arriving.
    router.get("/", async (req, res) => {
        const accountId = req.account!.id;
        const limit = queryInteger(req.query, "limit", { min: 1, max: 100, defaultValue: 50 });
        const params: unknown[] = [accountId];
        const where = ["r.account_id = $1"];
        const add = (condition: (n: number) => string, value: unknown) => {
            params.push(value);
            where.push(condition(params.length));
        };

        const externalUserId = queryString(req.query, "externalUserId", 100);
        if (externalUserId !== undefined) {
            const user = await findUser(pool, accountId, externalUserId);
            add((n) => `r.user_id = $${n}`, user.id);
        }
        const decision = queryEnum(req.query, "decision", ["accepted", "rejected"] as const);
        if (decision !== undefined) {
            add((n) => `r.decision = $${n}`, decision);
        }
        const month = queryMonth(req.query, "month");
        if (month !== undefined) {
            add((n) => `r.month = $${n}`, month);
        }
        const cursor = queryString(req.query, "cursor", 500);
        if (cursor !== undefined) {
            const [createdAt, id] = decodeCursor(cursor, 2) as [string, string];
            if (!CURSOR_TIMESTAMP.test(createdAt) || !isUuid(id)) {
                throw validationError("invalid cursor");
            }
            params.push(createdAt, id);
            where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        params.push(limit + 1);

        const { rows } = await pool.query(
            `${REQUEST_SELECT}
              WHERE ${where.join(" AND ")}
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT $${params.length}`,
            params,
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        res.json({
            requests: page.map(requestJson),
            nextCursor: rows.length > limit && last ? encodeCursor([last.cursor_ts, last.id]) : null,
        });
    });

    // One decision by the caller's request id, e.g. to explain a rejection after the fact.
    router.get("/:requestId", async (req, res) => {
        const requestId = pathString(req.params.requestId, "requestId", 200);
        const { rows } = await pool.query(
            `${REQUEST_SELECT} WHERE r.account_id = $1 AND r.request_id = $2`,
            [req.account!.id, requestId],
        );
        const row = rows[0];
        if (!row) {
            throw notFoundError(`request "${requestId}" not found`);
        }
        res.json(requestJson(row));
    });

    return router;
}
