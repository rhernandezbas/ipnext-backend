# Proposal — closure-inventory-intelligence

> **Status:** DRAFT (2026-06-02) · SDD store: hybrid · mode: interactive
> Umbrella de mejoras al closure loop de IClass: inventario inteligente + auditoría IA.

## 1. Por qué

El closure loop ya funciona en prod (mirror → transición de stage → OCR → comentario → sugerencias de inventario, verificado sobre la OS 4691). Pero el uso real destapó brechas de **correctitud y producto**:

1. El comentario de cierre atribuye el trabajo al **operador que cerró** la OS, no al **técnico de campo**.
2. El **tipo de equipo** se adivina del **label de la pregunta** del checklist, no de la foto → quedó "ONU" cuando era una antena Ubiquiti.
3. Los **conectores/fichas** usados quedan en el **texto libre** del checklist y **nunca llegan al inventario** (no son `SoMaterial` estructurados).
4. No hay **trazabilidad de quién aprobó** un ítem al inventario (el dato existe, no se muestra).
5. La UI de inventario es **cruda** (sin foto, sin elegir tipo, sin diseño).
6. No hay ninguna **capa de control de calidad** sobre el trabajo del técnico.

Este change cierra esas seis brechas.

## 2. Qué cambia (scope)

| F | Feature | Repos |
|---|---|---|
| F1 | Fix del técnico en el comentario de cierre | BE |
| F2 | Tipo de equipo por imagen (qwen) — híbrido: default del label + sugerencia IA | BE |
| F3 | Extracción de ítems desde el texto libre del checklist (conectores) | BE |
| F4 | Trazabilidad del aprobador ("Aprobado por X el {fecha}") | BE+FE |
| F5 | Rediseño del inventario: foto + dropdown de tipo + MAC/SN + aprobar-con-user | FE |
| F6 | **Auditoría IA**: qwen audita el cierre (multimodal) → hallazgos severidad/categoría/texto, automático al cerrar, subpage tipo comentarios | BE+FE |
| F0 | (transversal) Cerrar el agujero de auth de las rutas de comentarios + permisos granulares en lo nuevo | BE |

## 3. Approach (alto nivel; el detalle va en design)

- **F1** — `PostClosureComment.ts:60`: invertir a `o.teamTechnicianName ?? o.closedByName`; si difieren, mostrar `Técnico:` y `Cerró:`.
- **F2** — extender el `PROMPT` del `OllamaDevicePhotoOcr` para devolver también `device_type`; agregar `deviceType` al port `DeviceOcrResult` (validado contra el enum, función pura TDD); persistir `qwenDeviceType` en `OcrExtraction` y propagarlo a `TaskInventorySuggestion`. El `deviceType` (label) sigue siendo el default; `qwenDeviceType` es la sugerencia.
- **F3** — nuevo use-case `ExtractItemsFromChecklistText` (Ollama texto) que recibe las respuestas tipo Texto + materiales y propone sugerencias `MATERIAL` con `source = 'CHECKLIST_TEXT'`. Engancha en `orchestrateClosure` entre el OCR loop y `buildSuggestions`.
- **F4** — el dato (`addedByUserId`+`confirmedAt`) ya viaja a `ContractInstalledItem`. Falta: exponerlo resuelto a nombre de usuario en el DTO/endpoint y mostrarlo en el FE.
- **F5** — rediseñar `TaskInventorySuggestions.tsx` (impeccable): thumbnail de foto, `<select>` de tipo (default `deviceType`, badge "qwen sugiere: X" si difiere), MAC/SN, confirmar con tipo elegido. Mostrar "Aprobado por" en confirmados y en `ServiceInventorySection`.
- **F6** — nuevo modelo `TaskAuditFinding` (`severity` OK|warning|critical, `category` señal|conexión|fotos|instalación|otros, `text`, `taskId`, `createdAt`). Nuevo adapter `OllamaInstallationAuditor` (call multimodal: todas las fotos vía `images[]` + texto del checklist/observaciones/materiales/señal → JSON estructurado de hallazgos). Nuevo use-case `AuditInstallationQuality` enganchado en `orchestrateClosure` (después de `postComment`, **non-fatal**, flag `ICLASS_AUDIT_ENABLED`). FE: nuevo `TaskAuditFeed` (clon de `TaskCommentsTimeline` sin Composer, `AuditFindingItem` con badge severidad + chip categoría) + tab "Auditoría IA" en `TaskTabs` + hook/api nuevos.
- **F0** — `taskComments.routes.ts`: las 3 rutas hoy **sin auth ni guard** → agregar `auth` + `requirePerm('scheduling', read/write/delete)`. Las rutas nuevas de auditoría: `requirePerm('scheduling','read')` (BE) + `Can`/page guard (FE). Permisos en formato `modulo.accion` (punto) que el `/me` realmente devuelve.

