# Spec: BE-1 — Watcher de auto-curación + registro auditable en Prominense

> Repo: `ipnext-backend`. Delta spec del change `radius-session-autocure`.

## REQ-CURE-1 — Detección desde los eventos YA ingeridos (cero barrido nuevo)

El watcher DEBE detectar candidatos leyendo `RadiusAuthEvent` con `reason='session_stuck'` y `authdate >= now - LOOKBACK` (default 15 min, `RADIUS_AUTO_CURE_LOOKBACK_MS`), vía el port EXISTENTE `RadiusAuthEventRepository.list`. Los candidatos son los usernames ÚNICOS de esos eventos, y por cada uno el watcher DEBE computar el agregado `{firstReject, lastReject}` (min/max `authdate` de sus eventos en la ventana) — el insumo del fast path de REQ-CURE-2. El watcher NO DEBE agregar queries nuevas contra el orchestrator ni MariaDB para la detección.

- **S1.1** dado un evento `session_stuck` de `userX` dentro del lookback, cuando corre el tick, entonces `userX` es candidato (una sola vez aunque tenga 179 rejects).
- **S1.2** dado un evento `session_stuck` MÁS VIEJO que el lookback, cuando corre el tick, entonces NO es candidato (ya lo cubrió el cron).
- **S1.3** eventos con reason `user_not_found`/`other` → jamás candidatos.
- **S1.4** `userX` con rejects a las 10:00, 10:03 y 10:06 → agregado `{firstReject: 10:00, lastReject: 10:06}` (persistencia de 6 min computable sin queries extra).

## REQ-CURE-2 — Verificación por username: DOS caminos de cura, gates FAIL-CLOSED (enmienda fast-path 2026-07-16)

Antes de curar, el watcher DEBE verificar con `gateway.listSessions(username)` FRESCO y aplicar, EN ORDEN: (a) sin sesiones abiertas → skip `skipped_no_session`; (b) sesiones abiertas en NAS DISTINTOS entre sí → skip `skipped_ambiguous`; (c) alguna sesión sin `lastUpdate` en el wire → skip `skipped_no_signal`; (d) **FAST PATH**: si `lastReject - firstReject >= PERSISTENCE_MS` (default 5 min) Y `now - lastReject <= RECENCY_MS` (default 2 min — el cliente SIGUE marcando) → curar TODAS las sesiones abiertas SIN exigir staleness, con `signalUsed='persistent_rejects'` (política new-wins: `Simultaneous-Use=1` en los 81 grupos ⇒ no existe doble-login legítimo ⇒ el que marca gana; el interim fresco NO bloquea este camino); (e) sin persistencia: ALGUNA sesión con `now - lastUpdate < STALE_MS` → skip `skipped_alive`; (f) TODAS stale (`> STALE_MS`) → curar con `signalUsed='stale_interim'`. `STALE_MS` default 1 200 000 (20 min) con PISO DURO de 20 min — **restricción DURA**: con interim de 600 s, staleness <20 min = falsos positivos masivos; el fast path existe justamente para NO bajar este umbral. `PERSISTENCE_MS` piso 2 min; `RECENCY_MS` piso 30 s; todo techo 24 h; inválido → default; JAMÁS tumba el boot.

