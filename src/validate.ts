import type { Request } from "express";
import { validationError } from "./errors.js";

// The body must be a JSON object, not an array, string, number or null.
export function bodyObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw validationError("request body must be a JSON object");
    }
    return body as Record<string, unknown>;
}

// For PATCH-style bodies: an unknown (usually misspelled) field would otherwise be
// ignored silently and the client would believe it had changed something.
export function onlyFields(obj: Record<string, unknown>, allowed: readonly string[]): void {
    const unknown = Object.keys(obj).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw validationError(`unknown field(s): ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`);
    }
}

// A non-blank string. Returned trimmed; the length limit applies to the trimmed value.
export function requiredString(obj: Record<string, unknown>, field: string, maxLength = 100): string {
    const value = obj[field];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`${field} is required and must be a non-empty string`);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw validationError(`${field} must be at most ${maxLength} characters`);
    }
    return trimmed;
}

// Missing means undefined. If present it must be a valid non-blank string:
// "" or "   " is a client mistake, not "missing".
export function optionalString(
    obj: Record<string, unknown>,
    field: string,
    maxLength = 100,
): string | undefined {
    if (obj[field] === undefined) return undefined;
    return requiredString(obj, field, maxLength);
}

function describeMinimum(min: number): string {
    if (min === 1) return "a positive integer";
    if (min === 0) return "a non-negative integer";
    return `an integer of at least ${min}`;
}

// A whole number of at least `min`. Safe integers only: above 2^53 a JS number can no
// longer represent every integer exactly, so such values are rejected instead of rounded.
export function requiredInteger(obj: Record<string, unknown>, field: string, min = 1): number {
    const value = obj[field];
    if (typeof value !== "number") {
        throw validationError(`${field} is required and must be a number`);
    }
    if (!Number.isSafeInteger(value) || value < min) {
        throw validationError(`${field} must be ${describeMinimum(min)}`);
    }
    return value;
}

export function optionalInteger(
    obj: Record<string, unknown>,
    field: string,
    min = 1,
): number | undefined {
    if (obj[field] === undefined) return undefined;
    return requiredInteger(obj, field, min);
}

export function requiredEnum<T extends string>(
    obj: Record<string, unknown>,
    field: string,
    values: readonly T[],
): T {
    const value = obj[field];
    if (typeof value !== "string" || !values.includes(value as T)) {
        throw validationError(`${field} must be one of: ${values.join(", ")}`);
    }
    return value as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids are checked before they reach SQL: Postgres rejects a malformed uuid with an
// error, which would otherwise surface as a 500 for what is a client typo.
export const isUuid = (value: string): boolean => UUID.test(value);

// A path parameter such as /users/:externalUserId, with the same rules as body strings.
export function pathString(value: string | undefined, name: string, maxLength = 100): string {
    return requiredString({ [name]: value }, name, maxLength);
}

type Query = Request["query"];

// Query values are strings, but a repeated parameter (?a=1&a=2) arrives as an array.
export function queryString(query: Query, name: string, maxLength = 200): string | undefined {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw validationError(`query parameter ${name} must be given once`);
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        throw validationError(`query parameter ${name} must not be empty`);
    }
    if (trimmed.length > maxLength) {
        throw validationError(`query parameter ${name} must be at most ${maxLength} characters`);
    }
    return trimmed;
}

export function queryInteger(
    query: Query,
    name: string,
    range: { min: number; max: number; defaultValue: number },
): number {
    const raw = queryString(query, name, 20);
    if (raw === undefined) return range.defaultValue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < range.min || value > range.max) {
        throw validationError(
            `query parameter ${name} must be an integer from ${range.min} to ${range.max}`,
        );
    }
    return value;
}

export function queryEnum<T extends string>(
    query: Query,
    name: string,
    values: readonly T[],
): T | undefined {
    const raw = queryString(query, name);
    if (raw === undefined) return undefined;
    if (!values.includes(raw as T)) {
        throw validationError(`query parameter ${name} must be one of: ${values.join(", ")}`);
    }
    return raw as T;
}

export function queryBoolean(query: Query, name: string): boolean | undefined {
    const raw = queryString(query, name);
    if (raw === undefined) return undefined;
    if (raw !== "true" && raw !== "false") {
        throw validationError(`query parameter ${name} must be true or false`);
    }
    return raw === "true";
}

// ?month=2026-10 -> '2026-10-01', the first day of that UTC month as stored in the database.
export function queryMonth(query: Query, name: string): string | undefined {
    const raw = queryString(query, name, 7);
    if (raw === undefined) return undefined;
    const match = /^(\d{4})-(\d{2})$/.exec(raw);
    const month = Number(match?.[2]);
    if (!match || month < 1 || month > 12) {
        throw validationError(`query parameter ${name} must be a month like 2026-10`);
    }
    return `${raw}-01`;
}
