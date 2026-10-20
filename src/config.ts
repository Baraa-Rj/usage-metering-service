// Reads env vars (DATABASE_URL, PORT) into one typed config object.

export const config = {
    databaseUrl:
        process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/usage_metering",
    port: Number(process.env.PORT ?? 3000),
};
