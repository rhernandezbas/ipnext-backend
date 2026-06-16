# Proposal: IClass estados intermedios → Stage de Prominense + fix del closeDate

> Carpeta legacy `iclass-autoapprove-state-mapping`. **Scope efectivo: intermediate-states + closeDate-fix.** La **cosa 1 (auto-aprobar OS) quedó DESCARTADA** y escalada a IClass (ver `exploration.md` + backlog): no hay endpoint REST de approve, `close` está bloqueado por pesquisa obligatoria, y el web es JSF/Seam stateful no reusable.

## Intent

Reflejar en Prominense el avance EN VIVO de la OS en IClass (agendada → en camino → trabajando → …) moviendo la tarea por los Stages del kanban **automáticamente**, en vez de que el operador no vea progreso hasta el cierre. Y arreglar el bug del `closeDate` que rompe el cierre manual (Fase 2) con HTTP 417.

## Scope

### In Scope
- Mapeo configurable **estado IClass → Stage de Prominense** (`prominenseStageId` en `IClassStatusCatalog`).
- **Auto-move** del `stageId` de la tarea cuando el scheduler capta un cambio de estado (best-effort, dentro del flujo ya existente).
- FE: **selector de Stage por estado** en la página admin "Estados de IClass".
- **Fix** `IClassClient.formatCloseDate` → formato 3-tokens `"yyyy-MM-dd HH:mm:ss -0000"`.

### Out of Scope
- Auto-aprobar OS (cosa 1) — inviable por API, escalado a IClass.
- Subpage de gestión de OS (dropeado).
- Backfill de stage de OS históricas.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `iclass-status-catalog`: además de visibilidad (label/color/tracked), ahora cada estado puede **mapear a un Stage de Prominense** y el scheduler lo **aplica automático** (nuevo requisito de comportamiento).

## Approach

- Migración **aditiva**: `prominenseStageId` (FK nullable a Stage) en `IClassStatusCatalog`.
- En el bloque de captura de `IngestClosedServiceOrders` (`:214-239`, ANTES del guard terminal): si la row del statusCode tiene `prominenseStageId` y el status cambió, mover `task.stageId` — best-effort, no rompe captura ni cierre. **Regla: solo AVANZA, no pisa move manual** (fijar en design).
- Cableado en los **3 bootstraps** + **composition test** (anti "feature muerta", lección W6).
- closeDate: una función + test (RED con el formato viejo de 2 tokens).

## Affected Areas

| Área | Impacto | Qué |
|------|---------|-----|
| `prisma/migrations/` | New | columna `prominenseStageId` |
| `domain/entities/iclass-status-catalog.ts` + repo + in-memory | Modified | campo + upsert/update |
| `application/use-cases/IngestClosedServiceOrders.ts` | Modified | stage-move en la captura |
| `infrastructure/scheduling/bootstrap{TaskAutocomplete,IClassClosure,Backfill}.ts` | Modified | wiring + composition test |
| `infrastructure/adapters/iclass/IClassClient.ts` | Modified | fix `formatCloseDate` |
| FE página "Estados de IClass" | Modified | selector de Stage por estado |

## Risks

| Riesgo | Prob | Mitigación |
|--------|------|------------|
| Auto-move pisa move manual del operador | Med | Regla "solo avanza"; fijada en design + test |
| Feature muerta (no cableada en el cron) | Med | Composition test en los 3 bootstraps |
| Romper contrato FE | Low | `prominenseStageId` aditivo; DTO de status intacto |
| Stage inexistente/borrado | Low | FK nullable + guard best-effort |

## Rollback Plan

Migración aditiva → revertible. Si el auto-move molesta: dejar `prominenseStageId` NULL en todas las rows (no mueve nada) o revertir el commit. El fix del `closeDate` es independiente (revertible solo). Sin flags nuevos (la captura ya corre).

## Dependencies

- Capability `iclass-status-catalog` (de `iclass-status-sync`, ya en prod).
- Catálogo de estados sincronizado (el usuario corre "Sincronizar").

## Success Criteria

- [ ] Configurar `DESPACHADA→[stage]`; al avanzar la OS, la tarea se mueve sola a ese stage.
- [ ] No pisa un move manual del operador.
- [ ] El cierre manual (Fase 2) ya NO tira 417 — `closeDate` correcto, verificado con test (red→green).
- [ ] Verify completo verde (BE jest + tsc) + composition test de los 3 bootstraps + review adversarial CLEAN.
