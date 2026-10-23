// Opaque pagination cursors: a base64url-encoded JSON array of strings. Clients pass
// them back unchanged; the server validates every part before it reaches SQL.
import { validationError } from "./errors.js";

export function encodeCursor(parts: string[]): string {
    return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string, length: number): string[] {
    try {
        const parts: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
            Array.isArray(parts) &&
            parts.length === length &&
            parts.every((part) => typeof part === "string")
        ) {
            return parts as string[];
        }
    } catch {
        // fall through to the validation error
    }
    throw validationError("invalid cursor");
}
