# Proposal: Recaptación v2 — CSV Import (BE)

## Intent

Extend the existing recaptación module (#80) with the ability to bulk-import leads via CSV upload. Operators can download a template CSV, fill it with churned-client data from external sources, and upload it back. This unblocks the commercial team when Splynx data is incomplete or when leads come from non-Splynx channels.

## Scope

Backend only. The sibling FE change builds the upload UI against the wire contract defined here.

### In scope

- Add 3 nullable columns to `RecaptureLead`: `address`, `churnReason`, `previousPlan`
- Pure CSV parser (no new npm deps) in the application layer
- `ImportCsvLeads` use case: parses CSV, validates, bulk-creates leads via `RecaptureRepository`
- Two new HTTP endpoints on `/api/recapture`:
  - `POST /import-csv` — JSON `{csv: string}` → `{created, errors[]}`
  - `GET /import-csv/template` — returns `text/csv` template with headers + example row
- Domain entity + port updates to carry the 3 new optional fields
- Prisma adapter + InMemory adapter updated accordingly
- Additive SQL migration (no data loss, no breaking changes)

### Out of scope

- Multipart file upload (kept as JSON for simplicity)
- Duplicate detection on CSV import (FE can show errors if needed)
- FE upload UI (sibling change)

## Approach

Pure hexagonal: CSV parsing lives in the application layer as a pure function, use case calls the port, no Prisma leaks. Migration is additive (3 nullable TEXT columns). Wire contract is fixed upfront so FE can build in parallel.