- **S2.1** sesión única con `lastUpdate` hace 25 min, sin persistencia de rejects (un solo reject hace 1 min) → curada vía camino stale, fila con `signalUsed='stale_interim'`.
- **S2.2** sesión única con `lastUpdate` hace 5 min y rejects que AÚN no persisten (ventana de 3 min) → `skipped_alive` (todavía no hay evidencia suficiente por ningún camino).
- **S2.3** sesión única con `lastUpdate` hace 5 min (interim FRESCO) y rejects sostenidos 6 min con el último hace 1 min → **CURADA vía fast path**, fila con `signalUsed='persistent_rejects'` (el caso segundo-dispositivo: el que marca gana; micro-corte aceptado).
- **S2.4** dos sesiones abiertas en NAS distintos → `skipped_ambiguous` AUNQUE la persistencia esté cumplida (el fast path NO saltea este gate).
- **S2.5** sesión sin `lastUpdate` (orchestrator viejo) → `skipped_no_signal` AUNQUE la persistencia esté cumplida — NUNCA se usa `startedAt` como señal sustituta, y el gate preserva el orden de deploy ORCH-1→BE-1.
- **S2.6** cero sesiones abiertas (el cron ya curó) → `skipped_no_session`.
- **S2.7** `RADIUS_AUTO_CURE_STALE_MS=60000` (bajo el piso) → el gate usa 20 min igual (clamp al piso, boot OK); ídem `PERSISTENCE_MS` bajo 2 min → clamp a 2 min.
- **S2.8** dos sesiones stale en el MISMO NAS → se curan AMBAS (cada una su llamada cure, cada una su fila).
- **S2.9** persistencia cumplida (ventana de 8 min de rejects) pero el ÚLTIMO reject fue hace 10 min (el cliente dejó de marcar) → el fast path NO aplica (recencia falla); se evalúa el camino stale normal.
- **S2.10** el agregado de rejects abarca exactamente `PERSISTENCE_MS` (borde) → fast path aplica (`>=`, no `>`).

## REQ-CURE-3 — Curación vía gateway + extensión ADITIVA del port

El gateway port DEBE extenderse ADITIVAMENTE: `OrchestratorSession.lastUpdate: string | null` (parseado del `last_update` del wire; `null` si el orchestrator no lo manda) y `cureSession(username, sessionId): Promise<{cured: boolean, alreadyClosed: boolean, closedAt: string | null, coa: CoAResult[]}>` → `POST /users/{username}/sessions/{sessionId}/cure` (sessionId con `encodeURIComponent`). **El WIRE responde snake_case** (contrato implementado + contract test exact-match en ORCH, commit d37de58): `{cured, already_closed, closed_at, coa: [{nas_ip, status, detail}]}` con `status` lowercase (`'ack'|'timeout'|...`) — el gateway MAPEA `already_closed`→`alreadyClosed`, `closed_at`→`closedAt` y deriva `action: 'both'` si `coa.some(r => r.status === 'ack')`, si no `'acct_close'`. Errores upstream: 404 → error tipado (outcome `failed`, reason `session_not_found`); red/5xx → `OrchestratorUnreachableError`. Los fakes in-memory DEBEN modelar la semántica real (cure sobre sesión cerrada → `alreadyClosed`, no throw).

- **S3.1** cure exitoso → outcome `cured`, action refleja lo ejecutado (`both` si el CoA upstream anduvo, `acct_close` si el CoA falló pero cerró).
- **S3.2** cure con `already_closed: true` en el wire (el cron ganó; el gateway lo expone como `alreadyClosed`) → outcome `already_cured` — no-op limpio registrado, jamás error.
- **S3.3** orchestrator caído durante el cure → outcome `failed` con reason, el tick sigue con el próximo candidato (aislamiento por ítem).
- **S3.4** sessionId con caracteres no alfanuméricos → la URL va con `encodeURIComponent` (test del gateway HTTP).

## REQ-CURE-4 — Anti-tormenta y anti-flapping: breaker, cap, cure-throttle 30 min, flapping flag, throttle, flag DARK (enmienda 2026-07-16)

