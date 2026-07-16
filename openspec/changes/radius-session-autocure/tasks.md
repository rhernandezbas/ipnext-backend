# Tasks: Auto-curación de sesiones RADIUS colgadas + log auditable

> TDD estricto (red → green → refactor). Orden: **ORCH-1 → BE-1 → FE-1** (BE-1 tolera deploy fuera de orden por fail-closed, pero el orden nominal evita ticks de `skipped_no_signal`). Worktrees dedicados. Review adversarial por change. Push con OK del usuario. El flag `radius-auto-cure` nace DARK y se prende SOLO en el go-live (4.x).
>
> **Enmienda fast-path 5 min (2026-07-16)** incorporada: cura principal por persistencia de rejects ≥5 min (new-wins), cure-throttle 30 min + `flagged_flapping` ≥3/24 h, `signalUsed` en la tabla. ORCH-1 NO cambió (el endpoint cure es agnóstico de la política).

## Change ORCH-1 — orchestrator: cure endpoint + last_update + cron versionado (repo `freeradius-orchestrator`)

### 0. Pre-flight (bloqueante del write a radacct)

- [ ] 0.1 **Verificar topología de replicación MariaDB** en r1/r2: `SHOW SLAVE STATUS` / `SHOW REPLICA STATUS` (wsrep ya medido OFF el 2026-07-16). Documentar el resultado en el PR. Si hay replicación clásica activa, confirmar que el write via VIP replica igual que los writes existentes a radcheck/radreply (mismo write-path). Sin este check NO se mergea el UPDATE.

### 1. `last_update` + cure endpoint (TDD)

- [ ] 1.1 Tests RED de `SessionResponse.last_update`: S1.1–S1.3 (incluye contract test del shape completo).
- [ ] 1.2 GREEN: campo `last_update` + serializer `db_naive_to_utc_z` + línea en `from_domain` (`schemas/session.py`).
- [ ] 1.3 Tests RED del cierre contable: S2.1–S2.4, S2.7 (idempotencia con UPDATE condicionado, no check-then-act) sobre `SqlAlchemySessionRepository.close_stale` + `SessionControlService.cure_session`.
- [ ] 1.4 GREEN: método `close_stale` en el port outbound `SessionRepository` + implementación SQLAlchemy (UPDATE con `WHERE acctstoptime IS NULL`, `COALESCE(acctupdatetime, NOW())`, `acctsessiontime` recalculado, `acctterminatecause='Admin-Reset'`) + `cure_session` en `SessionControlService` (CoA best-effort FUERA de la tx, molde `disconnect_all`).
- [ ] 1.5 Tests RED + GREEN del CoA best-effort (S2.5) y del domain event `SessionCured` (S3.1–S3.2, molde `SessionDisconnected`).
- [ ] 1.6 Router: `POST /{session_id}/cure` en `sessions.py` + `CureSessionCommand` inbound + schema de respuesta (`cured`, `already_closed`, `closed_at`, `coa` — snake_case, ver REQ-CURE-3) + test de ruta (S2.6 token).

### 2. Cron versionado + cierre ORCH-1

- [ ] 2.1 `deploy/cron.d/radius-cleanup`: copia verbatim del cron vivo en r1 (S4.1 — diff manual contra la VM en el apply) + header con evidencia del umbral y rol de safety net (S4.2) + nota de instalación en el script de deploy que corresponda.
- [ ] 2.2 Gate: suite completa + linters del repo (ruff/mypy según pyproject).
- [ ] 2.3 Review adversarial (focos: idempotencia concurrente del UPDATE, CoA fuera de tx, TZ del `NOW()` vs naive-AR de la DB — el repo ya tiene `infrastructure/tz.py`, usarlo) + fix wave hasta CLEAN.
- [ ] 2.4 `sdd-verify` ORCH-1 (matriz REQ-ORCH-* → test verde).
- [ ] 2.5 Push/deploy del orchestrator con OK del usuario + smoke en vivo: curar UNA sesión colgada real (o de prueba) vía curl y verificar fila cerrada + `Admin-Reset` + no rompe `GET /sessions`.

