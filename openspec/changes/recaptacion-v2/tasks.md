# Tasks: Recaptación v2 — CSV Import (BE)

## Checklist

- [x] **T1** — Prisma schema: add `address`, `churnReason`, `previousPlan` (nullable TEXT) to `RecaptureLead`
- [x] **T2** — Migration: `20260719000000_add_recapture_csv_fields/migration.sql` (additive ALTER TABLE)
- [x] **T3** — Domain entity: add 3 optional fields to `RecaptureLead` interface
- [x] **T4** — Port: add 3 optional fields to `CreateRecaptureLeadData`
- [x] **T5** — CSV parser: `src/application/use-cases/recapture/csvParse.ts` (pure, RFC 4180, no deps)
- [x] **T6** — Use case: `src/application/use-cases/recapture/ImportCsvLeads.ts`
- [x] **T7** — InMemory adapter: include new fields in `create()`
- [x] **T8** — Prisma adapter: include new fields in `create()` and `toRecaptureLeadDomain()`
- [x] **T9** — Routes: add `POST /import-csv` and `GET /import-csv/template` to `recapture.routes.ts`
- [x] **T10** — DI wiring: add `ImportCsvLeads` to `createRecaptureRouter` call in `app.ts`
- [x] **T11** — Tests: `csvParse.test.ts` (9 unit tests, all green)
- [x] **T12** — Tests: `ImportCsvLeads.test.ts` (9 use-case tests, all green)
- [x] **T13** — Tests: `recapture-csv.routes.test.ts` (8 route tests, all green)
- [x] **T14** — Fix existing `recapture.routes.test.ts` for new 11-arg signature
- [x] **T15** — `npx tsc --noEmit` clean

## Status

All tasks complete. 52 recapture tests pass. Typecheck clean.
