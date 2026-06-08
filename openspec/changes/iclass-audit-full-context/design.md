# Design: IClass Audit — Full Context (backlog #20)

## Technical Approach

Pure mapping + prompt change, no wiring/schema changes. `AuditContext` (domain) gains 4 fields with empty defaults; `buildAuditContext` (application) maps them from the `ClosedServiceOrder` mirror applying named trimming budgets; `OllamaInstallationAuditor.renderPrompt` (infrastructure) renders them as compact conditional sections plus a no-false-warning instruction. A data-only migration resets audit flags so the existing reprocess loop (`listPendingSideEffects`: `auditDone=false AND auditAttempts < max`) re-audits everything with the new context. Implements F6-R7 (modified), F6-R8, F6-R9.

## Architecture Decisions

### Decision: Trimming constants live in `buildAuditContext.ts`, exported

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Module constants in `buildAuditContext.ts` (exported) | Trimming is mapping policy, colocated with the only consumer; tests import them | ✅ |
| Domain entity (`installation-audit.ts`) | Pollutes a pure interface file with application policy | ❌ |
| `config.ts` / env | No runtime-tuning need; fail-fast env adds friction for fixed budgets | ❌ |

Values per spec: `HISTORY_MAX_ENTRIES = 10`, `HISTORY_COMMENTARY_MAX_CHARS = 300`, `COMMENTARY_LOG_MAX_CHARS = 500`, `INTERNAL_NOTE_MAX_CHARS = 300`, `EQUIPMENT_EVENTS_MAX = 20`. Worst-case added prompt: 10×~330 (history lines) + 500 + 300 + 20×~80 (equipment lines) ≈ **5.6 KB ≈ ~1.5k tokens** — bounded and safe for qwen2.5vl:7b (output already grammar-constrained by `format` schema).

When history has >10 commentary entries, keep the **last 10** (`.slice(-HISTORY_MAX_ENTRIES)`) — closure detail concentrates at the end of the lifecycle. Trim helper: local `truncate(s, max)` via `slice(0, max)` (spec scenarios assert exact lengths).

### Decision: Prompt sections — conditional blocks after "Materiales", instruction in the closing block

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Conditional labeled blocks, omitted when empty | Compact; no "(ninguno)" noise misread as missing data | ✅ |
| Always-rendered with placeholders (current style for checklist/materials) | Placeholders like "(sin historial)" invite exactly the false "falta X" warnings we're killing | ❌ |

Section order after `Materiales`: `Historial de estados` (one line `- {status}: {commentary}`), `Commentary log`, `Nota interna`, `Equipos registrados` (one line `- {type ?? 'evento'} SN:{sn ?? '?'} MAC:{mac ?? '?'} modelo:{model ?? '?'}`). Labels are the EXACT strings asserted by F6-R8 scenarios. The closing instruction block gains one always-present line: `IMPORTANTE: el contexto ya incluye historial, comentarios y notas — no marques 'falta X' si X aparece en el contexto.` Build via array of optional fragments filtered before `join('\n')` to keep the existing single-template style.

### Decision: Migration targets `IClassServiceOrder` (spec wording correction)

The delta spec F6-R9 says "`ScheduledTask` records", but `auditDone`/`auditAttempts` live on the **`IClassServiceOrder`** mirror (schema.prisma ~L682-683; #22 migration confirms the table name). Design corrects the table; semantics unchanged.

```sql
-- Remediation (#20): re-audit all completed audits with the new full context.
-- The existing reprocess loop (auditDone=false AND auditAttempts < max) picks
-- them up. Replace-on-rerun keeps the prior audit until a new successful run.
UPDATE "IClassServiceOrder" SET "auditDone" = false, "auditAttempts" = 0
WHERE "auditDone" = true;
```

`lastAuditAttemptAt` stays untouched (informational; the loop doesn't filter on it). No version guard — accepted tradeoff per spec note. Folder: `prisma/migrations/20260607*_remediate_audit_full_context/`.

### Decision: New `AuditContext` fields are non-optional with empty defaults

Non-optional `[]` / `''` (per F6-R7: never propagate null/undefined) keeps consumers branch-free and test fixtures simple — the existing `ctx(over: Partial<AuditContext>)` helper just adds 4 defaults.

## Data Flow

    ClosedServiceOrder (mirror: history/commentaryLog/internalNote/equipmentEvents)
            │
            ▼ trim (constants)
    buildAuditContext ──→ AuditContext (+4 fields) ──→ renderPrompt (+4 sections + instruction)
            ▲                                                  │
    AuditInstallationQuality (unchanged)                Ollama qwen2.5vl:7b

    migration: IClassServiceOrder.auditDone←false, auditAttempts←0
            └──→ listPendingSideEffects → existing reprocess loop → re-audit

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/domain/entities/installation-audit.ts` | Modify | +4 fields on `AuditContext` |
| `src/application/services/buildAuditContext.ts` | Modify | Exported constants + mapping/trimming |
| `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` | Modify | `renderPrompt` sections + instruction |
| `prisma/migrations/20260607*_remediate_audit_full_context/migration.sql` | Create | Data-only flag reset |
| `src/__tests__/application/buildAuditContext.test.ts` | Create | F6-R7 scenarios (6) |
| `src/__tests__/infrastructure/OllamaInstallationAuditor.test.ts` | Modify | F6-R8 scenarios via captured `fetch` body `prompt` |
| `src/__tests__/application/AuditInstallationQuality.test.ts` | Modify | Context passed to auditor includes mirror fields |

## Interfaces / Contracts

```ts
// AuditContext additions (installation-audit.ts)
historyCommentary: { status: string; commentary: string }[]; // ≤10, commentary ≤300
commentaryLog: string;                                       // ≤500, '' when absent
internalNote: string;                                        // ≤300, '' when absent
equipmentEvents: { type: string | null; serialNumber: string | null; mac: string | null; model: string | null }[]; // ≤20
```

Mirror mapping: `history[].statusDescription→status`, `equipmentEvents[].modelDescription→model`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (application) | All 6 F6-R7 trim/default scenarios | Pure call with fixture `ClosedServiceOrder`; assert against exported constants |
| Unit (infrastructure) | F6-R8: sections present/omitted, instruction always present | Stub `global.fetch`, assert on captured `body.prompt` (existing pattern) |
| Unit (use case) | Auditor receives context with mirror fields | InMemory repos + spy auditor (existing test file) |

Strict TDD: red → green per scenario. No Prisma mocking.

## Migration / Rollout

Run `migration.sql` on deploy; reset rows re-enter the existing reprocess loop gradually (capped by `maxAuditAttempts`, gated by `iclass-audit` flag — flag off stops everything instantly). Prior `InstallationAudit` rows survive until a successful re-run (replace-on-rerun, F6-R3). Rollback: revert commit; data reset is harmless.

## Open Questions

None blocking. Note for sdd-tasks/apply: F6-R9's "ScheduledTask" wording is a spec typo — the table is `IClassServiceOrder` (this design is authoritative on the table name).
