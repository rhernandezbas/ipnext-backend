# Archive Report — inventory-edit-and-match

**Archivado**: 2026-06-03
**Artifact store**: hybrid (openspec + engram)
**Estado**: ✅ COMPLETO — en prod (BE PR#33 + FE PR#27)

## Resumen
Refinamiento del #8 (`service-inventory-management`). Surge de la tarea 4691 (ONU confirmado que era antena). Planificado con SDD + agent team en modo automático, Strict TDD, sin migración de schema.

## Features
| Feature | Descripción | Estado |
|---------|-------------|--------|
| F1 | `CorrectConfirmedDeviceType` (admin, `inventory.manage`): corregir el tipo de un equipo confirmado **sincroniza** `TaskInventorySuggestion.deviceType` + el `ContractInstalledItem` linkeado (vía `confirmedItemId`). Ruta `PATCH /scheduling/:taskId/inventory/suggestions/:suggestionId/type`, tipo inválido→422, estado inválido→409. Cierra la inconsistencia de la 4691. | ✅ prod |
| F2 | `ListTaskInventorySuggestions` enriquece cada sugerencia DEVICE con `match` contra el inventario activo del contrato: mismo SN/MAC→`same_device`; mismo tipo distinto SN→`same_type`; sin coincidencia→null. FE muestra badge. | ✅ prod |

## Decisiones clave
- Match por **SN/MAC = aparato físico** (no por tipo). MAC normalizada con strip de `:`/`-`. `same_device` tiene prioridad sobre `same_type`.
- Edición de tipo confirmado = acción **admin** (`inventory.manage`).
- `confirmedItemId` null → `SuggestionNotLinkedError` (error dedicado). F1 solo aplica a DEVICE (los MATERIAL no entran).
- Reusa `setStatus(id,'confirmed',confirmedItemId,deviceType)` para escribir el tipo en la sugerencia (sin método de repo nuevo). Sin migración de schema (`inventory.manage` ya existía del #8).

## PRs / Verificación
- BE PR #33 (deploy verde) + FE PR #27 (deploy verde). BE 2223 jest, FE 1828 vitest, cero regresiones.

## Source of truth
- `openspec/specs/inventory-edit-and-match/spec.md` (22 requisitos RFC 2119).

## Fuera de scope
- Reemplazo formal de equipo (`status='replaced'`) — el match solo avisa "posible reemplazo".
- Match de materiales (es por consumo, no por identidad física).
- Editar SN/MAC desde la card (solo el tipo).
