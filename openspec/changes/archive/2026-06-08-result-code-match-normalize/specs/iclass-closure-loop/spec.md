# Delta for iclass-closure-loop

## ADDED Requirements

### Requirement: REQ-NORMALIZE-1 — Normalized result-code matching

The system MUST expose a `normalizeResultCode(s: string): string` pure helper that applies all of the following transformations in order: trim outer whitespace, strip trailing punctuation characters (at minimum trailing `.`), collapse internal whitespace sequences to a single space, and lowercase. The helper MUST be side-effect-free and deterministic.

The `IClassResultCodeRepository` port MUST expose normalized-finder methods (`findBySoTypeAndCodeNormalized`, `findByCodeNormalized`) that apply `normalizeResultCode` to BOTH the incoming code AND each stored catalog `code` before comparison, then return the first match. The Prisma adapter and the in-memory adapter MUST implement these methods with equivalent behavior.

#### Scenario: Trailing period stripped — catalog match resolves

- GIVEN a catalog entry with `code = "Cliente Ausente"` mapped to a stage
- WHEN `resolveResultCode` is called with `motivoFechamento = "Cliente Ausente."`
- THEN the normalized fallback finds the catalog entry and returns it

#### Scenario: Internal whitespace collapsed — match resolves

- GIVEN a catalog entry with `code = "Cliente Ausente"`
- WHEN `resolveResultCode` is called with `motivoFechamento = "cliente  ausente"`
- THEN the normalized fallback resolves it to the correct entry

#### Scenario: soTypeId disambiguation preserved under normalization

- GIVEN catalog codes "Code A" under soType 1 mapped to stage X, and "Code A" under soType 2 mapped to stage Y
- WHEN `findBySoTypeAndCodeNormalized` is called with soType 1 and `"Code A."`
- THEN it returns the stage X entry, not stage Y

#### Scenario: No false collapse — distinct codes stay distinct

- GIVEN catalog entries "Alpha" and "Alpha Beta" both under the same soType
- WHEN each is looked up by their respective normalized form
- THEN each resolves independently; neither lookup returns the other's entry

---

## MODIFIED Requirements

### Requirement: REQ-MOVE-1 — Transicion de la tarea

The system MUST attempt to resolve `motivoFechamento` to a result-code with `mappedStageId` using an exact match first. If the exact match returns null, the system MUST retry using normalized matching (`normalizeResultCode` applied to both the incoming value and the stored catalog codes). Only after both attempts fail is the code considered unresolvable and the task NOT moved.

(Previously: single exact match only — trailing punctuation and whitespace drift caused silent non-resolution and tasks parked in `registered_in_iclass` permanently.)

#### Scenario: Exact match — task transitions (backward compat)

- GIVEN a closed SO whose `motivoFechamento` matches a catalog code exactly
- WHEN `resolveResultCode` runs
- THEN the exact-match path resolves it (normalized fallback is NOT invoked)
- AND the task is moved to the mapped stage (`transitioned++`)

#### Scenario: Normalized fallback — task transitions on drift

- GIVEN a closed SO whose `motivoFechamento = "Cliente Ausente."` and catalog code = `"Cliente Ausente"` with a `mappedStageId`
- WHEN `resolveResultCode` runs
- THEN exact match returns null, normalized fallback finds the entry
- AND the task is moved to the mapped stage

#### Scenario: No match after both attempts — task not moved

- GIVEN a closed SO whose `motivoFechamento` has no exact or normalized match in the catalog
- WHEN `resolveResultCode` runs
- THEN both lookups return null and the task is NOT moved

#### Scenario: Unmapped result-code — task not moved

- GIVEN a closed SO whose `motivoFechamento` resolves (exact or normalized) to a catalog entry with `mappedStageId = null`
- WHEN `resolveResultCode` runs
- THEN the task is NOT moved

#### Scenario: Normalized fallback only when exact fails

- GIVEN a code that matches exactly
- WHEN `resolveResultCode` runs
- THEN `findByCodeNormalized` / `findBySoTypeAndCodeNormalized` are NOT called (exact path short-circuits)

#### Scenario: Auto-heal of a stuck already-mirrored task

- GIVEN an SO already mirrored (same `iclassUpdatedAt`) whose task is parked in `registered_in_iclass` because the result code did not resolve before the fix
- WHEN the closure loop / reconcile run executes after the fix is deployed
- THEN the idempotency path re-evaluates the stage move, the normalized fallback resolves the code, and the task is moved (`transitioned` incremented)
