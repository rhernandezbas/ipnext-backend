# Proposal: IClass Audit — Full Context (backlog #20)

## Intent

El auditor IA marca warnings falsos ("no dejó observaciones", "no se verificó señal", "no hay fotos") en OS que SÍ tienen ese detalle en el espejo IClass (visto en OS 4673). Causa: `buildAuditContext` solo arma el contexto con checklist/nota/materiales/fotos/tarea, e ignora `order.history` (commentary por transición), `order.commentaryLog`, `order.internalNote` y `order.equipmentEvents` — campos que el espejo YA persiste. El modelo audita con contexto incompleto.

## Scope

### In Scope
- Extender `AuditContext` (domain) con: historial de estados con commentary, `commentaryLog`, `internalNote`, eventos de equipos (tipo/SN/MAC/modelo).
- `buildAuditContext`: mapear esos campos con **recorte** (solo entradas de history con commentary no vacío, tope de entradas y de chars por campo — qwen2.5vl:7b degenera con prompts grandes).
- `OllamaInstallationAuditor.renderPrompt`: secciones nuevas compactas + instrucción de NO marcar "falta X" si X aparece en el contexto.
- Remediación: migration data-only (patrón #22) que resetea `auditDone=false` y `auditAttempts=0` en OS ya auditadas, para que el reprocess/ingest existente las re-audite con el contexto nuevo. Replace-on-rerun garantiza que la auditoría previa sobrevive hasta el run nuevo exitoso.
- Tests: `buildAuditContext` (mapeo + recortes), prompt rendering, contexto en `AuditInstallationQuality`.

### Out of Scope
- Cambios FE, nuevos endpoints, cambio de modelo/proveedor IA.
- Llamadas nuevas a IClass/Splynx (Postgres es la fuente).
- Cambios de schema Prisma (los campos ya existen en el espejo).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `closure-inventory-intelligence`: F6-R7 se extiende — el `AuditContext` DEBE incluir además history-con-commentary (recortado), commentaryLog, internalNote y equipmentEvents del espejo IClass.

## Approach

Cambio puro de mapeo + prompt, sin tocar wiring ni schema. Presupuesto de prompt explícito por sección (constantes en `buildAuditContext`): history → solo entradas con commentary, máx ~10, commentary truncado; commentaryLog/internalNote truncados; equipos → línea por evento. El `format` JSON-schema ya acota la degeneración de salida; el recorte acota la de entrada. La remediación reusa el loop existente (`listPendingSideEffects` + Reprocesar) — la migration solo flipea flags.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/entities/installation-audit.ts` | Modified | Campos nuevos en `AuditContext` |
| `src/application/services/buildAuditContext.ts` | Modified | Mapeo + recorte |
| `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` | Modified | `renderPrompt` |
| `prisma/migrations/*_remediate_audit_full_context/` | New | Reset `auditDone`/`auditAttempts` |
| `src/__tests__/...` | Modified/New | Tests de mapeo, prompt y use case |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Prompt grande → JSON truncado del modelo local | Med | Recortes por sección con tope de chars; `format` schema ya constriñe salida |
| Re-auditoría masiva satura Ollama | Med | Reset gradual vía loop existente con `maxAuditAttempts`; flag `iclass-audit` permite apagar |
| History ruidoso confunde al modelo | Low | Solo entradas con commentary; instrucción explícita en el prompt |

## Rollback Plan

Revertir el commit de código (mapeo/prompt son aditivos). La migration es data-only e inocua ante rollback: los flags reseteados se re-marcan al re-auditar; apagar el flag `iclass-audit` detiene todo al instante.

## Dependencies

- Flag `iclass-audit` habilitado para validar en vivo; Ollama con `qwen2.5vl:7b` disponible.

## Success Criteria

- [ ] Para una OS tipo 4673, el prompt incluye history/commentaryLog/internalNote/equipos y la auditoría deja de marcar "falta observación/foto" cuando el dato existe.
- [ ] Tests nuevos en verde + `npx tsc --noEmit` limpio.
- [ ] Tras la migration, las OS ya auditadas reaparecen como pendientes y se re-auditan sin perder la auditoría previa hasta el run nuevo.
