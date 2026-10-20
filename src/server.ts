// Entry point: build the pool and app, then listen on config.port.
import { config } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { createApp } from "./app.js";

const pool = createPool(config.databaseUrl, 10);
await migrate(pool);

const server = createApp(pool).listen(config.port, () => {
    console.log(`listening on port ${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down...`);

    // Safety net: if something hangs, exit anyway. unref() so the timer alone
    // does not keep the process alive.
    setTimeout(() => {
        console.error("shutdown timed out, forcing exit");
        process.exit(1);
    }, 10_000).unref();

    // Stop accepting new connections and wait for in-flight requests to finish.
    // Idle keep-alive connections would otherwise delay close() for a long time.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await closed;

    await pool.end();
    console.log("shutdown complete");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        shutdown(signal).catch((err) => {
            console.error("error during shutdown", err);
            process.exit(1);
        });
    });
}
