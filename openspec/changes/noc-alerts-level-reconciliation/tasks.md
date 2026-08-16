# Tasks: NOC Alerts — Reconciliación por Nivel

**STRICT TDD**: cada tarea de implementación arranca por el test que FALLA
(RED → GREEN → REFACTOR). Runner BE: `npm test`. Runner colector: `cargo test`.
Ninguna tarea se marca `[x]` sin su test verde.

> **BLOQUEO**: las fases 1 y 2 dependen de la confirmación del usuario a **P1**
> (tocar el BE) y **P2** (eliminar `SignalWarning`). No arrancar sin eso.

## Fase 1 — Backend: estado anunciado (aditivo, sin migración)

- [ ] 1.1 RED: test de `GET /api/alerts/ingest/fiber-collector/state` → 200 con la ingest key correcta (supertest + `InMemoryNocAlertRepository`)
- [ ] 1.2 RED: tests de auth — 401 sin key, 401 con la key de OTRA fuente, 404 con fuente desconocida, 401 con key configurada vacía
- [ ] 1.3 RED: tests de proyección — solo `firing`, solo esa `source`, array plano sin `{data}`, `[]` cuando no hay nada, `acknowledged` presente
- [ ] 1.4 RED: test del kill-switch — 503 con `noc-alerts-hub-enabled` en `false`
- [ ] 1.5 RED: test de dual-auth — sesión + `monitoring.read` también da 200
- [ ] 1.6 GREEN: `toNocAlertStateDto` en `src/application/dto/nocAlert.ts` (proyección mínima)
- [ ] 1.7 GREEN: ruta en `src/infrastructure/http/routes/alerts.routes.ts` reusando `createApiKeyMiddleware(ingestKeys[source])` + el molde dual-auth de `createThresholdsReadAuth`; reusa `ListAlerts` con `{source, status:'firing'}` — sin cambiar su firma
- [ ] 1.8 VERIFY: `npm test` verde + `tsc --noEmit` limpio; confirmar que NO se tocó `app.ts` fuera del wiring existente

## Fase 2 — Colector: núcleo puro de reconciliación

- [ ] 2.1 RED: tabla de verdad de `reconcile()` — Firing/no-anunciado → Fire; Clear/anunciado → Resolve; Firing/anunciado-misma-sev → nada; Firing/anunciado-otra-sev → Fire; **Unknown/anunciado → nada**
- [ ] 2.2 GREEN: `reconcile(desired, announced) -> Vec<Action>` (100% pura, sin IO, sin mutación)
- [ ] 2.3 RED: filtro de ownership — fingerprints fuera de `olt-level/` jamás se resuelven (incluye `onu-signal-degraded-*`, `pon-suspect-*` y los `olt-watch-*` legacy)
- [ ] 2.4 GREEN: filtro de prefijo en el parseo del estado anunciado
- [ ] 2.5 RED: catálogo de condiciones — un test por fingerprint del design §Catálogo, verificando forma exacta y severidad
- [ ] 2.6 GREEN: `Condition`/`Fingerprint` + constructores determinísticos (**sin `now` en el fingerprint** — hay que pinear esto con un test explícito)

## Fase 3 — Colector: observación (niveles derivados)

- [ ] 3.1 RED: freshness — arranque en frío con 300 LOS no abre nada; LOS anunciada con freshness desconocida se arrastra (Unknown); LOS crónica vencida resuelve
- [ ] 3.2 GREEN: `last_online_at` + ventanas `LOS_FRESH_WINDOW` / `PWR_FRESH_WINDOW`
- [ ] 3.3 RED: jerarquía — 2 LOS-fresh mismo PON → `pon-outage` + individuales en `Clear`; escalada individual→ramal cierra la individual (C3); reparación parcial reabre la individual; mass-LOS suprime PON e individuales
- [ ] 3.4 GREEN: supresión por contención top-down (OLT → PON → ONU)
- [ ] 3.5 RED: power fail zonal — 5 fresh → Firing; 4 → Clear
- [ ] 3.6 GREEN: nivel `olt-power-outage`
- [ ] 3.7 RED: salud de OLT — `recent-restart` desde `uptime_s < RESTART_WINDOW` sin memoria previa; auto-resolución al pasar la ventana; `unreachable` a los 2 misses; ONUs de una OLT unreachable observadas Unknown
- [ ] 3.8 GREEN: condiciones de salud (sin `prev_uptime_s`)
- [ ] 3.9 RED: señal no medible → Unknown, nunca Clear (**REGRESIÓN C5**)
- [ ] 3.10 GREEN: mapeo `SignalLevel` incluyendo `Unmeasurable`; solo `Critical` produce condición (pendiente P2)
- [ ] 3.11 RED: histéresis — oscilación Critical/Warning en 20 ciclos no emite nada (**REGRESIÓN C2**); condición sostenida `FIRE_FOR` ciclos sí abre
- [ ] 3.12 GREEN: `pending_since` + `FIRE_FOR` / `CLEAR_FOR` asimétricos

