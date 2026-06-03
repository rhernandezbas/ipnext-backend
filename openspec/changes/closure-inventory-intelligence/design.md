# Design — closure-inventory-intelligence

> Síntesis del orquestador a partir de 4 work-packages (agent team). Spec detallada en `spec.md` + engram. Hexagonal estricto, TDD, dos repos coordinados.

## Decisiones transversales

- **`DeviceType` se mueve a `src/domain/entities/device-type.ts`** (hoy vive en `application/services/classifyDeviceType.ts`). Así infra y application lo importan del dominio sin violar la dirección de dependencias.
- **Gap del schema**: `TaskInventorySuggestion` tiene `unit` en la entidad pero NO en Prisma → se agrega en la migración de este change.
- **`app.ts` (God Object, 617 líneas)**: F6 + ruta de auditoría + fix de comentarios agregan wiring acá. Riesgo flageado; no se refactoriza en este change.
- **Migración única `closure_inventory_intelligence`** (aditiva): `OcrExtraction.qwenDeviceType`, `TaskInventorySuggestion.qwenDeviceType`, `TaskInventorySuggestion.unit`, tablas `TaskInstallationAudit` + `TaskAuditFinding`.

---

## F1 — Fix del técnico (BE)

`PostClosureComment.buildBody` (línea ~60): hoy `const tech = o.closedByName ?? o.teamTechnicianName` (muestra al que cerró). Cambio:
```ts
if (o.teamTechnicianName) {
  lines.push(`Técnico: ${o.teamTechnicianName}`);
  if (o.closedByName && o.closedByName !== o.teamTechnicianName) lines.push(`Cerró: ${o.closedByName}`);
} else if (o.closedByName) {
  lines.push(`Cerró: ${o.closedByName}`);
}
```
Exportar `buildBody` como función pura para testearla directo. TDD: in-memory comment repo, 6 escenarios (field-tech, ambos distintos, mismo, solo operador, ninguno, idempotencia).

## F2 — Tipo de equipo por imagen, híbrido (BE)

- Port `DeviceOcrResult` (`domain/ports/DevicePhotoOcr.ts`): + `deviceType?: string` (raw del modelo).
- `OllamaDevicePhotoOcr.PROMPT`: pedir también `"device_type":"ONU|ROUTER|ANTENA|REPETIDOR|OTROS"`. `finalizeOcrResult` pasa `parsed.device_type` al resultado.
- Validador puro `normalizeQwenDeviceType(raw): DeviceType | null` en `application/services/` (valida contra el enum; **desconocido → null**, NO 'OTROS', para distinguir match concreto de basura).
- `OcrExtraction` + `TaskInventorySuggestion` (entidades + Prisma): + `qwenDeviceType String?`. `ExtractDeviceInfoFromPhoto` mapea; `BuildInventorySuggestions` propaga.
- **Regla**: el `deviceType` (label) sigue siendo el DEFAULT; `qwenDeviceType` es solo la sugerencia (badge). Nunca lo pisa.
- TDD: `normalizeQwenDeviceType` (puro, 8 casos), `finalizeOcrResult` (device_type presente/ausente), `ExtractDeviceInfoFromPhoto` (in-memory).

## F3 — Ítems desde el texto del checklist (BE)

- Port nuevo `ChecklistTextExtractor.extract(textAnswers, existingMaterials): ChecklistMaterialProposal[]` (`domain/ports/`). Entidad `ChecklistMaterialProposal {description, quantity, unit, sourceText}`.
- Use-case `ExtractItemsFromChecklistText` (depende del port + `InventorySuggestionRepository`). Genera sugerencias `kind='MATERIAL'`, `source='CHECKLIST_TEXT'`, `pending`. Idempotente (upsert por natural key). Early-return `[]` si no hay textAnswers.
- Adapter `OllamaChecklistTextExtractor` (modelo TEXTO; parser defensivo → `[]` si JSON inválido, soft-fail dentro del adapter). In-memory stub para tests.
- Wiring en `orchestrateClosure`: entre el OCR loop y `buildSuggestions`, junta los answers `questionType==='Texto'`, llama al use-case (non-fatal try/catch).
- TDD: use-case (in-memory), parser (puro), orquestación (non-fatal).

