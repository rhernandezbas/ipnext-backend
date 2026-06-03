# Archive Report — closure-inventory-intelligence

**Archivado**: 2026-06-02
**Artifact store**: hybrid (openspec + engram)
**Estado**: ✅ COMPLETO — 7/7 features desplegadas en prod

## Resumen ejecutivo

Inteligencia sobre el loop de cierre de OS de IClass: trazabilidad del técnico/aprobador,
clasificación de equipo por imagen (qwen híbrido), rediseño del inventario con override de
tipo, y una capa nueva de **auditoría IA** de la calidad de instalación. Todo TDD, additive,
non-fatal y opt-in por flags. Dos repos coordinados (BE Node/Prisma + FE React/Vite).

## Features entregadas

| Feature | Descripción | PRs | Estado |
|---------|-------------|-----|--------|
| F1 | Técnico en el comentario de cierre (separa Técnico vs Cerró) | BE #22 | ✅ prod |
| F0 | Auth (`requirePerm`) en rutas de comentarios | BE #22 | ✅ prod |
| F4 | Trazabilidad del aprobador (`addedByUserName`) | BE #23 / FE #21 | ✅ prod |
| F2 | Tipo de equipo por imagen (qwen, híbrido, label gana) | BE #24 | ✅ prod |
| F5 | Rediseño inventario + type-override + badge "qwen sugiere" | BE #25 / FE #22 | ✅ prod |
| F6 | Auditoría IA de instalación (sub-página de hallazgos) | BE #26 / FE #23 | ✅ prod |

> F3 (ítems desde texto del checklist) quedó especificado pero NO implementado en este ciclo
> — sus requisitos viven en la spec para un cambio futuro.

## Migraciones aplicadas en prod
- `20260604020000_add_qwen_device_type` — columna `qwenDeviceType` en `OcrExtraction` + `TaskInventorySuggestion`.
- `20260604040000_task_installation_audit` — `TaskInstallationAudit` (`taskId @unique`) + `TaskAuditFinding`.

## Decisiones de diseño clave
- **Auditoría como último side-effect non-fatal** de `orchestrateClosure`: nunca rompe el mirror/transición/comentario ya commiteados.
- **Re-run atómico** (delete+insert en transacción): un re-run fallido no destruye la auditoría previa buena.
- **Label gana sobre el modelo**: el `deviceType` extraído del label NUNCA es pisado por la clasificación de qwen; `qwenDeviceType` es metadata sugerida.
- **`normalizeQwenDeviceType`**: desconocido → `null`, NO `'OTROS'` (no inventa tipos).
- **AuditContext con detalle local**: incluye `taskTitle` + `taskDescription` + `taskComments[]` para que el auditor juzgue lo PEDIDO vs lo HECHO (F6-R7, pedido explícito del usuario).

## Engram — observation IDs (traceability)
- proposal: `sdd/closure-inventory-intelligence/proposal`
- spec: `sdd/closure-inventory-intelligence/spec`
- design: `sdd/closure-inventory-intelligence/design`
- tasks: `sdd/closure-inventory-intelligence/tasks`
- archive-report: `sdd/closure-inventory-intelligence/archive-report`

## Source of truth actualizada
- `openspec/specs/closure-inventory-intelligence/spec.md` (capability nueva — copia directa de la delta).

## Pendientes operativos (fuera del scope del change, owner = usuario)
- `PersistentKeepalive=25` en el lado PC del túnel WireGuard (crítico para que el cron llegue a Ollama).
- Rotar el password del VPS (quedó expuesto en chat).
