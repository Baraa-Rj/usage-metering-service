# Product Roadmap: next four quarters

## Themes
1. Faster processing for large documents.
2. Usage transparency: every customer should understand what they consume and why.
3. Self-serve plans that customers can tailor without talking to sales.
4. Enterprise controls: audit logs, data residency, single sign-on everywhere.

## Q1
- Streaming OCR pipeline: start returning extracted text before the whole document is
  processed. Target: first page in under 2 seconds for documents up to 300 pages.
- Usage explanations in the dashboard: show, for each rejected job, which limit blocked it
  (the company's shared allowance or the user's own plan) and how much is left.
- Retry-safe job submission API: clients send a job id, and a retried submission returns
  the original result instead of creating a duplicate job.

## Q2
- Custom plans in the admin console: companies define their own user tiers (allowance and
  per-job limits) and change them instantly; changes apply to the next job.
- Monthly usage history export (CSV and API) for finance teams.
- EU-only processing option with data kept in Frankfurt.

## Q3
- Smart batching: group many small documents into one job to reduce overhead by about 30%.
- Table extraction v2 with merged-cell support; current accuracy 81%, target 93%.
- Single sign-on for all plans, not only Enterprise.

## Q4
- Audit log API covering plan changes, user changes and every quota decision.
- Usage alerts: notify admins at 80% and 100% of the monthly allowance.
- Assistant features: an AI agent that answers questions about documents and explains a
  user's remaining credits before starting expensive work.

## Not planned
- Unlimited processing tiers. Shared infrastructure costs scale with pages processed, and
  unlimited tiers would push heavy users' costs onto everyone else.
- On-premise installations. We will revisit this if three or more enterprise customers
  require it in the same quarter.

## Dependencies and risks
The streaming pipeline depends on the storage migration finishing in Q4 this year. Custom
plans need the new billing service; if billing slips, custom plans move to Q3 and smart
batching moves forward. Hiring two platform engineers is the main risk for Q1 and Q2.

## How we measure success
- Median processing time per page, reported weekly.
- Share of rejected jobs whose reason the customer could see in the dashboard (target 100%).
- Support tickets about unexpected usage limits (target: halve them by Q3).
- Net revenue retention above 115% for customers on custom plans.