## F4 — Trazabilidad del aprobador (BE+FE)

- Dato YA persiste (`ContractInstalledItem.addedByUserId` + `confirmedAt`, desde `req.user.id`). Falta RESOLVER el id a nombre y exponerlo.
- DTO nuevo `InstalledItemDto extends ContractInstalledItem { addedByUserName: string|null }` + `toInstalledItemDto`.
- `ConfirmInventorySuggestion` y `ListContractInstalledItems`: inyectar `RbacUserRepository`, resolver `findById(addedByUserId).name`, devolver DTO. (N llamadas batcheadas; pool de users chico.)
- FE: tipo `ServiceInstalledItem` + `addedByUserName`; render "Aprobado por {nombre} · {fecha}" (o "—" si null) en `ServiceInventorySection` y en la fila confirmada de `TaskInventorySuggestions`.
- TDD: use-cases (in-memory rbac user repo), FE vitest.

## F5 — Rediseño inventario + dropdown + type-override (FE + BE chico)

- **BE**: `ConfirmInventorySuggestionInput` + `typeOverride?: string`; `type: toType(input.typeOverride ?? suggestion.deviceType)`. Ruta confirm valida `type` contra el enum (422 `INVALID_ITEM_TYPE` si inválido).
- **FE**: rediseño con CSS Modules + tokens. Nuevo `SuggestionCard` (sub-componente): thumbnail 64×64, `<select>` de tipo (default `deviceType`, badge "qwen sugiere: {qwenDeviceType}" SOLO si difiere), MAC/SN, Confirmar/Descartar bajo `Can permission="scheduling.write"`. `useConfirmSuggestion` manda `{suggestionId, type}`. `confirmInventorySuggestion(taskId, id, typeOverride?)`.
- Permisos: reusa `scheduling.write` (correcto). No hace falta key nueva.
- TDD: confirm override (jest in-memory + supertest 422), `SuggestionCard` (vitest, ~12 casos), `useConfirmSuggestion`.

## F6 — Auditoría IA (BE+FE) — la grande

**Modelo (Prisma, aditivo):** run padre + hallazgos, replace-on-rerun.
```prisma
model TaskInstallationAudit {
  id String @id @default(uuid())
  taskId String @unique            // 1 auditoría vigente por task (R3)
  task ScheduledTask @relation(fields:[taskId], references:[id], onDelete: Cascade)
  model String                     // "ollama:qwen2.5vl:7b"
  auditedAt DateTime @default(now())
  findings TaskAuditFinding[]
  @@index([taskId])
}
model TaskAuditFinding {
  id String @id @default(uuid())
  auditId String
  audit TaskInstallationAudit @relation(fields:[auditId], references:[id], onDelete: Cascade)
  severity String   // ok|warning|critical
  category String   // señal|conexión|fotos|instalación|otros
  text String
  photoUrls String[]
  createdAt DateTime @default(now())
  @@index([auditId])
}
```

**Dominio**: entidades `InstallationAudit`/`AuditFinding`/`AuditContext`/`AuditResult` + enums `AUDIT_SEVERITIES`/`AUDIT_CATEGORIES`. Ports `InstallationAuditor.audit(ctx): AuditResult` (NO throw, soft-fail `{ok:false}`) y `TaskAuditRepository.replaceForTask(...)` / `listFindingsByTask(...)`.

**`AuditContext` (enriquecido — incluye lo del DETALLE DE LA TAREA, pedido del usuario):**
- Del cierre IClass: `osCodigo`, `technicianName`, `resultCodeName`, `checklistText[]` (Q/A no-foto), `technicianNote`, `materials[]`, `photoUrls[]` (TODAS las fotos).
- **Del detalle de la tarea local**: `taskTitle`, `taskDescription` (el problema reportado), `taskComments[]` (comentarios humanos). Así el auditor compara lo PEDIDO vs lo HECHO.

