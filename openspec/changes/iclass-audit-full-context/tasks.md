# Tasks: IClass Audit — Full Context (backlog #20)

## Phase 1: Domain — AuditContext entity

- [x] 1.1 [RED] Write failing test in `src/__tests__/application/buildAuditContext.test.ts`: assert `AuditContext` shape includes `historyCommentary`, `commentaryLog`, `internalNote`, `equipmentEvents` with empty defaults (F6-R7 absent-fields scenario).
- [x] 1.2 [GREEN] Add 4 fields to `AuditContext` in `src/domain/entities/installation-audit.ts` (non-optional, typed per design contracts; empty defaults `[]` / `""`).

## Phase 2: Application — buildAuditContext mapping + trimming

- [x] 2.1 Export trimming constants at top of `src/application/services/buildAuditContext.ts`: `HISTORY_MAX_ENTRIES=10`, `HISTORY_COMMENTARY_MAX_CHARS=300`, `COMMENTARY_LOG_MAX_CHARS=500`, `INTERNAL_NOTE_MAX_CHARS=300`, `EQUIPMENT_EVENTS_MAX=20`. Add local `truncate(s, max)` helper.
- [x] 2.2 [RED] Scenario "full history trimmed to 10": fixture with 12 commentary entries; assert `historyCommentary.length === 10` (last 10 kept) and each `commentary.length <= 300`.
- [x] 2.3 [GREEN] Map `order.history` → `historyCommentary`: filter non-empty commentary, `.slice(-HISTORY_MAX_ENTRIES)`, truncate each commentary.
- [x] 2.4 [RED] Scenario "history entries without commentary excluded": 8 entries, 4 empty; assert length 4.
- [x] 2.5 [RED] Scenario "commentaryLog truncated": 800-char input; assert `context.commentaryLog.length === 500`.
- [x] 2.6 [RED] Scenario "internalNote truncated": 600-char input; assert `context.internalNote.length === 300`.
- [x] 2.7 [RED] Scenario "equipmentEvents capped at 20": 25 events; assert `context.equipmentEvents.length === 20`.
- [x] 2.8 [GREEN] Map `commentaryLog`, `internalNote`, `equipmentEvents` with truncate/slice; map `statusDescription→status`, `modelDescription→model`; default nulls to `""` / `[]`.
- [x] 2.9 Verify all 6 F6-R7 scenarios pass: `npx jest buildAuditContext`.

## Phase 3: Infrastructure — renderPrompt sections + instruction

- [x] 3.1 [RED] Scenario "non-empty mirror fields appear in prompt" (F6-R8): stub `global.fetch`; assert `body.prompt` contains "Historial de estados", "Commentary log", "Equipos registrados", and "no marques 'falta X' si X aparece en el contexto".
- [x] 3.2 [RED] Scenario "empty sections omitted" (F6-R8): all 4 fields empty; assert none of the 4 section labels appear.
- [x] 3.3 [RED] Scenario "no-false-warning instruction always present" (F6-R8): any context; assert instruction string present.
- [x] 3.4 [GREEN] Add conditional sections to `renderPrompt` in `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts`: build via filtered array of optional fragments joined with `\n`; add always-present instruction line per design; section labels exact as in design doc.
- [x] 3.5 Verify F6-R8 scenarios pass: `npx jest OllamaInstallationAuditor`.

## Phase 4: Use-case integration test

- [x] 4.1 [RED] In `src/__tests__/application/AuditInstallationQuality.test.ts`: add scenario asserting the spy auditor receives a context with populated `historyCommentary`, `commentaryLog`, `internalNote`, `equipmentEvents` when the mirror fixture has those fields.
- [x] 4.2 [GREEN] Confirm no wiring changes needed (data flows through existing `buildAuditContext` call); test passes with Phase 2 + 3 work.

## Phase 5: Migration

- [x] 5.1 Create folder `prisma/migrations/20260607010000_remediate_audit_full_context/`.
- [x] 5.2 Write `migration.sql` per design (data-only UPDATE on `IClassServiceOrder` WHERE `auditDone = true`; covers F6-R9 scenarios; idempotency note in comment).

## Phase 6: Full verify

- [x] 6.1 Run full test suite: `npx jest --runInBand`; confirm 0 failures.
- [x] 6.2 Type-check: `npx tsc --noEmit`; confirm 0 errors.
