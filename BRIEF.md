# Usage Metering and Quota Service — Brief

Backend service (TypeScript + PostgreSQL) that other apps call to track usage and decide whether their users may perform an action.

- Account = calling app/company (API key, account plan, shared limits)
- User = end user under an account (user plan, individual limits)
- Plan = named rules: monthly allowance (UTC month) + max units per request
- Consume: API key + user id + positive integer units + request id -> accept only if BOTH account and user plans allow; rejection consumes nothing
- Explain decisions (which rule, account or user), show usage/remaining, monthly history, paginated request history
- Predefined plans (Starter/Pro account; Basic/Premium user), read-only; custom plans per account, editable live
- Plan changes apply to new requests; usage preserved; reduced allowance below usage -> 0 remaining
- Idempotent retries via request id; safe under concurrency
- Deliverables: service, example client, docker-compose (service + Postgres + client), README (API, assumptions, design, limitations), automated tests (incl. API key + isolation), load tests with results
