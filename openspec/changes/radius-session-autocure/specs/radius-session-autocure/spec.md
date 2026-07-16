# Spec: BE-1 — Watcher de auto-curación + registro auditable en Prominense

> Repo: `ipnext-backend`. Delta spec del change `radius-session-autocure`.

## REQ-CURE-1 — Detección desde los eventos YA ingeridos (cero barrido nuevo)

El watcher DEBE detectar candidatos leyendo `RadiusAuthEvent` con `reason='session_stuck'` y `authdate >= now - LOOKBACK` (default 15 min, `RADIUS_AUTO_CURE_LOOKBACK_MS`), vía el port EXISTENTE `RadiusAuthEventRepository.list`. Los candidatos son los usernames ÚNICOS de esos eventos. El watcher NO DEBE agregar queries nuevas contra el orchestrator ni MariaDB para la detección.

- **S1.1** dado un evento `session_stuck` de `userX` dentro del lookback, cuando corre el tick, entonces `userX` es candidato (una sola vez aunque tenga 179 rejects).
- **S1.2** dado un evento `session_stuck` MÁS VIEJO que el lookback, cuando corre el tick, entonces NO es candidato (ya lo cubrió el cron).
- **S1.3** eventos con reason `user_not_found`/`other` → jamás candidatos.

## REQ-CURE-2 — Verificación FAIL-CLOSED por username (ante la duda, NO curar)

Antes de curar, el watcher DEBE verificar con `gateway.listSessions(username)` FRESCO y aplicar, en orden, estos gates: (a) sin sesiones abiertas → skip `skipped_no_session`; (b) ALGUNA sesión con `now - lastUpdate < STALE_MS` → skip `skipped_alive`; (c) sesiones abiertas en NAS DISTINTOS entre sí → skip `skipped_ambiguous`; (d) alguna sesión sin `lastUpdate` en el wire → skip `skipped_no_signal`; (e) solo si TODAS las sesiones están stale (`> STALE_MS`) y en el MISMO NAS → curar. `STALE_MS` default 1 200 000 (20 min) con PISO DURO de 20 min (el umbral validado — un valor menor produce falsos positivos) y techo 24 h; inválido → default; JAMÁS tumba el boot.

- **S2.1** sesión única con `lastUpdate` hace 25 min → curable.
- **S2.2** sesión única con `lastUpdate` hace 5 min → `skipped_alive` (interim fresco = sesión viva; el reject era doble login).
- **S2.3** dos sesiones abiertas en NAS distintos → `skipped_ambiguous` aunque ambas estén stale.
- **S2.4** sesión sin `lastUpdate` (orchestrator viejo o sin interim) → `skipped_no_signal` — NUNCA se usa `startedAt` como señal sustituta.
- **S2.5** cero sesiones abiertas (el cron ya curó) → `skipped_no_session`.
- **S2.6** `RADIUS_AUTO_CURE_STALE_MS=60000` (bajo el piso) → el gate usa 20 min igual (clamp al piso, boot OK).
- **S2.7** dos sesiones stale en el MISMO NAS → se curan AMBAS (cada una su llamada cure, cada una su fila).

## REQ-CURE-3 — Curación vía gateway + extensión ADITIVA del port

El gateway port DEBE extenderse ADITIVAMENTE: `OrchestratorSession.lastUpdate: string | null` (parseado del `last_update` del wire; `null` si el orchestrator no lo manda) y `cureSession(username, sessionId): Promise<{cured: boolean, alreadyClosed?: boolean}>` → `POST /users/{username}/sessions/{sessionId}/cure` (sessionId con `encodeURIComponent`). Errores upstream: 404 → error tipado (outcome `failed`, reason `session_not_found`); red/5xx → `OrchestratorUnreachableError`. Los fakes in-memory DEBEN modelar la semántica real (cure sobre sesión cerrada → `alreadyClosed`, no throw).

- **S3.1** cure exitoso → outcome `cured`, action refleja lo ejecutado (`both` si el CoA upstream anduvo, `acct_close` si el CoA falló pero cerró).
- **S3.2** cure con `alreadyClosed: true` (el cron ganó) → outcome `already_cured` — no-op limpio registrado, jamás error.
- **S3.3** orchestrator caído durante el cure → outcome `failed` con reason, el tick sigue con el próximo candidato (aislamiento por ítem).
- **S3.4** sessionId con caracteres no alfanuméricos → la URL va con `encodeURIComponent` (test del gateway HTTP).

## REQ-CURE-4 — Anti-tormenta: breaker, cap, cooldown, throttle, flag DARK

El watcher DEBE: (a) ABORTAR el tick sin curar nada si los candidatos únicos superan `RADIUS_AUTO_CURE_ABORT_THRESHOLD` (default 20 — decenas de stuck simultáneos = incidente, no sesiones colgadas); (b) procesar a lo sumo `RADIUS_AUTO_CURE_MAX_PER_TICK` (default 5) por tick, resto `deferred`; (c) saltear usernames con un evento `cured` más nuevo que `RADIUS_AUTO_CURE_COOLDOWN_MS` (default 10 min); (d) throttlear el REGISTRO de `skipped_*`/`failed` idénticos (mismo outcome + reason) del mismo username por 6 h — los `cured` SIEMPRE registran; el check del throttle es fail-open; (e) gatearse por el feature flag `radius-auto-cure` (DB, seed OFF, chequeado EN CADA tick) + lock distribuido `radius-auto-cure` + reentrancy guard inFlight; tick `RADIUS_AUTO_CURE_INTERVAL_MS` default 60 000 (piso 15 s, techo 24 h, inválido→default). Un tick fallido JAMÁS tumba el proceso. Log estructurado por tick con TODOS los counters (`events, candidates, cured, alreadyCured, failed, skippedAlive, skippedAmbiguous, skippedNoSession, skippedNoSignal, skippedCooldown, deferred, throttled, aborted`).

