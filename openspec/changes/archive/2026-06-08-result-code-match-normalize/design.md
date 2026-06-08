# Design: Normalize IClass Result-Code Match (#36)

## Technical Approach

The result-code → stage join must tolerate IClass `motivoFechamento` drift (trailing punctuation, internal whitespace, casing). The existing Prisma/in-memory finders already tolerate **case + outer whitespace** (`trim()` + `mode:'insensitive'`). The remaining gap is **trailing punctuation** (`"Cliente Ausente."`) and **internal whitespace** (`"Cliente  Ausente"`).

We add a pure `normalizeResultCode` helper and two **normalized fallback** finders on the port. `resolveResultCode` tries exact first (unchanged), then normalized on null. Both adapters normalize **both sides** (incoming value AND stored catalog `code`). No migration, no FE, no schema change. The idempotency path (`IngestClosedServiceOrders.ts:187-196`) re-runs `resolveResultCode` + `reconcileStuckTaskStage` on every cycle for already-mirrored unchanged SOs, so the 8 stuck-but-closed tasks auto-heal on the next closure-loop/reconcile run — nothing else required.

## `normalizeResultCode` — definition

```ts
export function normalizeResultCode(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+$/u, '') // strip ALL trailing non-alphanumerics (incl. ".")
    .replace(/\s+/g, ' ');          // collapse internal whitespace to single space
}
```

Examples: `"Cliente Ausente."` → `"cliente ausente"`; `"  CLIENTE   AUSENTE  "` → `"cliente ausente"`; `"Posponer por falta de material"` stays distinct from `"Pospuesta"`. **Conservative**: only trailing punct + whitespace + case. Internal punctuation that distinguishes codes is preserved (e.g. `"a/b"` ≠ `"a-b"`).

Location: a small pure module `src/application/use-cases/normalizeResultCode.ts` (application layer — no domain entity dependency, shared by the use case for parity and re-exported into both adapters via direct import). Pure, no I/O.

## Architecture Decisions

| Decision | Choice | Alternative rejected | Rationale |
|---|---|---|---|
| Where the normalized compare lives | (a) New port methods `findBySoTypeAndCodeNormalized` / `findByCodeNormalized` in both adapters | (b) Use case fetches candidates via `listBySoType`/`listAll` and compares in-app | (a) keeps comparison behind the port — DIP-clean; catalog is tiny (71 rows) so fetch-and-compare in the adapter is fine. Cost: +2 port methods. |
| Match order | Exact (soType→code) → normalized (soType→code) on null | Replace exact with normalized | Backward-compatible; exact match keeps distinct codes precise, normalized only rescues drift. |
| Prisma normalized impl | Fetch candidate rows (by `soTypeId`, else all) then `normalizeResultCode(row.code) === normalizeResultCode(input)` in JS | SQL-side regex strip in WHERE | Prisma can't strip trailing dots in a typed WHERE; JS compare on ≤71 rows is trivial and keeps logic identical to in-memory. |
| Disambiguation | Normalized soType pass before normalized code-only pass | Single normalized code-only pass | Preserves the `soTypeId` disambiguation that maps the same code to different stages across SO types. |

## Data Flow

    motivoFechamento "Cliente Ausente."  (s.resultCodeName)
        │
        ▼ resolveResultCode(s)
    findBySoTypeAndCode (exact)  ── hit ──► IClassResultCode
        │ null
    findByCode (exact)           ── hit ──► IClassResultCode
        │ null
    findBySoTypeAndCodeNormalized ─ hit ─► IClassResultCode   ← rescues drift
        │ null
    findByCodeNormalized         ── hit ──► IClassResultCode
        │ null
        ▼  rc=null (uncatalogued — legit)

Resolved `rc.mappedStageId` → `reconcileStuckTaskStage` (lines 187-196) moves the task out of `registered_in_iclass` next run.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/application/use-cases/normalizeResultCode.ts` | Create | Pure `normalizeResultCode(s)` helper + tests target |
| `src/domain/ports/IClassResultCodeRepository.ts` | Modify | Add `findBySoTypeAndCodeNormalized`, `findByCodeNormalized` |
| `src/infrastructure/adapters/prisma/PrismaIClassResultCodeRepository.ts` | Modify | Implement normalized finders (fetch candidates + JS compare) |
| `src/infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository.ts` | Modify | Mirror normalized finders |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modify | Normalized fallback in `resolveResultCode` (after exact null) |
| `src/__tests__/application/IngestClosedServiceOrders*.test.ts` | Modify | Drift cases: trailing `.`, internal whitespace, casing; regression for exact |

## Interfaces / Contracts

```ts
// IClassResultCodeRepository — additions
findBySoTypeAndCodeNormalized(soTypeId: string, code: string): Promise<IClassResultCode | null>;
findByCodeNormalized(code: string): Promise<IClassResultCode | null>;
```

`resolveResultCode` after the existing exact block:

```ts
if (s.soTypeId) {
  const byTypeN = await this.resultCodes.findBySoTypeAndCodeNormalized(s.soTypeId, s.resultCodeName);
  if (byTypeN) return byTypeN;
}
return this.resultCodes.findByCodeNormalized(s.resultCodeName);
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `normalizeResultCode` cases (trailing `.`, multi-space, case, distinct-code non-collapse) | Pure function table tests |
| Unit (port) | In-memory normalized finders resolve drift; soType disambiguation | `InMemoryIClassResultCodeRepository` |
| Use case | `resolveResultCode` exact-first then normalized fallback; regression for exact | In-memory port (NEVER mock Prisma) |

STRICT TDD: red → green via in-memory port.

## Migration / Rollout

No migration required. Additive, exact-match unchanged. Rollback = revert commit, zero cleanup. Post-deploy: one closure-loop/reconcile run heals the 8 closed-but-stuck tasks; the 4 genuinely-open stay in-flight.

## Open Questions

None.
