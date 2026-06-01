# Tasks: iclass-closure-to-inventory

> Strict TDD: red → green → refactor. Use cases con adapters in-memory, NUNCA mockear Prisma.
> Migraciones: generar SQL sin DB local (`prisma migrate diff --from-schema HEAD:schema --to-schema schema --script`), aditivas → push directo. `git add` por path explícito. El push lo decide el usuario.

## Phase 0 — Baseline
- [x] 0.1 Baseline (2026-06-01): `npm test` → 225 passed / 6 skipped suites · 1694 passed / 86 skipped tests ✅. `npx tsc --noEmit` → 0 errors ✅.

---

## Phase 1 — Schema (aditivo)
- [x] 1.1 `IClassSoChecklistAnswer` → `+ photoUrl String? @db.Text`.
- [x] 1.2 Nuevos modelos: `OcrExtraction`, `TaskInventorySuggestion`, `ServiceInstalledItem`. Back-relations `Service.installedItems`, `ScheduledTask.inventorySuggestions`. `prisma validate` ✅.
- [x] 1.3 Migración aditiva generada (diff sin DB local): `prisma/migrations/20260601120000_iclass_closure_to_inventory/migration.sql` (ADD COLUMN + 3 CREATE TABLE + índices + 2 FK CASCADE). `prisma generate` ✅.
- [ ] 1.4 Commit: `feat(schema): photoUrl + OcrExtraction, TaskInventorySuggestion, ServiceInstalledItem`

---

## Phase 2 — SEAM scraper (TDD parser sobre fixtures HTML)
> Verificado (24 OS / 10 tipos): el GET inicial trae TODO el HTML (NO AJAX) → scraper = GET + parser (cheerio/jsdom), sin browser headless. Tres kinds: text/choice/photo. `div.prop` se usa en todo el form → **scopear al panel Encuesta**.
- [x] 2.0 4 fixtures sanitizados (PII-free, URLs S3 fakeadas, JSON-decodificados) en `src/__tests__/infrastructure/fixtures/iclass-seam/`: 3532-wireless (text+4 fotos), 2980-fibra/Red (photo-missing×N), vt-choice (choice), 4646-empty (sin encuesta).
- [x] 2.1 Port `IClassPortalPort` + entity `iclass-portal.ts` (ScrapedOSDetail/Question/Attachment).
- [x] 2.2 [RED→GREEN] `parseSeamOSDetail` + test (9 casos) → SCEN-SC-1..5. Scope por `perguntaDecoration{ordem}` (= ordem de la API). 3 kinds: text/choice/photo + photoMissing. cheerio. **9/9 verde, suite 1703 passed, tsc 0.**
- [x] 2.4 `InMemoryIClassPortal` para tests de use case.
- [x] 2.5 Config: `ICLASS_PORTAL_BASE_URL/USER/PASSWORD` en `config.ts` + `env.example` (opt-in, sin fail-fast). Secrets prod vía `gh secret set`.
- [ ] 2.3 [PENDIENTE] `IClassPortalClient` (adapter de red): login JSF/cookie + GET read-only + `parseSeamOSDetail`. Backoff/re-login. Requiere confirmar nombres de campos del form de login contra el portal real (integración).
- [ ] 2.6 Commit parser core hecho; commit del client de red al cerrar 2.3.

---

## Phase 3 — Correlación foto↔ordem
- [ ] 3.1 [RED] Test: dado checklist API (con `ordem`) + `ScrapedOSDetail`, setea `photoUrl` por `ordem` → SCEN-CO-1/3.
- [ ] 3.2 [GREEN] Implementar correlación en el ensamblado del agregado (extender el paso de checklists de `IngestClosedServiceOrders`).
- [ ] 3.3 `ClosedServiceOrderRepository.upsert` persiste `photoUrl` en las answers.
- [ ] 3.4 Commit: `feat(iclass): correlate checklist photos by ordem`

---

