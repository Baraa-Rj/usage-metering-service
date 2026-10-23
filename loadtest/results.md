# Load test results

Run 2026-10-23T18:54:27.366Z against http://localhost:3088 (scale 1).

Machine: 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz, 8 threads, 7.5 GiB RAM, Linux 7.2.5-3-omarchy, Node v26.8.2.
Server: compiled build (node dist/src/server.js), DB pool of 10 connections, PostgreSQL 18.6 with default settings.
The load generator, the service and PostgreSQL ran on the same machine.

| Scenario | Requests | Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Errors | Accepted | Rejected | Replayed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spread: 20 accounts x 5 users, 1 unit each | 20000 | 64 | 1298 | 47.8 | 59.6 | 79.6 | 143.4 | 0 | 20000 | 0 | 0 |
| hot-account: 1 account x 50 users, 1 unit each | 10000 | 64 | 296 | 189.3 | 392.6 | 414.2 | 451.2 | 0 | 10000 | 0 | 0 |
| hot-user: 1 account x 1 user, 1 unit each | 5000 | 64 | 392 | 163.0 | 208.1 | 266.8 | 278.5 | 0 | 5000 | 0 | 0 |
| exhaustion: allowance 1,000; 3,000 requests of 1 unit from 10 users | 3000 | 100 | 463 | 212.7 | 239.6 | 248.4 | 266.0 | 0 | 1000 | 2000 | 0 |
| retries: 300 request ids, each sent 10 times, shuffled | 3000 | 100 | 653 | 146.9 | 179.5 | 203.1 | 232.7 | 0 | 300 | 0 | 2700 |

## Correctness checks

- PASS spread: no errors
- PASS spread: sum of account counters = 20000
- PASS hot-account: no errors
- PASS hot-account: account counter = 10000
- PASS hot-user: no errors
- PASS hot-user: user counter = 5000
- PASS exhaustion: no errors
- PASS exhaustion: exactly 1,000 accepted
- PASS exhaustion: every rejection is account_monthly_allowance
- PASS exhaustion: account counter = 1,000
- PASS retries: no errors
- PASS retries: 300 counted, 2,700 replayed
- PASS retries: account counter = 300
