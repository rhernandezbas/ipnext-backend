# Spec — closure-inventory-intelligence

> Source of truth promovida desde el change `closure-inventory-intelligence` (archivado 2026-06-02). Requisitos RFC 2119 por feature. Escenarios Given/When/Then completos (~70) en engram `sdd/closure-inventory-intelligence/spec`. TDD: cada requisito tiene su test (jest in-memory BE / vitest FE).

## F1 — Técnico en el comentario de cierre
- **F1-1** (MUST): si `teamTechnicianName` existe → mostrar `Técnico: {teamTechnicianName}`.
- **F1-2** (MUST): si ambos existen y difieren → además `Cerró: {closedByName}`.
- **F1-3** (MUST NOT): si son iguales → NO emitir "Cerró".
- **F1-4** (MUST): si solo `closedByName` → `Cerró: {closedByName}`.
- **F1-5** (MUST NOT): si ninguno → sin línea de técnico.
- **F1-6** (MUST): idempotencia (1 comentario por task) intacta.

## F2 — Tipo de equipo por imagen (híbrido)
- **F2-1/2** (MUST): `DeviceOcrResult.deviceType?` nuevo; el prompt pide `device_type`.
- **F2-3** (MUST): `normalizeQwenDeviceType` valida contra enum; desconocido/empty/null → **null** (NO 'OTROS'); puro, NO throw.
- **F2-5/6/7** (MUST): `OcrExtraction` + `TaskInventorySuggestion` ganan `qwenDeviceType` (entidad + columna aditiva); `BuildInventorySuggestions` lo propaga.
- **F2-9** (MUST): opt-in y non-fatal; si no hay/normaliza → `qwenDeviceType=null`; SN/MAC intactos.
- **F2-10** (MUST NOT): el `deviceType` (label) NUNCA es pisado por la clasificación del modelo.

## F3 — Ítems desde texto del checklist
- **F3-1..4** (MUST): port `ChecklistTextExtractor` + entidad `ChecklistMaterialProposal` + use-case `ExtractItemsFromChecklistText` → sugerencias `MATERIAL`/`source='CHECKLIST_TEXT'`/`pending`.
- **F3-5** (MUST): idempotente (upsert por natural key).
- **F3-6/7** (MUST): error del modelo se maneja non-fatal en el call site; array vacío = resultado válido.
- **F3-8** (MUST): `textAnswers` vacío → `[]` sin llamar al extractor.
- **F3-9** (MUST): wiring en `orchestrateClosure` entre OCR loop y `buildSuggestions`.
- **F3-10** (MUST NOT): el use-case NO importa infraestructura.

## F4 — Trazabilidad del aprobador
- **F4-1** (MUST): `GET /contracts/:id/inventory` incluye `addedByUserName` resuelto (+ mantiene `addedByUserId`).
- **F4-2** (MUST): `addedByUserName=null` cuando `addedByUserId` es null.
- **F4-3** (MUST): la respuesta de confirm incluye `addedByUserName` + `confirmedAt`.
- **F4-4/5** (MUST): FE muestra "Aprobado por {nombre} · {fecha}" o "—".

## F5 — Rediseño inventario + type-override
- **F5-1/2/3** (MUST): card con foto 64×64, MAC/SN, `<select>` de tipo default = `deviceType`.
- **F5-4/5** (MUST): badge "qwen sugiere: {qwenDeviceType}" SOLO si difiere del `deviceType`.
- **F5-6/7** (MUST): confirmar manda el tipo elegido (override) o, sin cambio, `suggestion.deviceType`.
- **F5-8/9** (MUST): el confirm BE acepta `type` opcional; default = `suggestion.deviceType`.
- **F5-10** (MUST): `type` inválido → 422 `INVALID_ITEM_TYPE`, NO ejecuta el use-case.
- **F5-11** (MUST): sin `scheduling.write` → Confirmar/Descartar ocultos; select read-only.

## F6 — Auditoría IA
- **F6-R1** (MUST): corre como ÚLTIMO side-effect de `orchestrateClosure` (después de `postComment`), bajo `ICLASS_AUDIT_ENABLED`, **non-fatal** (no afecta mirror/transición/sugerencias/comentario ya commiteados). Dormida si el flag está off.
- **F6-R2** (MUST): adapter NO throw; modelo inalcanzable/JSON inválido → `{ok:false}` → el use-case NO persiste nada parcial. Items con enum inválido se descartan; se quedan solo los válidos.
- **F6-R3** (MUST): 1 auditoría vigente por task (`taskId @unique`); re-run exitoso REEMPLAZA (delete+insert atómico). Un re-run fallido NO destruye la auditoría previa buena.
- **F6-R4** (MUST): éxito sin problemas → persiste el run + 1 finding `ok` ("Instalación sin observaciones"). Task sin auditoría → endpoint `[]` (estado distinto).
- **F6-R5** (MUST): cada finding tiene `severity ∈ {ok,warning,critical}` + `category ∈ {señal,conexión,fotos,instalación,otros}` + `text` no vacío.
- **F6-R6** (MUST): `GET /scheduling/:taskId/audit-findings` con `auth` + `requirePerm('scheduling','read')`; tab FE bajo `Can permission="scheduling.read"`.
- **F6-R7** (MUST): el `AuditContext` incluye, además del cierre IClass (checklist, observaciones, materiales, TODAS las fotos), el **detalle de la tarea local**: `taskTitle`, `taskDescription` (problema reportado) y `taskComments[]` (comentarios humanos) — para juzgar lo PEDIDO vs lo HECHO.

## F0 — Auth de las rutas de comentarios
- **SC-01..03** (MUST): request sin auth a cualquier ruta de comentarios → 401.
- **SC-04..06** (MUST): autenticado sin `scheduling.read/write/delete` según la ruta → 403.
- **SC-07..09** (MUST): con el permiso correcto → 200/201/204.
- **SC-10** (MUST): el comentario server-side "Sistema IClass" (`PostClosureComment` → repo directo) NO se rompe (no pasa por HTTP).
- RBAC `scheduling.read/write/delete` YA existen → sin migración.
