// Reads env vars (DATABASE_URL, PORT, ADMIN_API_KEY, DB_POOL_SIZE) into one typed config object.

// Only for local development and tests; refused in production (see assertProductionConfig).
export const DEV_ADMIN_API_KEY = "dev-admin-key";

export const config = {
    databaseUrl:
        process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/usage_metering",
    port: Number(process.env.PORT ?? 3000),
    adminApiKey: process.env.ADMIN_API_KEY || DEV_ADMIN_API_KEY,
    dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 10),
};

// Anyone who has read the README knows the development key, so a production
// service must not start with it: it would let anyone create accounts.
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
    if (env.NODE_ENV !== "production") return;
    const key = env.ADMIN_API_KEY;
    if (!key || key === DEV_ADMIN_API_KEY) {
        throw new Error("ADMIN_API_KEY must be set to a long random value when NODE_ENV=production");
    }
    if (key.length < 32) {
        throw new Error("ADMIN_API_KEY is too short; use at least 32 characters (openssl rand -hex 32)");
    }
}