- **S4.1** 25 candidatos únicos en el tick → tick abortado, cero llamadas al gateway, `aborted: true` + WARN.
- **S4.2** 8 candidatos con cap 5 → 5 procesados, `deferred: 3`; el tick siguiente retoma (los eventos siguen en el lookback).
- **S4.3** mismo username con `skipped_alive` idéntico hace 2 h → sin fila nueva (throttled++); hace 7 h → fila nueva.
- **S4.4** flag OFF (o ausente) → el tick retorna sin trabajo; flag ON→OFF → el tick siguiente ya no procesa (sin restart).
- **S4.5** username curado hace 5 min que reaparece como candidato → skip por cooldown (counter, sin fila).
- **S4.6** el fallo de un candidato NO aborta el tick (aislamiento por ítem, molde REQ-AUTO-3 de pppoe-move-nas).
- **S4.7** envs inválidas → defaults, boot OK (contract de `parseIntervalMs`/`parsePositiveInt`).

## REQ-CURE-5 — Tabla `RadiusSessionCureEvent` (migración ADITIVA) + `GET /api/radius/session-cures`

Todo intento de cura (auto o manual) que pasa los filtros de candidato DEBE persistir una fila `RadiusSessionCureEvent` (molde `PppoeNasMoveEvent`: append-only, soft refs sin FK, outcome String libre): `{username, nasIp?, sessionId?, sessionStartedAt?, sessionLastUpdate?, trigger: 'auto'|'manual', action: 'both'|'acct_close'|'coa'|null, outcome, reason?, actorName?, createdAt}`. El listado DEBE exponerse en `GET /api/radius/session-cures` — gemelo de `GET /auth-failures`: guard `network.read`, validación defensiva de query params, filtros `username?/outcome?/trigger?/from?/to?`, paginado (default 50, cap 200). Wire contract campo por campo: `{ data: [...], total, page, limit, hasNext, countsByOutcome }` (`countsByOutcome` ignora el filtro `outcome` — chips del FE).

- **S5.1** cura auto exitosa → fila `{trigger:'auto', outcome:'cured', actorName:'sistema', sessionLastUpdate: <la señal usada>}` y el endpoint la devuelve.
- **S5.2** skip por sesión viva → fila `{outcome:'skipped_alive'}` (visible: soporte ve POR QUÉ no se curó).
- **S5.3** `?outcome=cured` filtra la lista pero `countsByOutcome` sigue trayendo el desglose completo.
- **S5.4** query params inválidos (outcome fuera del enum, page no numérica, fecha rota) → 400 `VALIDATION_ERROR`, nunca 500.
- **S5.5** guard: sin `network.read` → 403; la migración es ADITIVA (cero cambios a tablas existentes).

## REQ-CURE-6 — Cura MANUAL: `POST /api/radius/session-cures` (escape hatch auditado)

La ruta manual DEBE: guard `network.manage` (espejo del disconnect manual); body `{username, sessionId, force?}`; ejecutar el MISMO core `CureStuckSession` que el watcher. Sin `force`: respeta los gates fail-closed — alive/ambiguous responden 409 tipado (`CURE_SKIPPED_ALIVE`/`CURE_SKIPPED_AMBIGUOUS`) sin curar. Con `force: true`: saltea los gates alive/ambiguous y cura. SIEMPRE persiste fila `trigger='manual'` con el `actorName` del operador (incluidos los 409 con su outcome `skipped_*`); el manual NO pasa por el throttle de 6 h. Errores → `next(err)` / errorHandler (nunca throw pelado — Express 4).

- **S6.1** manual sin force sobre sesión stale → 200 `{outcome:'cured'}` + fila con actorName del operador.
- **S6.2** manual sin force sobre sesión con interim fresco → 409 `CURE_SKIPPED_ALIVE` + fila `skipped_alive` trigger manual.
- **S6.3** manual con `force: true` sobre la misma → 200 cured + fila con reason `forced`.
- **S6.4** sin `network.manage` → 403 y CERO filas.
- **S6.5** dos manuales seguidos del mismo username → ambos registran fila (sin throttle en manual).

## REQ-CURE-7 — Composición y wiring

El scheduler `RadiusAutoCureScheduler` + `bootstrapRadiusAutoCure` DEBEN clonar el patrón de `PppoeAutoMoveScheduler`/`bootstrapPppoeAutoMove`: null sin `ORCHESTRATOR_BASE_URL` (opt-in), adapters frescos, tuning inyectado desde `config` (las envs nuevas documentadas en `env.example`), `start()` desde `main.ts`, `runOnce()` para tests, timer con `unref()`. Wiring de las rutas nuevas en `app.ts` con test estático de wiring (sin wiring = feature muerta).

- **S7.1** sin `ORCHESTRATOR_BASE_URL` → bootstrap retorna null con WARN, el boot sigue.
- **S7.2** composition test: el bootstrap inyecta el tuning desde `config.radiusAutoCure` (sin la inyección las envs quedan muertas — lección D-W2.5 de pppoe-move-nas).
- **S7.3** `env.example` documenta TODAS las envs nuevas (`RADIUS_AUTO_CURE_INTERVAL_MS`, `_LOOKBACK_MS`, `_STALE_MS`, `_MAX_PER_TICK`, `_ABORT_THRESHOLD`, `_COOLDOWN_MS`).