## Change BE-1 — watcher + tabla + endpoints (este repo, worktree `feat/radius-autocure`)

### 3. Core + persistencia (TDD)

- [ ] 3.1 Tests RED del gateway: `OrchestratorSession.lastUpdate` aditivo + `cureSession` (S3.1–S3.4 de REQ-CURE-3, incl. `encodeURIComponent` y fake con semántica `alreadyClosed`).
- [ ] 3.2 GREEN: port + `HttpRadiusOrchestratorGateway` + fakes/in-memory actualizados (aditivo — cero firmas rotas).
- [ ] 3.3 Migración ADITIVA `RadiusSessionCureEvent` (via `npm run prisma:migrate`, jamás SQL a mano) + port `RadiusSessionCureEventRepository` + adapters `Prisma*`/`InMemory*` (naming convention del repo).
- [ ] 3.4 Tests RED del core `CureStuckSession`: gates fail-closed + DOS caminos de cura (fast path por persistencia / stale interim) S2.1–S2.10 (REQ-CURE-2, enmienda) + outcomes/registro con `signalUsed` (REQ-CURE-3, REQ-CURE-5 S5.1–S5.2) con in-memory + fake gateway.
- [ ] 3.5 GREEN: `CureStuckSession` (gates + fast path new-wins + camino stale + cura + fila con signalUsed; parámetros trigger/actor/force y agregado `{firstReject, lastReject}`).
- [ ] 3.6 Tests RED del watcher `AutoCureStuckSessions`: detección + agregado por username S1.1–S1.4 (REQ-CURE-1) + breaker/cap/cure-throttle 30 min/flapping flag/throttle S4.1–S4.8 (REQ-CURE-4, enmienda).
- [ ] 3.7 GREEN: `AutoCureStuckSessions` (lookback → agregado `{firstReject, lastReject}` por username → breaker → cap → cure-throttle 30 min → flapping flag (≥3 curas/24 h → `flagged_flapping`) → core por ítem con aislamiento de fallos → summary con TODOS los counters).
- [ ] 3.8 Config: bloque `radiusAutoCure` en `config.ts` (`parseIntervalMs`/`parsePositiveInt`; piso duro 20 min en `STALE_MS` — S2.7; pisos de `PERSISTENCE_MS`/`RECENCY_MS`; clamp de coherencia `LOOKBACK > PERSISTENCE + RECENCY` — S7.4) + `env.example` (S7.3, incluye `_PERSISTENCE_MS`, `_REJECT_RECENCY_MS`, `_FLAPPING_MAX` y el nuevo default 30 min de `_COOLDOWN_MS`).

### 4. Scheduler + rutas + wiring (TDD)