## 4. Módulos afectados

- **BE**: `PostClosureComment`, `OllamaDevicePhotoOcr` + port `DevicePhotoOcr`, `parseOcrResponse`/`finalizeOcrResult`, `classifyDeviceType`, schema (`OcrExtraction`, `TaskInventorySuggestion`, nuevo `TaskAuditFinding`), `BuildInventorySuggestions`, nuevos use-cases (`ExtractItemsFromChecklistText`, `AuditInstallationQuality`), `closureSideEffects`, `IngestClosedServiceOrders.orchestrateClosure`, `taskComments.routes` (auth), nuevas rutas de auditoría.
- **FE**: `TaskInventorySuggestions` (rediseño), `ServiceInventorySection`, nuevo `TaskAuditFeed` + `AuditFindingItem`, `TaskTabs` (1 tab), nuevos hooks/api (`useTaskAuditFindings`, `taskAuditFindings.api`), `StatusBadge` (variantes severidad), tokens (`--badge-ok/warning/critical-*`).
- ⚠️ **`app.ts`** (God Object, 617 líneas): F6 + rutas de auditoría agregan wiring acá. Flag de la regla del proyecto.
- ✅ No agrega dependencias de Splynx.

## 5. Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| Accuracy de qwen (tipo F2, audit F6) | Todo es **sugerencia `pending`** o **audit informativo**; confirmación/decisión humana siempre. F2 mantiene el default del label. |
| Costo/latencia de inferencia (RTX 2060): F2 + F6 suman calls por cierre; F6 multimodal con varias fotos es lento | F6 detrás de flag `ICLASS_AUDIT_ENABLED` + **non-fatal** (no bloquea el cierre). Secuencial (1 GPU). Soft-fail. |
| Migraciones | **Aditivas** (`qwenDeviceType`, tabla `TaskAuditFinding`) → seguras, se pushean directo. |
| Fix de auth de comentarios (F0) | Cambio de comportamiento: las rutas pasan a requerir auth. El FE ya manda credenciales → bajo riesgo, pero **coordinar BE+FE** y verificar con Playwright. |
| Dos repos | Cambios **coordinados**, commits por repo, **push = prod, lo confirma el usuario**. |

**Rollback**: cada feature es revertible por su PR. F6/F2 desactivables por flag/env sin redeploy de código (apagar `ICLASS_AUDIT_ENABLED` / `ICLASS_OCR_ENABLED`). Migraciones aditivas no requieren rollback de datos.

## 6. Fuera de alcance

- Crop/localización de etiqueta del OCR (mejora de accuracy de fondo — otra iteración).
- El `DeprecationWarning` de `pg` (queries concurrentes) — se trata aparte.
- `PersistentKeepalive` del túnel + rotación de password del VPS (operativos, ya pendientes).

## 7. Orden sugerido de implementación

`F1` (quick) → `F0` (auth comments, base de seguridad) → `F2` (tipo por imagen) → `F4` (audit aprobador) → `F5` (FE inventario) → `F3` (texto→conectores) → `F6` (auditoría IA, la más grande). F6 y F3 son independientes y pueden ir en paralelo vía agent team en la fase de apply.
