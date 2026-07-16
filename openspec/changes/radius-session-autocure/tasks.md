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

- [x] 3.1 Tests RED del gateway: `OrchestratorSession.lastUpdate` aditivo + `cureSession` (S3.1–S3.4 de REQ-CURE-3, incl. `encodeURIComponent` y fake con semántica `alreadyClosed`).
- [x] 3.2 GREEN: port + `HttpRadiusOrchestratorGateway` + fakes/in-memory actualizados (aditivo — cero firmas rotas).
- [x] 3.3 Migración ADITIVA `RadiusSessionCureEvent` (hand-written SQL calcado 1:1 del molde `PppoeNasMoveEvent` — `prisma migrate diff` pide shadow DB no disponible en el worktree; `npx prisma generate` corrido OK sin DB) + port `RadiusSessionCureEventRepository` + adapters `Prisma*`/`InMemory*` (naming convention del repo).
- [x] 3.4 Tests RED del core `CureStuckSession`: gates fail-closed + DOS caminos de cura (fast path por persistencia / stale interim) S2.1–S2.10 (REQ-CURE-2, enmienda) + outcomes/registro con `signalUsed` (REQ-CURE-3, REQ-CURE-5 S5.1–S5.2) con in-memory + fake gateway.
- [x] 3.5 GREEN: `CureStuckSession` (gates + fast path new-wins + camino stale + cura + fila con signalUsed; parámetros trigger/actor/force y agregado `{firstReject, lastReject}`).
- [x] 3.6 Tests RED del watcher `AutoCureStuckSessions`: detección + agregado por username S1.1–S1.4 (REQ-CURE-1) + breaker/cap/cure-throttle 30 min/flapping flag/throttle S4.1–S4.8 (REQ-CURE-4, enmienda).
- [x] 3.7 GREEN: `AutoCureStuckSessions` (lookback → agregado `{firstReject, lastReject}` por username → breaker → cap → cure-throttle 30 min → flapping flag (≥3 curas/24 h → `flagged_flapping`) → core por ítem con aislamiento de fallos → summary con TODOS los counters).
- [x] 3.8 Config: bloque `radiusAutoCure` en `config.ts` (`parseIntervalMs`/`parsePositiveInt`; piso duro 20 min en `STALE_MS` — S2.7; pisos de `PERSISTENCE_MS`/`RECENCY_MS`; clamp de coherencia `LOOKBACK > PERSISTENCE + RECENCY` — S7.4) + `env.example` (S7.3, incluye `_PERSISTENCE_MS`, `_REJECT_RECENCY_MS`, `_FLAPPING_MAX` y el nuevo default 30 min de `_COOLDOWN_MS`).

### 4. Scheduler + rutas + wiring (TDD)