- [ ] 4.1 `RadiusAutoCureScheduler` + `bootstrapRadiusAutoCure` (clon de `PppoeAutoMoveScheduler`/`bootstrapPppoeAutoMove`: inFlight + lock `radius-auto-cure` + flag por tick + catch del tick + unref) + tests S4.4, S7.1–S7.2 + start desde `main.ts`.
- [ ] 4.2 Seed del feature flag `radius-auto-cure` OFF (migración idempotente `ON CONFLICT DO NOTHING`, patrón del seed de `pppoe-auto-move`).
- [ ] 4.3 Use case `ListRadiusSessionCures` (paginado, filtros, `countsByOutcome` — molde `ListRadiusAuthFailures`) + ruta `GET /api/radius/session-cures` (gate `network.read`, validación defensiva) + tests de ruta S5.3–S5.5 (wire contract campo por campo).
- [ ] 4.4 Ruta manual `POST /api/radius/session-cures` (gate `network.manage`, force, SIEMPRE registra, sin cure-throttle/flapping para el operador, errores via `next(err)`) + tests S6.1–S6.6.
- [ ] 4.5 Wiring en `app.ts` + composition test (S7.2 — sin wiring = feature muerta) + `deploy.yml`: forward de las envs nuevas (`gh secret set` solo si se necesita override; el ON/OFF va por FeatureFlag UI, NO por env).
- [ ] 4.6 Gate: suite completa + `tsc --noEmit`.
- [ ] 4.7 Review adversarial (focos: carrera watcher-vs-cron y watcher-vs-manual sobre la misma sesión; fast path new-wins — que el ping-pong de credencial compartida NO degenere en kick-loop (cure-throttle 30 min + flapping flag deben cortarlo); gate alive con múltiples sesiones mixtas fresca+stale y persistencia a medio cumplir; interacción cure-throttle vs flapping vs throttle de registro; fail-open del throttle) + fix waves hasta CLEAN.
- [ ] 4.8 `sdd-verify` BE-1 (matriz REQ-CURE-* → test verde).
- [ ] 4.9 Push con OK del usuario + deploy verde. El flag QUEDA OFF.

## Change FE-1 — UI (repo FE, worktree dedicado)

### 5. Tab + botón manual

- [ ] 5.1 ui-ux-pro-max ANTES de tocar UI (patrón del repo).
- [ ] 5.2 Tests RED del tab "Sesiones curadas": S1.1–S1.4 (chips countsByOutcome, badges con degradación a texto plano, guard de permisos, wire contract campo por campo).
- [ ] 5.3 GREEN: tab en la page de auditoría RADIUS + hook `useRadiusSessionCures` + filtros.
- [ ] 5.4 Tests RED + GREEN del botón "Curar sesión colgada" en filas `session_stuck` de Errores de auth: S2.1–S2.5 (doble confirm, force NUNCA automático, gate `network.manage`, refresh del tab).
- [ ] 5.5 Gate FE (Vitest bajo `TZ=UTC` + tsc) + review adversarial (foco: el 409→force flow no puede degenerar en "confirm spam" que normalice el force) + `sdd-verify` FE-1.
- [ ] 5.6 Push con OK del usuario + deploy verde.

## 6. Go-live gradual + cierre

- [ ] 6.1 Prender el flag `radius-auto-cure` en prod (Config UI) con el usuario mirando: monitorear los primeros ticks (log estructurado) + el tab "Sesiones curadas".
- [ ] 6.2 Validación en vivo: esperar/provocar una sesión colgada real (candidato natural: NAS vialidad `10.60.0.10`, 23/26 curas de hoy) y verificar la cura vía FAST PATH en **~5-7 min desde la muerte de la sesión** (requisito de la enmienda) + fila `cured` con `signalUsed='persistent_rejects'` + cliente re-autentica. Verificar también un caso `stale_interim` si aparece.
- [ ] 6.2b Monitorear `flagged_flapping` la primera semana: cada username flaggeado es un caso de soporte (credencial compartida/clon) — reportarlos al usuario.
- [ ] 6.3 Verificar la carrera con el cron: confirmar que aparecen `already_cured` (o no, si el watcher siempre gana) y que NADA se rompe.
- [ ] 6.4 E2E del botón manual sobre un caso real (Playwright o a mano con el usuario).
- [ ] 6.5 Sync `main` local == origin (los 3 repos) + card BACKLOG → estado + mem_save del resultado.

## Fuera de scope (registrado)

- Arreglar `checkrad`/`nasreload` nativos de FreeRADIUS (obra mayor, sin retorno teniendo watcher + cron).
- Recalibrar las reglas/cadencias del cron (follow-up con datos del watcher).
- Alertas Telegram de curas repetidas del mismo cliente (el log estructurado + la tabla dejan el hook).
- Curación masiva por NAS caído (el breaker la aborta a propósito — eso es gestión de incidente).
