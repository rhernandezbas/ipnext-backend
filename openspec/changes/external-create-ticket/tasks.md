# Tasks — external-create-ticket

Estado: IMPLEMENTADO + VERIFICADO local (gate verde, review 0 crit/high). Pendiente: push a prod.

## T1 — Desacople del reporter "api" de GR
- [x] `bootstrapSystemUsers.ts` (NEW) — wrapper composition-root sobre `bootstrapApiUser` (repo + hash inyectados)
- [x] Test unit `bootstrapSystemUsers.test.ts` — creación + idempotencia (BOOT-1)
- [x] `main.ts` — `await bootstrapSystemUsers(...)` incondicional, ANTES de `createApp`
- [x] `bootstrapGestionRealIngest.ts` — remover el bootstrap del api user (mantener `rbacUsers` para el ingest; limpiar imports huérfanos)
- [x] Composition-root test — incondicionalidad + orden + GR ya no siembra (BOOT-1)

## T2 — Endpoint POST /tickets
- [x] Test de ruta `externalV1.tickets.routes.test.ts` (RED primero) — 401/201/DTO/422×4/400×N/503 (SEAM completo: `CreateTicket` real + repos in-memory)
- [x] `ExternalTicketDto` + `toExternalTicketDto` (allow-list, CT-1)
- [x] `ExternalV1TicketDeps` + 4º param opcional en `createExternalV1Router`
- [x] Handler `POST /tickets` — validación (CT-2), área por nombre + reporter por login + `CreateTicket` (CT-1/CT-3/CT-5), mapeo de errores → 422/400/503

## T3 — Wiring + rate-limiter
- [x] `createExternalWriteRateLimiter` (por IP, dedicado al POST) en `rateLimiters.ts`
- [x] `rateLimiter?` en `ExternalV1TicketDeps`, aplicado solo al POST (spread condicional)
- [x] Wiring en `app.ts` — `{ createTicket, rbacUserRepo, ticketAreaRepo, rateLimiter }` (instancias existentes)
- [x] Composition-root test del wiring (WIRING-1, anti-W6)

## T4 — Verify + review
- [x] Gate del orquestador: `tsc --noEmit` limpio + suite completa 7523 verde
- [x] Review adversarial 3 focos (seguridad / contrato / wiring) — 0 CRITICAL, 0 HIGH
- [x] Fix wave TDD: cap de longitud (MEDIUM), cobertura del 503, pin de incondicionalidad
- [x] Re-verify: gate final verde tras el fix wave

## T5 — Deploy
- [x] Commit conventional en `feat/external-create-ticket-be` (sin migración, sin secrets nuevos)
- [ ] Push a `origin/main` (confirmado por el usuario) → deploy → `gh run` verde
- [ ] Sincronizar `main` local con `origin/main`
- [ ] Card BACKLOG → EN PROD + cleanup del worktree
