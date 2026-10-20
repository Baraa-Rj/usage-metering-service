// Creates a fresh test database and applies migrations once per run.
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { ADMIN_URL, TEST_DB, TEST_URL } from "./helpers.js";

export default async function setup() {
    // WITH (FORCE): a crashed earlier run may have left a connection open.
    const admin = createPool(ADMIN_URL, 1);
    try {
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
        await admin.end();
    }

    const pool = createPool(TEST_URL, 1);
    try {
        await migrate(pool);
    } finally {
        await pool.end();
    }
}