## Fase 4 — Colector: guarda de sanidad

- [ ] 4.1 RED: snapshot vacío con 40 fingerprints anunciados no emite ningún resolve (**REGRESIÓN C1**)
- [ ] 4.2 RED: la guarda se destraba sola al ciclo siguiente con datos buenos (**REGRESIÓN C1-bis**)
- [ ] 4.3 RED: apagón zonal (700/700 filas, 650 en Power fail) NO dispara la guarda y SÍ abre `olt-power-outage` (**REGRESIÓN HIGH#1**)
- [ ] 4.4 GREEN: `sanity()` — error/envelope `status:false`, 429/5xx, y cobertura vs. `COUNT(*) onu_signal_current` contando filas SIN filtrar por condición
- [ ] 4.5 RED: `collector-stale/{olt}` tras `STALE_CYCLES` salteados consecutivos
- [ ] 4.6 GREEN: contador de ciclos salteados + escape hatch
- [ ] 4.7 GREEN: `PgClient::count_onus_by_olt()` (SELECT puro, **sin DDL, sin migración**) + test de integración con schema efímero

## Fase 5 — Colector: anuncio y rate-limiting

- [ ] 5.1 RED: escalación suprimida por el limiter reaparece en el ciclo siguiente (**REGRESIÓN C4-bis**)
- [ ] 5.2 RED: POST fallido (503) se reintenta el ciclo siguiente
- [ ] 5.3 RED: techo por ciclo difiere las sobrantes ordenando por severidad descendente, sin descartar ninguna
- [ ] 5.4 GREEN: `rate_limit(actions, mem, now)` — **jamás muta estado anunciado**; `ANNOUNCE_MIN_INTERVAL` + `MAX_ANNOUNCES_PER_CYCLE`
- [ ] 5.5 RED: `fetch_announced_state()` — URL, `Authorization: Bearer`, parseo de array plano, error → `Err`
- [ ] 5.6 GREEN: método en `hub_client.rs` (molde de `try_fetch_thresholds`)
- [ ] 5.7 RED: GET fallido saltea el ciclo entero sin emitir nada
- [ ] 5.8 GREEN: `olt_watch_cycle` reescrito en `main.rs` — GET state → observe → reconcile → rate_limit → POST

## Fase 6 — Convivencia, config y limpieza

- [ ] 6.1 RED: `NOC_OLT_WATCH_MODE` sin definir → camino legacy, sin llamar a `GET .../state`
- [ ] 6.2 GREEN: flag en `config.rs` + branch en `run_olt_watch_loop`; modo `dry-run` que loguea el delta sin postear
- [ ] 6.3 GREEN: env vars nuevas con defaults del design §P3 (`LOS_FRESH_WINDOW`, `PWR_FRESH_WINDOW`, `RESTART_WINDOW`, `PON_MIN`, `OLT_MASS_MIN`, `PWR_ZONAL_MIN`, `COVERAGE_FLOOR`, `STALE_CYCLES`, `FIRE_FOR`, `CLEAR_FOR`, `ANNOUNCE_MIN_INTERVAL`, `MAX_ANNOUNCES_PER_CYCLE`)
- [ ] 6.4 GREEN: borrar `WatchState`, `Cooldowns`, `evaluate_*_transitions`, `Event` y sus tests SOLO después de que el modo `reconcile` esté verde y deployado
- [ ] 6.5 VERIFY: `git diff main -- src/sensors/pon_analysis.rs src/sensors/signal_poll.rs src/signal_store.rs` **VACÍO** (el ciclo señal/PON no se tocó) + tests que pinean `onu-signal-degraded-{sn}` y `pon-suspect-{olt}-{pon}` siguen verdes

## Fase 7 — Rollout

- [ ] 7.1 Deploy BE (aditivo). Verificar el GET en vivo con la ingest key real
- [ ] 7.2 Deploy colector con `NOC_OLT_WATCH_MODE=legacy`; backup del binario previo en la VM 130 (`.bak-pre-reconcile`)
- [ ] 7.3 Ciclo shadow en `dry-run`: revisar el delta logueado y **calibrar P3** contra datos reales antes del cutover
- [ ] 7.4 Cutover: `NOC_OLT_WATCH_MODE=reconcile` + restart. Observar 3 ciclos
- [ ] 7.5 Limpieza one-shot de las ~400 legacy (`fingerprint LIKE 'olt-watch-%'`, ver design §Migration paso 4) — **después** del cutover, nunca automática
- [ ] 7.6 `mem_save` del resultado en engram (`noc-alerts-hub/nivel-en-prod`)
