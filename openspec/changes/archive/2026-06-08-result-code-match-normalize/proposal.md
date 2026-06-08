# Proposal: Normalize IClass Result-Code Match (#36)

## Diagnosis (verified — IClass API + prod DB + code)

45 tasks stuck in stage `registered_in_iclass`, not transitioning. Of the 12 oldest, **8 are `Concluida` (closed) in IClass** but stay parked; 4 are legitimately still open (Em Analise / Fila Técnico) and correctly stay in-flight.

Root cause (IClass data drift): the 8 closed SOs carry `motivoFechamento = "Cliente Ausente."` — **with a trailing period**. The result-code catalog (`GET /serviceordertypes/{id}/resultcodes`) returns `codigo = "Cliente Ausente"` — **no period**. The sync stored the catalog value correctly (71/71 mapped → stage `f3e0ab3b…`).

`IngestClosedServiceOrders.resolveResultCode` (`src/application/use-cases/IngestClosedServiceOrders.ts:338-345`) matches via `findBySoTypeAndCode` → `findByCode`. The Prisma adapter (`PrismaIClassResultCodeRepository.ts:39-56`) already does `code.trim()` + `mode: 'insensitive'`, so **case and outer whitespace are tolerated — but a trailing `.` is NOT**. `"Cliente Ausente."` ≠ `"Cliente Ausente"` → null → `rc=null` → SO is mirrored but the task is NOT moved (`moved=0` in the closure-loop log).

**No migration / no data fix needed.** The idempotency path (`IngestClosedServiceOrders.ts:187-196`) re-evaluates the stage move on EVERY run for already-mirrored, unchanged SOs (its comment literally anticipates "a case-mismatch fixed later"). Once the match tolerates the drift, the next closure-loop / reconcile run heals all stuck tasks automatically.

## Intent

Make the result-code → stage match tolerant of IClass `motivoFechamento` drift (trailing punctuation, internal whitespace, casing) so closed SOs reliably transition their task out of `registered_in_iclass`, instead of parking silently.

## Scope

### In Scope
- `normalizeResultCode(s)` helper: trim, strip trailing punctuation (≥ trailing `.`), collapse internal whitespace, case-insensitive.
- Apply normalization to BOTH sides (incoming `motivoFechamento` AND the stored catalog `code`) so drift on either side is tolerated.
- Exact match first, normalized as a **fallback** (backward-compatible): keep `findBySoTypeAndCode`/`findByCode`; on null, retry normalized.
- New normalized repo capability on `IClassResultCodeRepository` (Prisma + in-memory adapters) — DIP-clean (approach a).

### Out of Scope
- DB migration / normalizing stored catalog on sync (unnecessary — stored value is clean).
- Manual data fix of the 45 stuck tasks (they auto-heal via lines 187-196).
- Widening the 29-day window (earlier wrong hypothesis — NOT the cause).
- The 4 genuinely-open SOs (correctly stay in-flight).
- Any FE change.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `iclass-closure-loop`: the result-code → stage resolution MUST match normalized (trim + strip trailing punctuation + collapse whitespace + case-insensitive) as a fallback after exact match, on both incoming and catalog values.

## Approach

Add a pure `normalizeResultCode` helper. Extend `IClassResultCodeRepository` with normalized finders (`findBySoTypeAndCodeNormalized`, `findByCodeNormalized`) — Prisma adapter compares against the normalized stored `code` (catalog is tiny, 71 rows; fetch-and-compare in the adapter is acceptable), in-memory adapter mirrors the logic. `resolveResultCode` tries exact first, normalized fallback on null. STRICT TDD: red → green via the in-memory port; never mock Prisma.

Tradeoff vs approach (b) (use case fetches candidates, compares in-app): (a) keeps the comparison behind the port — DIP-clean, but adds 2 port methods. Chosen: (a).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modified | `normalizeResultCode` helper; normalized fallback in `resolveResultCode` |
| `src/domain/ports/IClassResultCodeRepository.ts` | Modified | Add normalized finder methods |
| `src/infrastructure/adapters/prisma/PrismaIClassResultCodeRepository.ts` | Modified | Implement normalized finders |
| `src/infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository.ts` | Modified | Implement normalized finders |
| `src/__tests__/application/IngestClosedServiceOrders*.test.ts` | Modified | Drift cases (trailing `.`, whitespace, casing) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Over-normalization collapses two distinct catalog codes | Low | Normalize only trailing punctuation + whitespace + case; keep exact match first so distinct codes resolve precisely |
| Normalized lookup picks wrong row when multiple codes normalize alike | Low | Disambiguate by `soTypeId` first; fallback only when exact null |
| Auto-heal doesn't trigger | Low | Verify lines 187-196 path on a stuck task post-fix via reconcile endpoint |

## Rollback Plan

Revert the commit. The normalized fallback is additive (exact match unchanged), no schema/data change, so reverting restores prior exact-only behavior with zero cleanup.

## Dependencies

- None. No migration, no FE, no external coordination.

## Success Criteria

- [ ] `resolveResultCode` resolves `"Cliente Ausente."` against catalog `"Cliente Ausente"`.
- [ ] Exact-match behavior unchanged for already-matching codes (regression test green).
- [ ] In-memory and Prisma adapters expose equivalent normalized finders.
- [ ] After deploy + one closure-loop/reconcile run, the 8 closed-but-stuck tasks leave `registered_in_iclass`; the 4 open ones stay.
