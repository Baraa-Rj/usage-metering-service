// API key auth and cross-account isolation tests.
import { describe, it } from "vitest";

describe("api key auth", () => {
    it.todo("rejects a request with no API key (401)");
    it.todo("rejects a request with an unknown API key (401)");
});

describe("account isolation", () => {
    it.todo("an account cannot read another account's users, usage or requests");
    it.todo("an account cannot consume for another account's user");
    it.todo("an account cannot assign or edit another account's custom plan");
    it.todo("the same request_id under two accounts is two independent requests");
    it.todo("the same external user id under two accounts is two different users");
});
