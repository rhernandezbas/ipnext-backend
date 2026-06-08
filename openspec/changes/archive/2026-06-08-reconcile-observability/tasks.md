# Tasks: Reconcile Observability (#37)

## Batch A — BE: Per-Task Failure Logging

- [x] A.1 [RED] `BackfillClosedServiceOrders.test.ts` — add test: fake iclass/ingest throws for one task → spy on `console.warn` → assert called with `[backfill] task <seq> FAILED: <msg>`, `counts.failed` incremented by 1, no throw from `execute()` (Scenarios 1 + 2)
- [x] A.2 [RED] `BackfillClosedServiceOrders.test.ts` — add test: non-throwing task → assert no `[backfill] task ... FAILED` warn emitted (Scenario 3)
- [x] A.3 [GREEN] `src/application/use-cases/BackfillClosedServiceOrders.ts` line 92 — change `catch {` to `catch (err) {`, add `console.warn(\`[backfill] task ${task.sequenceNumber} FAILED: ${(err as Error).message}\`)` before `counts.failed++`
- [x] A.4 [VERIFY] `npx jest BackfillClosedServiceOrders --runInBand` — all tests green; `npx tsc --noEmit` — no type errors

## Batch B — FE: In-Flight Count Badge

- [x] B.1 [RED] `src/__tests__/scheduling/settings/InFlightTasksTable.test.tsx` — add test: mock hook returns N items → count element shows N (Scenario 4)
- [x] B.2 [RED] `src/__tests__/scheduling/settings/InFlightTasksTable.test.tsx` — add test: mock hook returns empty array → count shows 0 or empty state, no non-zero count claimed (Scenario 5)
- [x] B.3 [RED] `src/__tests__/scheduling/settings/InFlightTasksTable.test.tsx` — add test: N items → count N; after refetch with N-1 items → count N-1 (Scenario 6) [placed in table test for a clean rerender; the page test mocks the table out]
- [x] B.4 [GREEN] `src/pages/scheduling/settings/InFlightTasksTable.tsx` — render count badge (`"{items.length} en Registrado en IClass"`) beside the section title, sourced from `items.length`; hidden on empty (empty state carries the message); impeccable subtle muted pill
- [x] B.5 [GREEN] `src/pages/scheduling/settings/InFlightTasksTable.module.css` — added `.titleRow`, `.countBadge`, `.countNum` (muted neutral pill tinted toward indigo at low chroma; number carries the weight)
- [x] B.6 [VERIFY] full `npx vitest run` + `npm run typecheck` — green
