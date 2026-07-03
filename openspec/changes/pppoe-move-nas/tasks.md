# Tasks: Mover PPPoE de NAS (radius-aware) — manual + automático

> TDD estricto (red → green → refactor). Worktrees dedicados. Review adversarial por wave. Push con OK del usuario.

## Wave 1 — Move manual radius-aware (BE + FE)

### 1. BE — core `MovePppoeToNas` (worktree `feat/pppoe-move-nas-be`)

- [ ] 1.1 Tests RED de `MovePppoeToNas` (in-memory + fake gateway): S1.1–S1.4, S2.1–S2.2, S3.1–S3.3, S8.1.
- [ ] 1.2 Use case `MovePppoeToNas` (application): guards + FindFreeIp('cgnat') + changeFramedIp + upsert + disconnect best-effort + evento historial. Error tipado `PppoeMoveMixedNasTypesError`.
- [ ] 1.2b Migración ADITIVA `PppoeNasMoveEvent` (generada con `prisma migrate diff`, timestamp posterior a la última migración) + port `PppoeNasMoveEventRepository` + adapters Prisma/InMemory + registro del outcome en `MovePppoeToNas` (`moved`/`failed_no_free_ip`/`failed_orchestrator`).
- [ ] 1.2c Use case `ListPppoeNasMoveEvents` + ruta `GET /api/pppoe/nas-move-events` (gate `pppoe.read`, paginado, filtros outcome/trigger/username; montada ANTES del catch-all `/:id`) + tests de ruta (wire contract campo por campo del design D6).
- [ ] 1.3 Rama legacy: delegación al flujo actual para NAS no-radius (S3.2), sin tocar `MovePppoeServiceToRouter` (queda como colaborador o se absorbe — decidir en apply, lo que menos superficie toque).
- [ ] 1.4 Ruta `POST /pppoe/:id/move` cablea el nuevo use case (mismo contrato de body; errores: 404 service/nas, 409 pool lleno `NO_FREE_IP`, 409 mixto, 502 orchestrator). Tests de ruta.
- [ ] 1.5 Wiring en `app.ts` (composition root) + test estático de wiring (lección W6: sin wiring = feature muerta).
- [ ] 1.6 Gate: suite completa + `tsc --noEmit` + `prisma generate` pre-hook. Corrido por el orquestador.

### 2. FE — modal Mover honesto (worktree `feat/pppoe-move-nas-fe`)

- [ ] 2.1 ui-ux-pro-max (`search.py --design-system`) ANTES de tocar UI.
- [ ] 2.2 Tests RED del modal: S9.1–S9.3 (aviso IP nueva + desconexión; warning IP pública; refresco del row).
- [ ] 2.3 Modal "Mover NAS": copy de aviso, warning si IP actual ∈ pool público (dato ya disponible o derivable del DTO), invalidación de query post-move para reflejar NAS/IP nuevos.
- [ ] 2.3b Tab "Movimientos NAS" en la page de auditoría (`/admin/networking/audit`): tabla paginada + badge por outcome + filtros; hook `usePppoeNasMoveEvents`; wire contract del design D6 campo por campo.
- [ ] 2.4 Gate FE: Vitest bajo `TZ=UTC` + tsc.

### 1bis. Fix wave 1 (post-review adversarial, 2026-07-01)

- [ ] 1.7 Aplicar los 8 ajustes de design "Ajustes post-review (fix wave 1)" con TDD (S1.5–S1.8 + S2.1 endurecido + REQ-LOG-1 ampliado). Re-review focalizada después.

### 3. Cierre W1

- [ ] 3.1 Review adversarial (≥1 revisor; focos: consistencia RADIUS↔DB en fallos parciales + contrato BE↔FE campo por campo).
- [ ] 3.2 Fix wave + re-review hasta CLEAN.
- [ ] 3.3 `sdd-verify` (matriz spec REQ-MOVE-*/REQ-FE-1 → test verde).
- [ ] 3.4 Push BE→FE con OK del usuario + `gh run watch` verdes + verificación Playwright en vivo (mover un PPPoE de PRUEBA entre 2 NAS reales, confirmar IP nueva + reconexión + limpiar).
- [ ] 3.5 Sync `main` local == origin (ambos repos) + card BACKLOG → estado.

## Wave 2 — Auto-move (BE)

### 4. BE — watcher (worktree `feat/pppoe-automove-be`)

- [ ] 4.1 Tests RED de `AutoMovePppoe` (detección): S4.1–S4.3, S5.1–S5.3, S6.1.
- [ ] 4.2 Use case `AutoMovePppoe`: listAllSessions → map nasIpAddress→NasServer → batch services → mismatches → clasificación CGNAT/public por IpPool → move por ítem con aislamiento de fallos → resumen `{moved, skippedPublic, skippedUnknown, failed}`.
- [ ] 4.3 Scheduler en `app.ts` patrón `radius-auth-ingest`: gate por feature flag `pppoe-auto-move` (FeatureFlag DB, chequeado en CADA tick; seed OFF vía migración idempotente si el catálogo lo requiere) + `AUTO_MOVE_INTERVAL_MS` (default 120000 = 2 min, parseIntervalMs piso 15s/techo 24h) + lock advisory + log estructurado por tick + registro `PppoeNasMoveEvent` de cada outcome. Tests S7.1–S7.3.
- [ ] 4.4 `deploy.yml`: forward de `AUTO_MOVE_INTERVAL_MS` + `gh secret set` (el ON/OFF va por FeatureFlag UI, NO por env).
- [ ] 4.4b Verificar que el flag `pppoe-auto-move` aparece y se togglea en la page de flags de Config (FE: cero código esperado; si el catálogo FE es hardcodeado, agregarlo con su gate).
- [ ] 4.5 Gate + review adversarial (focos: watcher vs move manual concurrente, sesiones stale, NAS desconocido) + fix waves hasta CLEAN + `sdd-verify`.
- [ ] 4.6 Push con OK + deploy verde + **go-live gradual**: activar flag en prod, monitorear logs del primer tick con mismatches reales, validar con un caso de PRUEBA (mover una antena de nodo o simular con un secret de prueba).
- [ ] 4.7 Sync main local + card BACKLOG → ✅.

## Fuera de scope (registrado)

- Alerta Telegram de `auto-move skipped: public` y de pool lleno → Ola 3 (el log estructurado ya deja el hook).
- RDA1/RDA2 fibra local (no están en el HA).
- Catálogo/UI de pools (ya cargados; CRUD existente).
