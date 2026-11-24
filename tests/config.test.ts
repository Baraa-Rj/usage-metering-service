// Production refuses to start without a real admin key; development keeps its default.
import { describe, expect, it } from "vitest";
import { assertProductionConfig, DEV_ADMIN_API_KEY } from "../src/config.js";

const strongKey = "a".repeat(64);

describe("assertProductionConfig", () => {
    it("allows the development default outside production", () => {
        expect(() => assertProductionConfig({ NODE_ENV: "development" })).not.toThrow();
        expect(() => assertProductionConfig({})).not.toThrow();
    });

    it("refuses a missing, empty or default admin key in production", () => {
        for (const ADMIN_API_KEY of [undefined, "", DEV_ADMIN_API_KEY]) {
            expect(() => assertProductionConfig({ NODE_ENV: "production", ADMIN_API_KEY }), String(ADMIN_API_KEY))
                .toThrow("ADMIN_API_KEY must be set");
        }
    });

    it("refuses a short admin key in production", () => {
        expect(() => assertProductionConfig({ NODE_ENV: "production", ADMIN_API_KEY: "short-key" }))
            .toThrow("too short");
    });

    it("accepts a long random admin key in production", () => {
        expect(() => assertProductionConfig({ NODE_ENV: "production", ADMIN_API_KEY: strongKey })).not.toThrow();
    });
});