El watcher DEBE: (a) ABORTAR el tick sin curar nada si los candidatos únicos superan `RADIUS_AUTO_CURE_ABORT_THRESHOLD` (default 20 — decenas de stuck simultáneos = incidente de NAS, no sesiones colgadas; SE MANTIENE con el fast path); (b) procesar a lo sumo `RADIUS_AUTO_CURE_MAX_PER_TICK` (default 5) por tick, resto `deferred`; (c) **cure-throttle anti-flapping**: saltear usernames con un evento `cured` más nuevo que `RADIUS_AUTO_CURE_COOLDOWN_MS` (default **30 min** — una cura por username cada 30 min máximo); (d) **flapping flag**: si el username acumula ≥ `RADIUS_AUTO_CURE_FLAPPING_MAX` (default 3) eventos `cured` en las últimas 24 h → NO curar mientras persista la condición y registrar fila `flagged_flapping` (delata credencial compartida/clon — caso de soporte, no de auto-cura); (e) throttlear el REGISTRO de `skipped_*`/`failed`/`flagged_flapping` idénticos (mismo outcome + reason) del mismo username por 6 h — los `cured` SIEMPRE registran; el check del throttle es fail-open; (f) gatearse por el feature flag `radius-auto-cure` (DB, seed OFF, chequeado EN CADA tick) + lock distribuido `radius-auto-cure` + reentrancy guard inFlight; tick `RADIUS_AUTO_CURE_INTERVAL_MS` default 60 000 (piso 15 s, techo 24 h, inválido→default). Un tick fallido JAMÁS tumba el proceso. Log estructurado por tick con TODOS los counters (`events, candidates, cured, alreadyCured, failed, skippedAlive, skippedAmbiguous, skippedNoSession, skippedNoSignal, skippedCureThrottle, flaggedFlapping, deferred, throttled, aborted`).

- **S4.1** 25 candidatos únicos en el tick → tick abortado, cero llamadas al gateway, `aborted: true` + WARN.
- **S4.2** 8 candidatos con cap 5 → 5 procesados, `deferred: 3`; el tick siguiente retoma (los eventos siguen en el lookback).
- **S4.3** mismo username con `skipped_alive` idéntico hace 2 h → sin fila nueva (throttled++); hace 7 h → fila nueva.
- **S4.4** flag OFF (o ausente) → el tick retorna sin trabajo; flag ON→OFF → el tick siguiente ya no procesa (sin restart).
- **S4.5** username curado hace 10 min que reaparece como candidato con fast path cumplido → skip por cure-throttle (counter, sin fila) — el throttle pesa MÁS que el fast path.
- **S4.6** username con 3 curas en las últimas 24 h que reaparece como candidato → fila `flagged_flapping`, CERO llamadas al cure; a las 6 h sigue flapping → sin fila nueva (throttled); pasadas 24 h de la primera cura (quedan <3 en la ventana) → vuelve a ser curable.
- **S4.7** el fallo de un candidato NO aborta el tick (aislamiento por ítem, molde REQ-AUTO-3 de pppoe-move-nas).
- **S4.8** envs inválidas → defaults, boot OK (contract de `parseIntervalMs`/`parsePositiveInt`).

## REQ-CURE-5 — Tabla `RadiusSessionCureEvent` (migración ADITIVA) + `GET /api/radius/session-cures`

Todo intento de cura (auto o manual) que pasa los filtros de candidato DEBE persistir una fila `RadiusSessionCureEvent` (molde `PppoeNasMoveEvent`: append-only, soft refs sin FK, outcome String libre): `{username, nasIp?, sessionId?, sessionStartedAt?, sessionLastUpdate?, signalUsed?: 'persistent_rejects'|'stale_interim', trigger: 'auto'|'manual', action: 'both'|'acct_close'|'coa'|null, outcome, reason?, actorName?, createdAt}` — outcomes v1: `cured | already_cured | skipped_alive | skipped_ambiguous | skipped_no_session | skipped_no_signal | flagged_flapping | failed`. El listado DEBE exponerse en `GET /api/radius/session-cures` — gemelo de `GET /auth-failures`: guard `network.read`, validación defensiva de query params, filtros `username?/outcome?/trigger?/from?/to?`, paginado (default 50, cap 200). Wire contract campo por campo: `{ data: [...incluye signalUsed...], total, page, limit, hasNext, countsByOutcome }` (`countsByOutcome` ignora el filtro `outcome` — chips del FE).

