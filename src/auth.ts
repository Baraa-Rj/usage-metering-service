// API key middleware: hash the key, look up the account, attach it to the request.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response, RequestHandler } from "express";
import type pg from "pg";
import { forbiddenError, unauthorizedError } from "./errors.js";
import { config } from "./config.js";

declare global {
    namespace Express {
        interface Request {
            account?: { id: string; name: string };
        }
    }
}

// The "ums_" prefix makes a leaked key recognisable in logs, repos and secret scanners.
export function generateApiKey(): string {
    return "ums_" + randomBytes(32).toString("hex");
}

// Only the hash is stored. Plain SHA-256 is enough: keys are long random strings,
// not human-chosen passwords, so there is nothing to guess and a slow hash adds nothing.
export function hashApiKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

// The scheme name is case-insensitive (RFC 7235), so the regex alone decides.
function bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1] ?? null;
}

export function authenticate(pool: pg.Pool): RequestHandler {
    return async function authMiddleware(
        req: Request,
        _res: Response,
        next: NextFunction
    ) {
        const token = bearerToken(req);
        if (token === null) {
            return next(unauthorizedError("Missing or malformed bearer token"));
        }

        try {
            const { rows } = await pool.query(
                "SELECT id, name FROM accounts WHERE api_key_hash = $1",
                [hashApiKey(token)]
            );
            if (rows.length === 0) {
                return next(unauthorizedError("Invalid API key"));
            }

            // Attach the account for downstream handlers.
            req.account = { id: rows[0].id, name: rows[0].name };
            next();
        } catch (err) {
            next(err);
        }
    };
}

// Constant-time compare so response timing doesn't reveal how much of the key matched.
// Hashing first gives both sides the same length, which timingSafeEqual requires,
// without leaking the key's length.
function isAdminKey(token: string): boolean {
    const given = createHash("sha256").update(token).digest();
    const expected = createHash("sha256").update(config.adminApiKey).digest();
    return timingSafeEqual(given, expected);
}

// Guards POST /accounts.
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
    const token = bearerToken(req);
    if (token === null || !isAdminKey(token)) {
        return next(forbiddenError("Admin API key required"));
    }
    next();
}