**Assembler** `buildAuditContext(order, task, comments)` (puro). El orquestador trae la task (ya la tiene) + los comentarios (inyectar `TaskCommentRepository` de lectura en el wiring del audit).

**Use-case** `AuditInstallationQuality`: llama al auditor; si `ok=false` → no persiste (preserva auditoría previa buena). Si `findings` vacío → 1 finding sintético `{ok, otros, "Instalación sin observaciones."}` (R4). `replaceForTask`.

**Adapter** `OllamaInstallationAuditor` (multimodal): `POST /api/generate` con `images:[...todas las fotos b64]` + prompt (español, pide array JSON `{severity,category,text}`), `format:'json'`, temp 0, timeout 180s. Parser puro `parseAuditResult` (valida enums, descarta items inválidos, soft-fail). Flag `ICLASS_AUDIT_ENABLED`, `AUDIT_MODEL=qwen2.5vl:7b`, en `config.audit` (opt-in, no fail-fast).

**Wiring**: `IngestClosedOptions.auditInstallation?`; en `orchestrateClosure` DESPUÉS de `postComment`, non-fatal. `buildClosureSideEffects`: si `config.audit.enabled`, arma el use-case con el adapter + `PrismaTaskAuditRepository` + `PrismaTaskCommentRepository` (para los comentarios del contexto).

**Ruta** `GET /api/scheduling/:taskId/audit-findings` con `auth` + `requirePerm('scheduling','read')` (montar ANTES del catch-all `/:id`). DTO `AuditFindingDto`. RBAC: reusa `scheduling.read` (existe, sin migración).

**FE**: `TaskAuditFeed` (clon de `TaskCommentsTimeline` SIN Composer; `AuditFindingItem` = badge severidad + chip categoría + texto + thumbnails con Lightbox). Tab "Auditoría IA" en `TaskTabs` (bajo `Can permission="scheduling.read"`). `useTaskAuditFindings` + `taskAuditFindings.api`. `StatusBadge` + variantes `ok/warning/critical` + tokens `--badge-ok/warning/critical-*`. Tres estados: sin auditoría / con observaciones / todo OK.

**TDD**: `parseAuditResult` (puro), `AuditInstallationQuality` (in-memory auditor+repo: soft-fail no persiste, replace, finding OK sintético), `buildAuditContext` (puro, incluye task detail), orquestación non-fatal, ruta (supertest 401/403/200), FE vitest (feed, badge, tab gating).

## F0 — Cierre del agujero de auth de comentarios (BE)

`taskComments.routes.ts`: las 3 rutas SIN auth ni guard. `createTaskCommentsRouter` recibe ahora `auth: RequestHandler` + `perms {read,write,delete}` (= `requirePerm('scheduling', read/write/delete)`), aplicados por ruta (espejo de `contractInventory.routes.ts`). Wiring en `app.ts:~959`. RBAC: `scheduling.read/write/delete` YA existen (seed `auth_rbac_foundation`) → sin migración. **Verificado**: el comentario "Sistema IClass" se postea server-side (`PostClosureComment` → repo directo, NO vía HTTP) → agregar auth NO rompe el closure loop. TDD: nuevo `taskComments.routes.auth.test.ts` (SC-01..09, stubs AUTH_PASS/FAIL + PERM_PASS/DENY) + actualizar el test existente para pasar los stubs.

---

## Orden de apply (agent team paraleliza)
F1 (independiente) · F0 (base seguridad) · [shared: DeviceType→domain + migración unit/qwen] → F2 ∥ F3 · F4-BE → F5-BE-override → F5-FE · F6 (independiente, la más grande).

## Manifiesto de archivos
Ver `spec.md` y los drafts en engram (`sdd/closure-inventory-intelligence/spec`, `.../design`) para el listado exacto create/modify por feature (≈ 25 BE + 14 FE).
