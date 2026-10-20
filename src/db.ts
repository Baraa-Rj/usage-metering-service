// pg Pool, number/date type parsers, and a withTransaction(pool, fn) helper.
import pg from "pg";

// bigint arrives as a string by default ("20" + 5 would be "205").
// Quotas stay far below 2^53, so plain numbers are safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

// SUM(bigint) returns numeric.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

// Keep dates as 'YYYY-MM-DD' strings; a JS Date would shift with the local time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(connectionString: string, max = 10): pg.Pool {
    const pool = new pg.Pool({
        connectionString,
        max,
        idleTimeoutMillis: 30_000,
        // Consumes on one account queue on a lock, so waiting for a connection
        // can take a while under load.
        connectionTimeoutMillis: 10_000,
    });
    // An idle client can break (DB restart, network blip). Without a listener
    // Node treats that as an unhandled error and crashes the process.
    pool.on("error", (err) => {
        console.error("idle pg client error", err);
    });
    return pool;
}

export async function withTransaction<T>(
    pool: pg.Pool,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        // If the connection is dead ROLLBACK throws too; don't let that hide the real error.
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}
