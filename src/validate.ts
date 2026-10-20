import { validationError } from "./errors.js";

// The body must be a JSON object, not an array, string, number or null.
export function bodyObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw validationError("request body must be a JSON object");
    }
    return body as Record<string, unknown>;
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

// A positive whole number. Safe integers only: above 2^53 a JS number can no longer
// represent every integer exactly, so such values are rejected instead of rounded.
export function requiredInteger(obj: Record<string, unknown>, field: string): number {
    const value = obj[field];
    if (typeof value !== "number") {
        throw validationError(`${field} is required and must be a number`);
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw validationError(`${field} must be a positive integer`);
    }
    return value;
}
