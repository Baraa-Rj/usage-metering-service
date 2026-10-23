// Reads env vars (DATABASE_URL, PORT, ADMIN_API_KEY, DB_POOL_SIZE) into one typed config object.

export const config = {
    databaseUrl:
        process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/usage_metering",
    port: Number(process.env.PORT ?? 3000),
    adminApiKey: process.env.ADMIN_API_KEY ?? "dev-admin-key",
    dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 10),
};