- **S5.1** cura auto por fast path → fila `{trigger:'auto', outcome:'cured', actorName:'sistema', signalUsed:'persistent_rejects'}` y el endpoint la devuelve; cura por camino stale → `signalUsed:'stale_interim'` — los dos caminos DISTINGUIBLES en la tabla y el log.
- **S5.2** skip por sesión viva → fila `{outcome:'skipped_alive', signalUsed:null}` (visible: soporte ve POR QUÉ no se curó); flapping → fila `{outcome:'flagged_flapping'}` consultable con `?outcome=flagged_flapping`.
- **S5.3** `?outcome=cured` filtra la lista pero `countsByOutcome` sigue trayendo el desglose completo.
- **S5.4** query params inválidos (outcome fuera del enum, page no numérica, fecha rota) → 400 `VALIDATION_ERROR`, nunca 500.
- **S5.5** guard: sin `network.read` → 403; la migración es ADITIVA (cero cambios a tablas existentes).

## REQ-CURE-6 — Cura MANUAL: `POST /api/radius/session-cures` (escape hatch auditado)

La ruta manual DEBE: guard `network.manage` (espejo del disconnect manual); body `{username, sessionId, force?}`; ejecutar el MISMO core `CureStuckSession` que el watcher. Sin `force`: respeta los gates fail-closed — alive/ambiguous responden 409 tipado (`CURE_SKIPPED_ALIVE`/`CURE_SKIPPED_AMBIGUOUS`) sin curar (el manual NO evalúa persistencia de rejects — el operador ES la evidencia; por eso el gate alive sí aplica sin force). Con `force: true`: saltea los gates alive/ambiguous y cura. El manual NO pasa por el cure-throttle de 30 min ni por el flapping flag (decisión deliberada del operador — el escape hatch no puede quedar bloqueado por la política del watcher). SIEMPRE persiste fila `trigger='manual'` con el `actorName` del operador (incluidos los 409 con su outcome `skipped_*`); el manual NO pasa por el throttle de registro de 6 h. Errores → `next(err)` / errorHandler (nunca throw pelado — Express 4).

- **S6.1** manual sin force sobre sesión stale → 200 `{outcome:'cured'}` + fila con actorName del operador.
- **S6.2** manual sin force sobre sesión con interim fresco → 409 `CURE_SKIPPED_ALIVE` + fila `skipped_alive` trigger manual.
- **S6.3** manual con `force: true` sobre la misma → 200 cured + fila con reason `forced`.
- **S6.4** sin `network.manage` → 403 y CERO filas.
- **S6.5** dos manuales seguidos del mismo username → ambos registran fila (sin throttle en manual).
- **S6.6** username `flagged_flapping` por el watcher → el manual con force IGUAL cura (el flag frena al watcher, no al operador) y la fila queda registrada.

## REQ-CURE-7 — Composición y wiring

El scheduler `RadiusAutoCureScheduler` + `bootstrapRadiusAutoCure` DEBEN clonar el patrón de `PppoeAutoMoveScheduler`/`bootstrapPppoeAutoMove`: null sin `ORCHESTRATOR_BASE_URL` (opt-in), adapters frescos, tuning inyectado desde `config` (las envs nuevas documentadas en `env.example`), `start()` desde `main.ts`, `runOnce()` para tests, timer con `unref()`. Wiring de las rutas nuevas en `app.ts` con test estático de wiring (sin wiring = feature muerta).

- **S7.1** sin `ORCHESTRATOR_BASE_URL` → bootstrap retorna null con WARN, el boot sigue.
- **S7.2** composition test: el bootstrap inyecta el tuning desde `config.radiusAutoCure` (sin la inyección las envs quedan muertas — lección D-W2.5 de pppoe-move-nas).
- **S7.3** `env.example` documenta TODAS las envs nuevas (`RADIUS_AUTO_CURE_INTERVAL_MS`, `_LOOKBACK_MS`, `_STALE_MS`, `_PERSISTENCE_MS`, `_REJECT_RECENCY_MS`, `_MAX_PER_TICK`, `_ABORT_THRESHOLD`, `_COOLDOWN_MS` (30 min), `_FLAPPING_MAX`).
- **S7.4** coherencia de ventanas: si la config resulta en `LOOKBACK_MS <= PERSISTENCE_MS + RECENCY_MS`, el lookback se clampa hacia arriba (el fast path DEBE poder observar su ventana completa) — boot OK, WARN logueado.
