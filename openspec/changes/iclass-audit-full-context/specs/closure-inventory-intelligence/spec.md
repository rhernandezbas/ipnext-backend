# Delta for closure-inventory-intelligence

## MODIFIED Requirements

### Requirement: F6-R7 — AuditContext Content

The `AuditContext` MUST include, in addition to the IClass closure data (checklist, observaciones, materiales, ALL photos) and the local task detail (`taskTitle`, `taskDescription`, `taskComments[]`), the following IClass mirror fields:

- `historyCommentary[]`: history transitions that have a non-empty `commentary`, trimmed to a maximum of **10 entries**, each `commentary` truncated to **300 chars**.
- `commentaryLog`: the raw commentary log string, truncated to **500 chars**.
- `internalNote`: the internal note string, truncated to **300 chars**.
- `equipmentEvents[]`: equipment events mapped to `{ type, serialNumber, mac, model }`, maximum **20 entries**.

Trimming MUST be applied in `buildAuditContext` using named constants. Fields absent or empty on the mirror MUST map to empty array / empty string (never `undefined` / `null` propagated into the context).

(Previously: F6-R7 only included checklist, observaciones, materiales, photos, taskTitle, taskDescription, taskComments[].)

#### Scenario: full history with commentary mapped and trimmed

- GIVEN a mirror OS with 15 history entries, 12 of which have non-empty `commentary`
- WHEN `buildAuditContext` is called
- THEN `historyCommentary` contains exactly 10 entries (HISTORY_MAX_ENTRIES limit)
- AND each entry's `commentary` is at most 300 chars

#### Scenario: history entries without commentary are excluded

- GIVEN a mirror OS where 4 of 8 history entries have empty or null `commentary`
- WHEN `buildAuditContext` is called
- THEN `historyCommentary` contains exactly 4 entries (only non-empty commentary ones)

#### Scenario: commentaryLog truncated to budget

- GIVEN a mirror OS with a `commentaryLog` string of 800 chars
- WHEN `buildAuditContext` is called
- THEN `context.commentaryLog` is exactly 500 chars (COMMENTARY_LOG_MAX_CHARS)

#### Scenario: internalNote truncated to budget

- GIVEN a mirror OS with an `internalNote` of 600 chars
- WHEN `buildAuditContext` is called
- THEN `context.internalNote` is exactly 300 chars (INTERNAL_NOTE_MAX_CHARS)

#### Scenario: equipmentEvents capped at max entries

- GIVEN a mirror OS with 25 equipment events
- WHEN `buildAuditContext` is called
- THEN `context.equipmentEvents` has exactly 20 entries (EQUIPMENT_EVENTS_MAX)

#### Scenario: absent mirror fields map to empty defaults

- GIVEN a mirror OS where `commentaryLog`, `internalNote`, and `equipmentEvents` are null/undefined
- WHEN `buildAuditContext` is called
- THEN `context.commentaryLog` is `""`
- AND `context.internalNote` is `""`
- AND `context.equipmentEvents` is `[]`
- AND `context.historyCommentary` is `[]`

---

## ADDED Requirements

### Requirement: F6-R8 — Prompt Includes IClass Mirror Sections

`OllamaInstallationAuditor.renderPrompt` MUST render the four new context fields as compact sections within the prompt string:

- `historyCommentary` rendered as a labeled block: one line per entry showing state transition + commentary.
- `commentaryLog` rendered as a labeled block when non-empty.
- `internalNote` rendered as a labeled block when non-empty.
- `equipmentEvents` rendered as a labeled block: one line per event showing type, SN, MAC, model.

The prompt MUST include an explicit instruction: do NOT mark "falta X" if X appears anywhere in the context (checklist, observaciones, historyCommentary, commentaryLog, internalNote, or equipmentEvents).

Empty sections (empty string / empty array) MUST be omitted from the rendered prompt.

#### Scenario: non-empty mirror fields appear in rendered prompt

- GIVEN an `AuditContext` with one historyCommentary entry, non-empty commentaryLog, and two equipmentEvents
- WHEN `renderPrompt(context)` is called
- THEN the returned string contains a "Historial de estados" block
- AND contains a "Commentary log" block
- AND contains an "Equipos registrados" block
- AND contains the instruction "no marques 'falta X' si X aparece en el contexto"

#### Scenario: empty sections are omitted from prompt

- GIVEN an `AuditContext` with empty `historyCommentary`, empty `commentaryLog`, empty `internalNote`, and empty `equipmentEvents`
- WHEN `renderPrompt(context)` is called
- THEN the returned string does NOT contain "Historial de estados"
- AND does NOT contain "Commentary log"
- AND does NOT contain "Nota interna"
- AND does NOT contain "Equipos registrados"

#### Scenario: no-false-warning instruction always present

- GIVEN any `AuditContext` (with or without mirror fields)
- WHEN `renderPrompt(context)` is called
- THEN the returned string includes the explicit no-false-warning instruction

---

### Requirement: F6-R9 — Remediation Migration Resets Existing Audits

A data-only Prisma migration MUST reset `auditDone = false` and `auditAttempts = 0` on all `IClassServiceOrder` records where `auditDone = true`, so the existing reprocess loop re-audits them with the new full context. (Corrected per design: the audit flags live on `IClassServiceOrder`, not `ScheduledTask` — confirmed against schema.prisma and the #22 migration.)

The migration MUST be idempotent: running it more than once MUST NOT reset tasks that were already re-audited after the first run (i.e., where `auditDone` became `true` again post-migration).

Replace-on-rerun semantics (F6-R3) guarantee the previous `InstallationAudit` record survives until a new successful run overwrites it.

This migration MUST NOT alter the schema — only data values.

#### Scenario: migration resets previously-audited tasks

- GIVEN tasks T1 (auditDone=true), T2 (auditDone=false), T3 (auditDone=true)
- WHEN the remediation migration runs
- THEN T1.auditDone=false, T1.auditAttempts=0
- AND T2 is unchanged (auditDone=false, auditAttempts as-is)
- AND T3.auditDone=false, T3.auditAttempts=0

#### Scenario: migration is idempotent

- GIVEN the migration was already applied (all previously-done tasks now have auditDone=false)
- AND task T4 completed re-audit (auditDone=true again)
- WHEN the migration runs a second time
- THEN T4 is reset again (auditDone=false, auditAttempts=0)

> Note: idempotency here means the SQL WHERE clause is `auditDone = true` with no version guard — any completed audit gets reset on each run. This is acceptable: the migration is a one-time remediation; re-running it in a subsequent deploy is harmless because the loop will re-audit promptly.

#### Scenario: prior audit record survives until new run

- GIVEN task T1 has an existing `InstallationAudit` record with findings
- AND the migration has reset T1 to auditDone=false
- WHEN the reprocess loop starts but has NOT yet completed re-audit of T1
- THEN `GET /scheduling/:taskId/audit-findings` still returns the previous findings
- WHEN the reprocess loop completes a successful re-audit of T1
- THEN `GET /scheduling/:taskId/audit-findings` returns the new findings (replace-on-rerun)
