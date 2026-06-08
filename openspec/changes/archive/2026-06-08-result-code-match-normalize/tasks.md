# Tasks: Normalize IClass Result-Code Match (#36)

## Phase 1: Pure Helper `normalizeResultCode`

- [x] 1.1 RED — write failing tests in `src/__tests__/application/normalizeResultCode.test.ts`: trailing period stripped (`"Cliente Ausente." → "cliente ausente"`), internal whitespace collapsed (`"cliente  ausente" → "cliente ausente"`), distinct codes stay distinct (`"Alpha"` vs `"Alpha Beta"` never collapse) — covers REQ-NORMALIZE-1 / scenarios no-false-collapse + trailing-period-unit.
- [x] 1.2 GREEN — create `src/application/use-cases/normalizeResultCode.ts`: `trim → toLowerCase → replace(/[^\p{L}\p{N}]+$/u,'') → replace(/\s+/g,' ')`. Export named function. Tests go green.
- [x] 1.3 VERIFY — `npx jest normalizeResultCode --runInBand` passes; `npx tsc --noEmit` clean.

## Phase 2: Port + Adapters (normalized finders)

- [x] 2.1 Modify `src/domain/ports/IClassResultCodeRepository.ts`: add `findBySoTypeAndCodeNormalized(soTypeId: string, code: string): Promise<IClassResultCode | null>` and `findByCodeNormalized(code: string): Promise<IClassResultCode | null>`.
- [x] 2.2 RED — add tests in `src/__tests__/application/InMemoryIClassResultCodeRepository.normalized.test.ts` for `InMemoryIClassResultCodeRepository`: trailing-period resolves, soTypeId disambiguation preserved under normalization, distinct codes stay distinct — covers scenarios trailing-period-catalog, soTypeId-disambiguation, no-false-collapse (adapter layer).
- [x] 2.3 GREEN — implement both methods in `src/infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository.ts`: iterate stored entries, compare `normalizeResultCode(entry.code) === normalizeResultCode(input)`, filter by `soTypeId` where provided; return first match or null. Import `normalizeResultCode`.
- [x] 2.4 Implement both methods in `src/infrastructure/adapters/prisma/PrismaIClassResultCodeRepository.ts`: fetch candidates (`findMany` filtered by `soTypeId` when provided, else all), compare `normalizeResultCode(row.code) === normalizeResultCode(input)` in JS; return first match or null. Import `normalizeResultCode`. (No Prisma mock needed — typed-only; integration covered by in-memory parity.)
- [x] 2.5 VERIFY — `npx jest` passes; `npx tsc --noEmit` clean.

## Phase 3: `resolveResultCode` — exact-first then normalized fallback

- [x] 3.1 RED — add/extend tests in `src/__tests__/application/IngestClosedServiceOrders.test.ts` targeting `resolveResultCode` with in-memory repo:
  - Trailing `.` resolves via normalized fallback, task moved (`transitioned++`) — scenario REQ-MOVE-1/normalized-fallback
  - Internal whitespace drift resolves — scenario internal-whitespace-collapsed
  - Exact match still resolves without touching normalized finders — scenario exact-match-backward-compat
  - soType disambiguation preserved under normalization — scenario soTypeId-disambiguation (use-case level)
  - No match after both attempts → `rc=null`, task not moved — scenario no-match
  - Unmapped code (`mappedStageId=null`) → task not moved — scenario unmapped
  - Auto-heal: already-mirrored unchanged SO re-evaluates and transitions — scenario auto-heal
- [x] 3.2 GREEN — modify `resolveResultCode` in `src/application/use-cases/IngestClosedServiceOrders.ts` (lines ~338-345): after `findByCode` returns null, call `findBySoTypeAndCodeNormalized` (when `s.soTypeId` present) then `findByCodeNormalized`; return first non-null. Do NOT alter the exact block.
- [x] 3.3 VERIFY — `npx jest IngestClosedServiceOrders --runInBand` all 10 scenarios green.

## Phase 4: Full Verification

- [x] 4.1 Run `npx jest --runInBand`; confirm zero failures across all test suites.
- [x] 4.2 Run `npx tsc --noEmit`; confirm zero type errors.
- [x] 4.3 Confirm all 10 spec scenarios are covered by a passing test (tick off against spec.md).