- [x] 4.1 `RadiusAutoCureScheduler` + `bootstrapRadiusAutoCure` (clon de `PppoeAutoMoveScheduler`/`bootstrapPppoeAutoMove`: inFlight + lock `radius-auto-cure` + flag por tick + catch del tick + unref) + tests S4.4, S7.1–S7.2 + start desde `main.ts`.
- [x] 4.2 Seed del feature flag `radius-auto-cure` OFF (migración idempotente `ON CONFLICT DO NOTHING`, patrón del seed de `pppoe-auto-move`).
- [x] 4.3 Use case `ListRadiusSessionCures` (paginado, filtros, `countsByOutcome` — molde `ListRadiusAuthFailures`) + ruta `GET /api/radius/session-cures` (gate `network.read`, validación defensiva) + tests de ruta S5.3–S5.5 (wire contract campo por campo).
- [x] 4.4 Ruta manual `POST /api/radius/session-cures` (gate `network.manage`, force, SIEMPRE registra, sin cure-throttle/flapping para el operador, errores via `next(err)`) + tests S6.1–S6.6.
- [x] 4.5 Wiring en `app.ts` + composition test (S7.2 — sin wiring = feature muerta) + `deploy.yml`: forward de `RADIUS_AUTO_CURE_INTERVAL_MS` (mismo criterio que `AUTO_MOVE_INTERVAL_MS`; resto del tuning disponible via `gh secret set` si hace falta override — el ON/OFF va por FeatureFlag UI, NO por env).
- [x] 4.6 Gate: suite ACOTADA al change (20 suites / 354 tests, todo verde) + `tsc --noEmit` limpio. NO se corrió `npm test` completo (instrucción explícita del orquestador — full suite queda para `sdd-verify`).
- [x] 4.7 Review adversarial (focos: carrera watcher-vs-cron y watcher-vs-manual sobre la misma sesión; fast path new-wins — que el ping-pong de credencial compartida NO degenere en kick-loop (cure-throttle 30 min + flapping flag deben cortarlo); gate alive con múltiples sesiones mixtas fresca+stale y persistencia a medio cumplir; interacción cure-throttle vs flapping vs throttle de registro; fail-open del throttle) + fix waves hasta CLEAN.
  FOCO 1 (kick-loop/fail-closed) verificado SÓLIDO — 0 CRITICAL. Quedaron 2 MEDIUM + 2 LOW, TODOS resueltos en esta fix wave (rojo→verde, TDD):
  - MEDIUM-1 (starvation del cap): en `AutoCureStuckSessions.run()`, `processed++` se hacía ANTES de evaluar cure-throttle/flapping — esos SKIPS consumían un slot de `maxPerTick` igual que una cura real. Como el repo de auth events ordena `authdate DESC`, un puñado de flappers (reject continuo) siempre quedaba al frente del Map → agotaba los `maxPerTick` slots cada tick → curas legítimas quedaban `deferred` hasta el cron (20-50min). Fix: `checkThrottleAndFlapping()` se evalúa ANTES y por FUERA del cap — solo un intento REAL de cura (el que llega a `cureStuckSession.execute`) consume slot. Test: 5 flappers throttled + 2 legítimas → las 2 legítimas curan, `deferred:0` (antes: `cured:0`, ambas legítimas starveadas).
  - MEDIUM-2 (200 mentiroso): `CureStuckSession.execute()` atrapa `OrchestratorUnreachableError` internamente (vía `finishSkip`) para poder grabar la fila de auditoría — nunca la relanza. La ruta `POST /session-cures` solo mapeaba `skipped_alive`/`skipped_ambiguous` a 409; un `outcome:'failed'` por orchestrator caído caía a `res.json()` = 200, mintiendo éxito (el hermano `DELETE /sessions` sí mapea bien esto vía `next(err)` → errorHandler → 502). Fix: nuevo chequeo `isOrchestratorUnreachable(result)` (mira `result.reason` Y cada fila de `result.events`, cubre el caso multi-sesión) → 502 `ORCHESTRATOR_UNREACHABLE`. La fila de auditoría se sigue grabando igual. Test: POST manual con username unreachable → 502 + fila `failed`/`orchestrator_unreachable` registrada.
  - LOW-1 (piso/techo laxos): `cooldownMs` tenía piso 60s y `flappingMax` techo 1000 — combinados permitían "cured cada ~60s" sostenido casi 16h antes de delatar flapping, debilitando el anti-kick-loop. Fix: piso `cooldownMs` subido a 300000 (5min), techo `flappingMax` bajado a 20. Defaults sin cambios (30min / 3).
  - LOW-2 (miscuenta del summary): `AutoCureStuckSessions.tally()` contaba por el `outcome` AGREGADO de `deriveOverallOutcome` (que colapsa a `'cured'` si ALGUNA sesión curó) — un tick multi-sesión que curó 1 y falló otra sumaba `cured++` pero NO `failed++` (la fila `failed` SÍ quedaba bien persistida en DB, solo el contador de log del tick miscontaba). Fix: `tally()` itera `result.events` y cuenta CADA fila por su propio `outcome`. Test: 2 sesiones del mismo username, 1 cura + 1 falla (404 simulado) → `summary.cured:1` Y `summary.failed:1`.
  Descubierto además (no parte del review, bloqueaba el gate): 2 tests de `radius.sessionCures.routes.test.ts` (S6.2, S6.3) hardcodeaban `lastUpdate` como fecha ABSOLUTA para simular "sesión fresca" — la ruta manual usa `Date.now()` real (correcto en producción), así que el wall-clock los volvía `stale` con el correr de las horas/días. Fix: `lastUpdate` computado relativo a `Date.now()` en el momento del test.
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
