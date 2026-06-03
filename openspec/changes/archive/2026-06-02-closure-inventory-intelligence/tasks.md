# Tasks — closure-inventory-intelligence

> TDD estricto: el test va PRIMERO (red → green → refactor). `[BE]` ipnext-backend · `[FE]` ipnext-frontend. Commits por feature, por pathspec; push = prod (lo confirma el usuario).

## Fase 0 — Prerrequisitos compartidos `[BE]`
- [ ] 0.1 Crear `src/domain/entities/device-type.ts` con `type DeviceType` + `VALID_DEVICE_TYPES`. Re-exportar desde `classifyDeviceType.ts`. Actualizar imports.
- [ ] 0.2 Migración aditiva `closure_inventory_intelligence`: `OcrExtraction.qwenDeviceType String?`, `TaskInventorySuggestion.qwenDeviceType String?` + `unit String?`, tablas `TaskInstallationAudit` + `TaskAuditFinding` (ver design). Generar con `migrate diff` (sin DB local), revisar SQL.

## F1 — Técnico en el comentario `[BE]`
- [ ] 1.1 (test) `PostClosureComment.test.ts`: 6 escenarios de `buildBody` (field-tech, ambos distintos→"Cerró", iguales→sin "Cerró", solo operador, ninguno, idempotencia). RED.
- [ ] 1.2 Exportar `buildBody` puro; invertir a `teamTechnicianName ?? closedByName` + línea "Cerró:" si difieren. GREEN.

## F0 — Auth de rutas de comentarios `[BE]`
- [ ] 0a.1 (test) `taskComments.routes.auth.test.ts`: SC-01..09 (401 sin auth, 403 sin perm, 200/201/204 con perm) con stubs AUTH/PERM. RED.
- [ ] 0a.2 `createTaskCommentsRouter`: agregar `auth` + `perms{read,write,delete}` (export `TaskCommentRoutePerms`), aplicar por ruta.
- [ ] 0a.3 Wiring en `app.ts:~959` (`createAuthMiddleware` + `requirePerm('scheduling', read/write/delete)`).
- [ ] 0a.4 Actualizar `taskComments.routes.test.ts` existente para pasar stubs AUTH_PASS/PERM_PASS. GREEN.

## F2 — Tipo por imagen `[BE]`
- [ ] 2.1 (test) `normalizeQwenDeviceType.test.ts` (8 casos: enum exacto, lowercase, trim, desconocido→null, empty→null, null/undefined→null). RED.
- [ ] 2.2 `application/services/normalizeQwenDeviceType.ts` (puro). GREEN.
- [ ] 2.3 Port `DeviceOcrResult.deviceType?`; `OllamaDevicePhotoOcr.PROMPT` pide `device_type`; `finalizeOcrResult` pasa `parsed.device_type` (+ test finalize).
- [ ] 2.4 Entidades `OcrExtraction` + `TaskInventorySuggestion`: + `qwenDeviceType: string|null`. Mapear en los Prisma repos.
- [ ] 2.5 (test+impl) `ExtractDeviceInfoFromPhoto`: mapear `normalizeQwenDeviceType(result.deviceType)` → `qwenDeviceType`. `BuildInventorySuggestions`: propagar.

## F3 — Ítems desde texto `[BE]`
- [ ] 3.1 Entidad `ChecklistMaterialProposal` + port `ChecklistTextExtractor` + `InMemoryChecklistTextExtractor`.
- [ ] 3.2 (test) `ExtractItemsFromChecklistText.test.ts` (in-memory: vacío→[], proposals→sugerencias MATERIAL/CHECKLIST_TEXT, idempotencia, throw propaga). RED.
- [ ] 3.3 Use-case `ExtractItemsFromChecklistText`. GREEN.
- [ ] 3.4 (test) `OllamaChecklistTextExtractor` parser puro (JSON válido, markdown-wrapped, no-JSON→[], no-array→[]). + adapter.
- [ ] 3.5 Wiring en `orchestrateClosure` (junta answers `Texto`, llama use-case non-fatal) + test de orquestación.

## F4 — Trazabilidad del aprobador `[BE+FE]`
- [ ] 4.1 (test) `ConfirmInventorySuggestion` + `ListContractInstalledItems`: resuelven `addedByUserName` vía `RbacUserRepository` (in-memory); null si sin user. RED.
- [ ] 4.2 DTO `InstalledItemDto` + `toInstalledItemDto`; inyectar `RbacUserRepository` en ambos use-cases; devolver DTO. Wiring en `app.ts`. GREEN.
- [ ] 4.3 `[FE]` tipo `ServiceInstalledItem` + `addedByUserName`. (depende de F5 para el render).