## Phase 4 — Auto-comment legible (TDD)
- [ ] 4.1 [RED] Test `PostClosureComment` (in-memory `TaskCommentRepository`) → SCEN-PC-1/2/3 (incl. idempotencia).
- [ ] 4.2 [GREEN] Use case: arma body legible (Q&A texto + motivo + técnico) + attachments por URL. Guard idempotente por OS + autor "Sistema IClass".
- [ ] 4.3 Commit: `feat(iclass): auto-comment legible en la task al cerrar OS`

---

## Phase 5 — OCR pipeline (TDD)
- [ ] 5.1 Port `DevicePhotoOcr` + `OcrExtractionRepository`.
- [ ] 5.2 [RED] Test `ExtractDeviceInfoFromPhoto` con `InMemoryDevicePhotoOcr` (stub) → SCEN-OCR-1/2; persiste `OcrExtraction`.
- [ ] 5.3 [GREEN] Use case + `OllamaDevicePhotoOcr` (preprocess Pillow/sharp-equivalente + gemma3:12b, prompt JSON estricto). Preprocesamiento aislado y testeable.
- [ ] 5.4 Commit: `feat(iclass): OCR de SN/MAC (Ollama gemma3) con preprocesamiento`

---

## Phase 6 — Build suggestions (TDD)
- [ ] 6.1 Port `InventorySuggestionRepository` + in-memory.
- [ ] 6.2 [RED] Test `BuildInventorySuggestions` → SCEN-BS-1/2/3 (DEVICE de OCR, MATERIAL de IClassSoMaterial, idempotencia, no toca contrato).
- [ ] 6.3 [GREEN] Use case + Capa 2 (keyword matching deviceType, soft-fail OTROS).
- [ ] 6.4 Commit: `feat(inventory): build task inventory suggestions (staging)`

---

## Phase 7 — Service inventory + confirmación (TDD)
- [ ] 7.1 Port `ServiceInventoryRepository` + in-memory + Prisma.
- [ ] 7.2 [RED] Tests `ConfirmInventorySuggestion`, `AddInstalledItemManually`, `DiscardInventorySuggestion`, `ListServiceInstalledItems` → SCEN-CF-1/2/3/4, SCEN-MI-1.
- [ ] 7.3 [GREEN] Use cases. Confirmar → crea `ServiceInstalledItem` (una fila por equipo) vía `task.serviceId`.
- [ ] 7.4 Commit: `feat(inventory): confirm suggestion → ServiceInstalledItem + manual add`

---

## Phase 8 — Routes + wire (TDD supertest)
- [ ] 8.1 [RED] Supertest de los endpoints (ver spec service-inventory) con repos in-memory.
- [ ] 8.2 [GREEN] Montar routers (sub-recursos ANTES del catch-all `/:id`). Proteger con permisos que el front realmente recibe (formato `modulo.accion`, ej. `scheduling.read`/`inventory.write`) — verificar en `useMyPermissions`/catálogo `/me` antes de usar.
- [ ] 8.3 Wire en `app.ts` (DI). Coordinar si hay agente tocando `app.ts`.
- [ ] 8.4 Commit: `feat(http): rutas de inventario por servicio + sugerencias`

---

## Phase 9 — Orquestación
- [ ] 9.1 [RED] Test de integración: `IngestClosedServiceOrders` dispara comment + suggestions tras `upsert` (con stubs de scraper/OCR).
- [ ] 9.2 [GREEN] Hook posterior a `closed.upsert` en `processSummary` (o un orquestador dedicado) que encadena [A]→[D]→[B]→[C]. Tolerante a fallos del SEAM/OCR (no rompe el mirror).
- [ ] 9.3 Commit: `feat(iclass): orquestar comment + OCR + suggestions en el closure loop`

---

## Pendiente de decisión (no bloquea Phase 1–4)
- Localización de etiqueta en OCR (Phase 5): VLM 2 pasos vs PaddleOCR — iterar con fotos reales.
- Host de Ollama en prod (sin GPU): CPU en cron de fondo vs servicio aparte.

## Coordinación
- **Frontend** (`ipnext-frontend`): change aparte — sección "Inventario" en task detail (checkboxes de sugerencias) + "Equipos instalados" en contrato/cliente, diseño `impeccable`. Consume los endpoints de Phase 8.
