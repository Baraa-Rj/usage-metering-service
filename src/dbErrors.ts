// Helpers for recognising specific Postgres errors thrown by pg.

/** True when `err` is a unique-constraint violation (23505) on the named constraint/index. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505" &&
        "constraint" in err &&
        err.constraint === constraint
    );
}