## F5 — Rediseño inventario + override `[BE+FE]`
- [ ] 5.1 (test) `contractInventory.routes.test.ts`: confirm con `type` válido→201 tipo guardado; sin type→default; inválido→422. + `ConfirmInventorySuggestion` `typeOverride`. RED.
- [ ] 5.2 `ConfirmInventorySuggestionInput.typeOverride`; `type: toType(typeOverride ?? suggestion.deviceType)`; validación en la ruta (422). GREEN.
- [ ] 5.3 `[FE]` `confirmInventorySuggestion(taskId,id,typeOverride?)` + `useConfirmSuggestion({suggestionId,type})`.
- [ ] 5.4 `[FE]` (test vitest) `SuggestionCard` (~12 casos: foto, MAC/SN, select default, badge qwen si difiere/oculto si igual, confirm con tipo elegido/default, botones ocultos sin perm, discard). RED.
- [ ] 5.5 `[FE]` `SuggestionCard.tsx` + `.module.css`; reescribir `TaskInventorySuggestions.tsx` (CSS Modules, `canWrite` una vez). GREEN.
- [ ] 5.6 `[FE]` `ServiceInventorySection` CSS Module + columna "Aprobado por" (cierra F4 render) + tests.

## F6 — Auditoría IA `[BE+FE]`
**BE:**
- [ ] 6.1 Entidades `installation-audit.ts` (enums, AuditFinding, InstallationAudit, AuditContext con taskTitle/taskDescription/taskComments, AuditResult) + ports `InstallationAuditor` + `TaskAuditRepository`.
- [ ] 6.2 (test) `parseAuditResult.test.ts` (puro: array válido, vacío→ok, prose→{ok:false}, items inválidos descartados, no-array→{ok:false}). RED → impl.
- [ ] 6.3 (test) `buildAuditContext.test.ts` (puro: mapea checklist no-foto, todas las fotos, materiales, technicianNote, **task title/description/comments**). RED → impl.
- [ ] 6.4 (test) `AuditInstallationQuality.test.ts` (in-memory auditor+repo: ok=false no persiste y preserva previa; findings→persiste; vacío→1 finding ok; re-run reemplaza). RED → impl.
- [ ] 6.5 Adapter `OllamaInstallationAuditor` (multimodal `images[]` + prompt español JSON, timeout, soft-fail). `InMemoryTaskAuditRepository` + `PrismaTaskAuditRepository`.
- [ ] 6.6 `config.audit` (flag `ICLASS_AUDIT_ENABLED`, `AUDIT_MODEL`, timeout) + `env.example`.
- [ ] 6.7 Wiring: `IngestClosedOptions.auditInstallation?`; `orchestrateClosure` después de `postComment` non-fatal (trae task + comentarios para el contexto); `buildClosureSideEffects` (+ `PrismaTaskCommentRepository` para los comentarios). + test orquestación non-fatal.
- [ ] 6.8 Use-case `ListTaskAuditFindings` + DTO + ruta `GET /scheduling/:taskId/audit-findings` (auth + `requirePerm('scheduling','read')`, montar antes del catch-all) + wiring `app.ts`. (test supertest 401/403/200).

**FE:**
- [ ] 6.9 `types/taskAudit.ts` + `api/taskAuditFindings.api.ts` + `hooks/useTaskAuditFindings.ts`.
- [ ] 6.10 `StatusBadge` variantes `ok/warning/critical` + tokens `--badge-ok/warning/critical-*` (+ test).
- [ ] 6.11 (test vitest) `TaskAuditFeed` (loading, sin auditoría, finding ok verde, warning/critical badge+chip+texto, thumbnails+Lightbox). RED.
- [ ] 6.12 `TaskAuditFeed.tsx` + `.module.css` (clon de TaskCommentsTimeline sin Composer, `AuditFindingItem`). GREEN.
- [ ] 6.13 Tab "Auditoría IA" en `TaskTabs` bajo `Can permission="scheduling.read"`.

## Cierre
- [ ] V.1 Suite completa verde (BE jest, FE vitest) + `tsc --noEmit`.
- [ ] V.2 Verificación en prod por feature (re-test del closure sobre una OS real; OCR/audit con flags). Push coordinado BE+FE, confirmado por el usuario.
- [ ] V.3 `sdd-verify` + `sdd-archive`.
