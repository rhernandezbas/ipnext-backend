# Delta for iclass-closure-loop

## ADDED Requirements

### Requirement: REQ-RETURNS-SIDE-EFFECT-1 — Inventory returns side-effect in closure pipeline

The closure side-effect set (`runClosureSideEffects`) MUST include a `processInventoryReturns` step. This step MUST run alongside the existing comment/audit/inventory side-effects.

The step MUST be gated by: SO type is `RETIROS DE EQUIPOS` AND result code satisfies completed-removal criteria (resultCodeType = 'Sucesso' AND code in the configured removal-code set) AND `inventoryReturnsProcessed = false` on the SO.

When all gate conditions are met, the step MUST delegate to `StageReturnSuggestions` to stage pending returns per OCR serial. The step MUST set `inventoryReturnsProcessed = true` after staging.

When any gate condition is NOT met, the step MUST be a no-op (no staging, no flag mutation).

#### Scenario: Completed-retiro SO triggers returns staging

- GIVEN a closed SO of type RETIROS with a completed-removal result code and `inventoryReturnsProcessed = false`
- WHEN `runClosureSideEffects` executes
- THEN `processInventoryReturns` calls `StageReturnSuggestions` for that SO
- AND `inventoryReturnsProcessed` is set `true`

#### Scenario: Non-completed retiro — side-effect is a no-op

- GIVEN a closed RETIROS SO with result code type Pendente (e.g. "Cliente Ausente") and `inventoryReturnsProcessed = false`
- WHEN `runClosureSideEffects` executes
- THEN `processInventoryReturns` performs no staging and does not set the flag

#### Scenario: Non-retiro SO — side-effect is a no-op

- GIVEN a closed SO that is NOT of type RETIROS DE EQUIPOS
- WHEN `runClosureSideEffects` executes
- THEN `processInventoryReturns` is skipped entirely

#### Scenario: Already-processed SO — side-effect is a no-op

- GIVEN a RETIROS SO with `inventoryReturnsProcessed = true`
- WHEN `runClosureSideEffects` executes
- THEN `processInventoryReturns` performs no staging

---

## MODIFIED Requirements

### Requirement: REQ-IDEMP-1 — Idempotencia

- GIVEN una OS ya espejada con el mismo `iclassUpdatedAt` (alteradoPor.data), **When** se reprocesa, **Then** se skipea (`skippedUnchanged`) sin traer sub-recursos.
- The `skippedUnchanged` path MUST still re-evaluate pending side-effects: `commentPosted`, `inventoryBuilt`, `auditDone`, AND `inventoryReturnsProcessed`. If any of these flags is `false`, the side-effect MUST be re-attempted even when the SO content is unchanged.
(Previously: the unchanged path re-evaluated commentPosted/inventoryBuilt/auditDone only — it did not include `inventoryReturnsProcessed`)

#### Scenario: OS sin cambios, tarea clavada

- GIVEN una OS ya espejada con el mismo `iclassUpdatedAt`
- WHEN se reprocesa
- THEN se skipea (`skippedUnchanged`) sin traer sub-recursos

#### Scenario: Unchanged SO with pending returns side-effect

- GIVEN a SO with unchanged `iclassUpdatedAt` but `inventoryReturnsProcessed = false`
- WHEN the loop re-evaluates the unchanged SO
- THEN `processInventoryReturns` is re-attempted (side-effect not skipped)
- AND `inventoryReturnsProcessed` is set `true` after staging

#### Scenario: Unchanged SO with all side-effects complete

- GIVEN a SO with unchanged `iclassUpdatedAt` AND `commentPosted = true`, `inventoryBuilt = true`, `auditDone = true`, `inventoryReturnsProcessed = true`
- WHEN the loop evaluates the SO
- THEN no side-effect is re-attempted and the SO is counted as fully `skippedUnchanged`
