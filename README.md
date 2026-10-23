# Usage Metering and Quota Service

A backend service that other applications call to meter their users' usage and decide, per
action, whether it is allowed. A calling application (an **account**) has a plan with limits
shared by all its users; each of its **users** has a plan with individual limits. Before doing
billable work, the application asks the service to **consume** units for a user: the request
is accepted only if both plans allow it, every decision is recorded with the reason, and
accepted units are counted.

TypeScript (Node.js, Express 5) and PostgreSQL. One service, one database.

**Contents:**
[Quick start](#quick-start) ·
[Concepts](#concepts) ·
[API](#api) ·
[Design](#design) ·
[Assumptions](#assumptions-and-product-decisions) ·
[Example client](#example-client) ·
[AI agent](#ai-agent) ·
[Tests](#tests) ·
[Load tests](#load-tests) ·
[Limitations](#limitations-and-future-work) ·
[Layout](#project-layout)

---

## Quick start

### With Docker (service + PostgreSQL + example client)

```bash
docker compose up --build
```

This starts PostgreSQL 18, the service on `http://localhost:3000` (migrations run on
startup), and the example client, which runs a scripted walkthrough against the service,
checks every outcome, and exits. The service keeps running. Set `SERVICE_PORT` to publish on
another port and `ADMIN_API_KEY` to change the admin key.

The AI agent runs on demand and needs Claude credentials:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose run --rm agent
```

### Locally

Requires Node.js 22+ (developed on 26) and PostgreSQL 14+ (developed on 18).

```bash
npm install
createdb usage_metering            # or: psql -U postgres -c 'CREATE DATABASE usage_metering;'
npm run dev                        # applies migrations, listens on :3000
npm run demo                       # the example client, in another terminal
npm test                           # creates and migrates its own database, usage_metering_test
```

Configuration is read from environment variables (see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres@localhost:5432/usage_metering` | PostgreSQL connection |
| `PORT` | `3000` | HTTP port |
| `ADMIN_API_KEY` | `dev-admin-key` | Key for creating accounts. **Set a long random value outside development**; the service warns at startup when `NODE_ENV=production` and the default is in use. |
| `DB_POOL_SIZE` | `10` | PostgreSQL connections per process |

Other scripts: `npm run build` / `npm start` (compiled), `npm run migrate`, `npm run typecheck`,
`npm run agent`, `npm run loadtest`.

---

## Concepts

| Concept | Meaning |
|---|---|
| **Account** | An application or company calling the service, identified by its API key. Its plan sets limits shared by all its users. |
| **User** | An end user of that application, registered under the account with the application's own id (`externalUserId`). Its plan sets individual limits. |
| **Plan** | A named set of rules: a **monthly allowance** (units per UTC calendar month) and a **maximum per request**. A plan is scoped to accounts or to users. |
| **Units** | The single resource being metered, such as document-processing credits (pages). Always a positive integer. |

**Predefined plans** (read-only, available to everyone):

| Plan | Scope | Monthly allowance | Max per request |
|---|---|---|---|
| Starter (default for accounts) | account | 10,000 | 100 |
| Pro | account | 500,000 | 1,000 |
| Basic (default for users) | user | 500 | 50 |
| Premium | user | 5,000 | 500 |

Accounts can also create **custom plans** for themselves or their users, and edit them at any
time. Edits apply to the next request, with no redeploy.

---

## API

### Conventions

- **Base path** `/v1`. JSON in and out, field names in camelCase. Request bodies are limited to 10 KB.
- **Authentication:** `Authorization: Bearer <API key>`. Every `/v1` route needs an account key,
  except `POST /v1/accounts`, which needs the admin key. The account is always taken from
  the key, never from the URL or body. That is what keeps accounts isolated.
- **Errors** use one shape, with a stable machine-readable `code`:

  ```json
  { "error": { "code": "validation_error", "message": "units must be a positive integer" } }
  ```

  | Status | `code` | When |
  |---|---|---|
  | 400 | `validation_error` | Invalid body, query or JSON; unknown or archived plan |
  | 401 | `unauthorized` | Missing, malformed or unknown API key |
  | 403 | `forbidden` | Wrong admin key; editing a predefined plan |
  | 404 | `not_found` | Unknown route, or a resource that doesn't exist *for this account* |
  | 409 | `conflict` | Duplicate account name, user or plan name |
  | 409 | `idempotency_error` | A `requestId` reused with a different user or number of units |
  | 413 | `payload_too_large` | Body over 10 KB |
  | 500 | `internal_error` | Unexpected; details go to the log only |

- **Paging:** list endpoints return `nextCursor`. Pass it back as `?cursor=` to get the next
  page, until it is `null`. `?limit=` is 1 to 100, default 50. Cursors are opaque.
- **Path ids** (`externalUserId`, `requestId`) must be URL-encoded, so `team/42` becomes
  `team%2F42`.
- **Months** are UTC calendar months, written `YYYY-MM`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness and database check (no auth). `200 {"status":"ok"}` or `503`. |
| POST | `/v1/accounts` | **Admin.** Create an account; returns its API key once. |
| GET | `/v1/account` | The calling account and its plan. |
| PATCH | `/v1/account` | Rename the account and/or switch its plan. |
| GET | `/v1/plans` | Predefined plans and the account's custom plans. `?scope=account\|user`, `?includeArchived=true`. |
| POST | `/v1/plans` | Create a custom plan. |
| GET | `/v1/plans/:planId` | One plan, with where the account uses it. |
| PATCH | `/v1/plans/:planId` | Edit a custom plan's name or limits. Applies to the next request. |
| DELETE | `/v1/plans/:planId` | Archive a custom plan. |
| POST | `/v1/users` | Register a user. |
| GET | `/v1/users` | List users, ordered by `externalUserId`. |
| GET | `/v1/users/:externalUserId` | One user and their plan. |
| PATCH | `/v1/users/:externalUserId` | Switch a user's plan. |
| GET | `/v1/users/:externalUserId/usage` | The user's and the account's usage and remaining this month. |
| GET | `/v1/users/:externalUserId/usage/history` | The user's monthly history. `?months=1..120` (default 12). |
| **POST** | **`/v1/consume`** | **Consume units for a user: accept or reject, with the reason.** |
| GET | `/v1/usage` | The account's usage and remaining this month. |
| GET | `/v1/usage/history` | The account's monthly history. `?months=1..120` (default 12). |
| GET | `/v1/requests` | The decision log, newest first. Filters: `?externalUserId=`, `?decision=accepted\|rejected`, `?month=YYYY-MM`. |
| GET | `/v1/requests/:requestId` | One decision, with its explanation and the limits that were enforced. |

### Consume

```http
POST /v1/consume
Authorization: Bearer ums_...
Content-Type: application/json

{ "externalUserId": "bob", "requestId": "doc:invoice-7731", "units": 6 }
```

- `units`: a positive integer.
- `requestId`: chosen by the caller, at most 200 characters. It is the **idempotency key**,
  unique per account.

Both outcomes are a normal `200`. Branch on `decision`, not on the HTTP status:

```json
{
  "requestId": "doc:invoice-7731",
  "decision": "rejected",
  "rejectionRule": "user_monthly_allowance",
  "rejectedBy": "user",
  "units": 6,
  "month": "2026-10",
  "replayed": false,
  "accountRemaining": 9985,
  "userRemaining": 5,
  "explanation": "Rejected by the plan of user \"bob\": 15 of its 20 monthly units are already used, so 6 units more would exceed the allowance (5 units left)."
}
```

| Field | Meaning |
|---|---|
| `rejectionRule` | `account_max_per_request`, `user_max_per_request`, `account_monthly_allowance`, `user_monthly_allowance`, or `null` when accepted |
| `rejectedBy` | `account` (the shared plan) or `user` (the user's own plan), or `null` |
| `replayed` | `true` when this `requestId` was seen before and the stored decision was returned |
| `accountRemaining`, `userRemaining` | What is left this month, after this request |
| `explanation` | A one-sentence, human-readable reason built from the recorded limits |

Other responses: `400` for invalid input, `404` for an unknown user, and `409 idempotency_error`
when the `requestId` was already used with a different user or `units`.

### Other request bodies

| Endpoint | Body |
|---|---|
| `POST /v1/accounts` | `{ "name": "Acme", "plan": "Pro" }`. `plan` is optional (default Starter). `planId` may replace `plan`. Only predefined account plans can be used at creation. |
| `PATCH /v1/account` | Any of `name`, `plan`, `planId` |
| `POST /v1/plans` | `{ "scope": "user", "name": "Trial", "monthlyAllowance": 20, "maxPerRequest": 10 }`. Allowance can be 0; max per request at least 1. |
| `PATCH /v1/plans/:id` | Any of `name`, `monthlyAllowance`, `maxPerRequest` (the scope is fixed) |
| `POST /v1/users` | `{ "externalUserId": "bob", "plan": "Trial" }`. `plan` is optional (default Basic), or use `planId`. |
| `PATCH /v1/users/:id` | `{ "plan": "Premium" }` or `{ "planId": "..." }` |

Plans are named by `plan` (a name, matched ignoring case) or `planId`, never both. PATCH
bodies reject unknown fields, so a misspelled field is a `400`, not a silent no-op.

### Read responses (examples)

`GET /v1/users/bob/usage`:

```json
{
  "month": "2026-10",
  "externalUserId": "bob",
  "user":    { "plan": { "id": "...", "name": "Trial" },   "used": 21, "monthlyAllowance": 50,    "maxPerRequest": 10,  "remaining": 29 },
  "account": { "plan": { "id": "...", "name": "Starter" }, "used": 61, "monthlyAllowance": 10000, "maxPerRequest": 100, "remaining": 9939 },
  "maxConsumableNow": 10
}
```

`maxConsumableNow` is the largest single request both plans would accept right now: the
smallest of the two remainders and the two per-request maximums.

`GET /v1/usage/history?months=3` lists every month, with zeros where nothing happened:

```json
{ "history": [
    { "month": "2026-10", "used": 61, "requests": { "accepted": 4, "rejected": 3 } },
    { "month": "2026-09", "used": 0,  "requests": { "accepted": 0, "rejected": 0 } },
    { "month": "2026-08", "used": 12, "requests": { "accepted": 2, "rejected": 0 } } ] }
```

Each entry of `GET /v1/requests` has `requestId`, `externalUserId`, `units`, `month`, `decision`,
`rejectionRule`, `rejectedBy`, `explanation`, `createdAt`, and `limits`. `limits` is the
snapshot of what was enforced: each plan's id, allowance, max per request, and the usage
before this request.

---

## Design

### Data model

```
plans ──< accounts ──< users
  ▲          │           │
  │          ▼           ▼
  │    account_usage  user_usage     one counter row per subject per UTC month
  │          └─────┬─────┘
  └──────────── requests             one row per consume decision, with a snapshot of the limits
```

- **plans:** `scope` (`account`/`user`), limits, `is_predefined`, `owner_account_id`
  (NULL for predefined plans), and `archived_at`. Custom plans belong to one account.
- **accounts:** name (unique, ignoring case), SHA-256 hash of the API key (the key itself is
  never stored), and plan.
- **users:** `(account_id, external_user_id)` is unique, so the same id under two accounts is
  two different users.
- **account_usage** and **user_usage:** `used` per `(subject, month)`, where `month` is the
  first day of a UTC month.
- **requests:** the decision log. `(account_id, request_id)` is unique, and that constraint is
  the idempotency guarantee. Each row stores a snapshot of the limits that were enforced and
  the usage before the request.

The database enforces the rules itself, not only the API:
- **Scope:** composite foreign keys `(plan_id, plan_scope) → plans(id, scope)` stop an
  account from being on a user plan, and the other way round. A trigger keeps a plan's scope
  immutable.
- **Ownership:** a trigger stops an account or user from being assigned another account's
  custom plan.
- **Request belongs to its account:** `requests (user_id, account_id) → users (id, account_id)`.
- **Values:** `CHECK` constraints for non-negative counters, first-of-month dates, and a
  decision consistent with its rule.
- **Accepted rows fit their limits:** `requests_accepted_within_limits` rejects an accepted row
  whose snapshot shows it exceeded a limit, which catches logic bugs at insert time.

Migrations are plain SQL in [migrations/](migrations/), applied in order at startup by
[src/migrate.ts](src/migrate.ts). Each file runs in its own transaction under an advisory
lock, so two instances starting together don't race.

### The consume transaction

[src/consume.ts](src/consume.ts) runs one transaction at PostgreSQL's default READ COMMITTED
isolation:

1. Validate `units`, and compute the UTC month from an injectable clock.
2. Read the user and the **current** limits of both plans. Plans are read on every request
   and never copied onto accounts or users, so edits apply to the next request.
3. `INSERT ... ON CONFLICT DO NOTHING` this month's two counter rows. The first request of a
   month creates them, and concurrent first requests don't fail.
4. `SELECT ... FOR UPDATE` the **account counter, then the user counter**. Every consume takes
   the locks in this fixed order, so two consumes can't deadlock.
5. Look up `requestId`. If it exists, return the stored decision (`replayed: true`) without
   counting anything, or a `409` if the user or units differ. The lookup happens *after* the
   account lock, so a concurrent retry of the same request waits for the first one to commit
   and then finds it.
6. Decide with [src/decision.ts](src/decision.ts), a pure function. Rejections are checked
   in this order: account max per request, user max per request, account allowance, user
   allowance.
7. If accepted, add the units to both counters.
8. Insert the decision with its snapshot, and return.

**Why row locks on counters**, not optimistic updates like `UPDATE ... WHERE used + n <= allowance`:
the decision involves two counters, two plans and an idempotency check that must be atomic
together. Locking both counter rows makes the whole check-and-count serial per account and
per user, which is simple to reason about and was verified under load (below). The cost is
that one account's consumes run one at a time. See [Load tests](#load-tests).

### Explanations

Each decision's explanation is generated from the snapshot stored with the request, not
from the current plans. A decision made under the old limits keeps explaining itself
correctly after a plan is edited, and a replayed request returns the original explanation.

### Other choices

- **Isolation:** the API key resolves to an account in middleware. Every query is filtered by
  that account id. Another account's users, plans and requests return `404`, the same as if
  they didn't exist, so callers learn nothing about other accounts.
- **Keyset pagination** on `(created_at, id)` for requests (`id` breaks ties between rows
  committed in the same microsecond), and on `external_user_id` for users. Pages stay correct
  while new rows arrive, unlike `OFFSET`. Cursors carry the timestamp at microsecond
  precision, because a millisecond JavaScript `Date` would skip or repeat rows.
- **Archive instead of delete:** requests reference plans, and accounts or users may still
  be on a plan, so a custom plan is archived. Existing assignments keep working, the plan
  can't be newly assigned, and its name becomes free for a new plan.
- **Stateless service:** all state is in PostgreSQL, so more instances can run behind a load
  balancer. Graceful shutdown finishes in-flight requests on `SIGTERM`.

---

## Assumptions and product decisions

The brief leaves these open. Each was decided once and applied everywhere.

**Accounts and keys**
1. Accounts are created by the **operator** with an admin key (`ADMIN_API_KEY`) through
   `POST /v1/accounts`. This answers "who can create accounts?" without a public sign-up.
2. Each account has **one API key**, shown once at creation and stored only as a SHA-256 hash.
   Plain SHA-256 is enough because keys are 256-bit random values, not passwords. There is
   no key rotation (see limitations).
3. Account names are unique, ignoring case. New accounts start on a predefined account plan
   (default Starter); custom plans can only exist once the account does.

**Users**
4. Users must be **registered** before they can consume. An unknown user gets `404`; users are
   not created implicitly, so a typo can't create a new quota.
5. `externalUserId` is the application's own id: 1 to 100 characters, any characters, unique
   per account. Users can change plans but are never renamed or deleted.

**Plans**
6. A plan has exactly two limits: a monthly allowance and a max per request. An allowance of 0
   is valid (a plan that allows nothing); max per request is at least 1.
7. Predefined plans are read-only (`403`). Custom plans belong to the account that created
   them and are invisible to others.
8. Plan names are matched ignoring case. A custom plan can't reuse a predefined plan's name in
   the same scope, so "Basic" means the same plan to everyone.
9. A plan's scope can't change: create a new plan instead.

**Consume and limits**
10. A request is accepted only if **both** the account plan and the user plan allow it. A
    rejection counts nothing but is recorded.
11. When several rules fail, the first one in this order is reported: **account max per
    request, user max per request, account allowance, user allowance**. Per-request limits
    come first, because a request over a per-request max can never succeed, so "allowance
    used up" would mislead the caller into waiting for next month.
12. Allowances reset at the start of each **UTC** calendar month. Unused units don't carry over.
13. Plan changes, edits and switches alike, apply to the **next** request. Usage already
    counted this month is kept. If an allowance drops below current usage, `remaining` shows
    `0` (never negative) and further requests are rejected until next month or a raise.

**Idempotency**
14. `requestId` is unique per account, forever (not per month). Two accounts can use the same
    id independently.
15. A repeated `requestId` returns the **stored** decision, even if limits have changed since.
    A retry never re-decides, so a rejected request stays rejected. To try again after a
    plan change, send a **new** `requestId`.
16. Reusing a `requestId` with a different user or number of units is a client error (`409`).
17. A replay's `accountRemaining`/`userRemaining` show the **current** remaining for this month.
    Its `explanation` and `month` describe the original decision.

**Read side**
18. Usage endpoints report the current month. History endpoints report used units and
    accepted/rejected counts per month, including empty months.

---

## Example client

[client/sdk.ts](client/sdk.ts) is a small typed client with no dependencies. It retries only
calls that are safe to repeat: reads, and `consume`, which is idempotent by `requestId`.
Network errors and 5xx responses are retried with backoff. A test checks the hard case: the
server counted the units, but the response was lost. The retry returns `replayed: true`, and
the units are counted once.

[client/demo.ts](client/demo.ts) plays the backend of "DocuFlow", a document-processing app
(one page = one unit):
1. It onboards an account and creates a custom "Trial" plan.
2. It registers two users and processes documents, hitting each kind of limit.
3. It retries a document with the same request id.
4. It raises the plan's allowance live and retries as a new request.
5. It prints usage, history and the rejected requests with their explanations.

Every step is checked, so it doubles as an end-to-end smoke test: `npm run demo`, or the
`client` service in Docker Compose.

---

## AI agent

[agent/](agent/) is a Claude-powered document assistant. It shows the brief's core scenario
with an AI application as the caller: **every document the agent reads is billed to an end
user's credits through this service, before the text is returned**.

- **Tools** ([agent/tools.ts](agent/tools.ts)):
  - `list_documents`, free: the documents and their credit cost (one credit per started 500
    characters).
  - `check_quota`, free: the user's and the company's remaining credits and the largest read
    allowed now.
  - `read_document`, metered: consumes the document's credits, then returns the text. If the
    service rejects it, the tool returns the rejection and its explanation instead, and the
    agent is told not to guess the contents.
  - `recent_activity`, free: recent decisions with explanations.
- **Bound to one user:** the end user is fixed by the application, never chosen by the model,
  so the agent can't spend another user's credits.
- **Idempotent reads:** request ids are `agent:<run id>:<document>:<content hash>`, so
  re-reading a document in the same run is a free replay, and a retried call can't double
  charge.
- **Model and loop** ([agent/agent.ts](agent/agent.ts)): Claude Opus 5.5 (`claude-opus-5-5`)
  through the Anthropic TypeScript SDK's tool runner, with effort `medium` and a 12-step cap.
  **Server-side refusal fallback** (`fallbacks: "default"`) is enabled: if a safety classifier
  declines a turn, the API retries it on a recommended fallback model. A final `refusal` is
  reported, not returned as an empty answer.

Run it against a running service:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run agent -- "Summarize every document, then tell me how many credits I have left"
```

Without `METERING_API_KEY`, the agent creates a demo account whose user is on an
"Agent Trial" plan: 10 credits a month, at most 5 per read. "Read everything" then meets
both limits. The 6-credit roadmap exceeds the per-read limit, and a second run in the same
month runs out of allowance. The agent explains both using the service's own
explanations. Its tests ([tests/agent.test.ts](tests/agent.test.ts)) run the real tool loop
against the real service, with a scripted model behind a fake transport, so no API key is
needed.

---

## Tests

```bash
npm test
```

Vitest, against a real PostgreSQL. A global setup recreates `usage_metering_test` and applies
the migrations; each test starts from empty tables. 117 tests in 10 files:

| File | Covers |
|---|---|
| `decision.test.ts` | the pure decision function, rule order, remaining, explanations |
| `consume.test.ts` | the transaction: counting, rejection, snapshot, replay, 409, plan edits, UTC month boundary, and **concurrency** (60 parallel requests against a limit of 100 accept exactly 10; 20 parallel retries count once; no deadlocks) |
| `http.test.ts` | health, 404, malformed or oversized bodies, **API key auth** (missing, malformed, unknown, admin-only) |
| `isolation.test.ts` | **cross-account isolation**: no reading, consuming, assigning or editing across accounts; shared request ids and user ids stay independent |
| `accounts.test.ts`, `plans.test.ts`, `users.test.ts` | creation, validation, conflicts, live plan edits, archiving, paging, plan switches, usage and history |
| `requests.test.ts` | consume over HTTP, explanations, account usage and history, request log paging (including tied timestamps) and filters |
| `client.test.ts` | the demo end to end; SDK retries (a lost response is replayed, never double-counted) |
| `agent.test.ts` | the agent's metered tools and its tool loop with a scripted model |

---

## Load tests

[loadtest/run.ts](loadtest/run.ts) drives a running service over HTTP. After each scenario it
checks that the counters exactly match the accepted decisions.

```bash
npm run build && DATABASE_URL=postgres://postgres@localhost:5432/usage_metering_load npm start
SERVICE_URL=http://localhost:3000 npm run loadtest      # writes loadtest/results.md
```

Results from [loadtest/results.md](loadtest/results.md):
- **Machine:** an i7-1165G7 laptop (4 cores / 8 threads, 7.5 GiB RAM, Linux), with the load
  generator, the compiled service and PostgreSQL 18.6 (default settings) all on it.
- **Service:** a single process with a pool of 10 database connections.

| Scenario | Requests | Concurrency | req/s | p50 ms | p95 ms | p99 ms | Errors | Result |
|---|---|---|---|---|---|---|---|---|
| spread: 20 accounts × 5 users | 20,000 | 64 | 1,298 | 47.8 | 59.6 | 79.6 | 0 | 20,000 accepted, counters exact |
| hot-account: 1 account × 50 users | 10,000 | 64 | 296 | 189.3 | 392.6 | 414.2 | 0 | 10,000 accepted, counter exact |
| hot-user: 1 account × 1 user | 5,000 | 64 | 392 | 163.0 | 208.1 | 266.8 | 0 | 5,000 accepted, counter exact |
| exhaustion: allowance 1,000, 3,000 requests | 3,000 | 100 | 463 | 212.7 | 239.6 | 248.4 | 0 | **exactly 1,000 accepted**, 2,000 rejected by `account_monthly_allowance` |
| retries: 300 ids × 10 sends, shuffled | 3,000 | 100 | 653 | 146.9 | 179.5 | 203.1 | 0 | **300 counted, 2,700 replayed** |

**Reading the numbers:**
- **Correctness held in every scenario.** There were no lost updates, no overspending of an
  allowance, and no double counting, with 64 to 100 concurrent requests.
- **Throughput across many accounts** (about 1,300 req/s) is bounded by this one laptop
  running everything; the service is stateless and scales out.
- **One busy account is serialized by design.** Every consume for an account holds that
  account's counter lock from `SELECT ... FOR UPDATE` to `COMMIT`, which spans about five
  statements. That caps a single account at roughly 300 to 460 req/s on this machine (it
  varied between runs). High p95 latencies there are mostly time spent waiting for the lock.
- **Disk flushes are not the bottleneck.** Turning off `synchronous_commit` made no measurable
  difference to hot-account throughput (369 req/s versus 461 in a back-to-back run). The
  ceiling comes from the round trips made while the lock is held.

---

## Limitations and future work

- **Per-account throughput ceiling.** Consumes for one account are serialized, at a few hundred
  per second here. Options if one customer needs more:
  - Run the transaction as a single database function, one round trip, to shorten the lock.
    [scratch/consume.sql](scratch/consume.sql) is that prototype.
  - Split hot counters into shards.
  - Hand out pre-allocated budget slices per user.
- **No key rotation or account deletion.** An account has one key for life. A rotate-key
  endpoint and soft deletion would be next.
- **Admin key comparison** is a plain string compare. Use a constant-time compare
  (`crypto.timingSafeEqual`) and a secrets manager in production.
- **No rate limiting** of the API itself; it should sit behind a gateway that provides it.
- **Archived plans can't be un-archived**, and users can't be deleted.
- **History for past months** reports used units and request counts. It doesn't report the
  allowance a past month had, though every individual decision's limits are in its snapshot.
- **One resource type.** Units are a single resource, as the brief asks. Several meters per
  account would need a `resource` column on plans, counters and requests.
- **No metrics endpoint or structured request logs.** Prometheus metrics and per-request
  logging would come before production.
- **Plan versioning:** decisions keep a snapshot of the limits, but there is no history of a
  plan's edits. An audit log of plan changes is a natural addition.

---

## Project layout

```
src/
  server.ts          entry point: migrate, listen, graceful shutdown
  app.ts             Express app, route mounting, error handler
  auth.ts            API key hashing, authenticate and requireAdmin middleware
  consume.ts         the consume transaction
  decision.ts        pure decision rules and explanations
  plans.ts users.ts reports.ts   plan, user and read-side queries
  routes/            one router per resource
  validate.ts cursor.ts errors.ts dbErrors.ts clock.ts config.ts db.ts migrate.ts
migrations/          SQL schema, applied in order at startup
client/              typed SDK and the demo client
agent/               the Claude document agent and its sample documents
loadtest/            load test runner and recorded results
tests/               Vitest suites against a real PostgreSQL
scratch/             the original SQL prototype of the consume transaction
Dockerfile, docker-compose.yml
```
