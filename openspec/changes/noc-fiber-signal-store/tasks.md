# Tasks: Base propia Postgres para el histórico de señal de fibra

> ⚠️ **El código vive en `ipnext-noc-collector` (Rust, branch `feat/sensors`), NO en este repo.**
> Runner: **`cargo test`** (no `npm test`). Quality gates del repo del colector:
> `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` (job `ci` de
> `.github/workflows/deploy.yml`).
>
> **Strict TDD: RED → GREEN → REFACTOR.** El diseño está hecho para que el 90% de la lógica sea
> **pura** y se pueda testear sin base de datos (mismo molde que `sensors/pon_analysis.rs`).
> Los tests que SÍ necesitan Postgres se gatean por `NOC_TEST_PG_URL` (se saltean si no está) y
> corren en CI contra un service container.
>
> **Bloqueante:** las Fases 1–4 se construyen y testean SIN el servicio de EasyPanel. Solo la
> Fase 5 lo necesita.
>
> **Antes de empezar:** confirmar D1 (modo dual), D2 (retención) y D3 (crate) — ver
> `design.md` §Decisiones abiertas. D3 condiciona la tarea 1.1.

## Fase 0 — Prerrequisitos (usuario / infra)

- [x] 0.1 🔴 **BLOQUEANTE (usuario)**: crear el servicio Postgres en EasyPanel del `.37`.
      Entregable: DB `noc_fiber`, rol dedicado con permisos DDL+DML sobre su schema, host/puerto.
      HECHO: servicio `noc-fiber-db` creado (Postgres 17.10), ver engram
      `noc-fiber-signal-store/db-infra`. DB real se llama `noc-fiber-db` (no `noc_fiber`); el rol
      dedicado lo crea `migrations/0002_role_and_grants.sql` (ver Fase 1/apply), pendiente de
      aplicarlo contra la base real.
- [x] 0.2 🔴 **BLOQUEANTE (usuario)**: habilitar el acceso de red desde la VM 130 (`10.75.0.40`)
      al Postgres del `.37`. Verificación: `psql "$NOC_PG_URL" -c 'select 1'` desde la VM 130.
      HECHO: firewall en `raw`/PREROUTING del `.37` permite `190.7.234.33` (NAT de VM 130), ver
      engram `noc-fiber-signal-store/db-infra`. Puerto 5432 publicado al host.
- [x] 0.3 Confirmar D1 / D2 / D3 con el usuario y anotar la resolución en `design.md`.
      RESUELTO (apply, ver engram `sdd/noc-fiber-signal-store/apply`): D3=sqlx 0.8 (implementado).
      D2=730 días (implementado). D1 **difiere del texto de este documento**: el default de
      `NOC_BASELINE_SOURCE` implementado es `influx`, NO `postgres` — decisión operativa
      posterior al fix de la query de baseline de Influx (el análisis recién se encendió y no debe
      apagarse). El modo `dual`/`postgres` están cableados y funcionan, solo no son el default. Este
      `design.md` queda desalineado en ese punto — ver el override documentado en `config.rs` y
      engram `sdd/noc-fiber-signal-store/apply`.
- [ ] 0.4 Verificar NTP activo en la VM 130 (`timedatectl`) — el `ts` de las filas lo genera el
      colector, ver `design.md` §timestamp generado por el colector.

## Fase 1 — Esquema + migraciones + conexión

### Dependencia y andamiaje
- [x] 1.1 `Cargo.toml`: agregar la dep de DB según D3 (recomendado
      `sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio",
      "tls-rustls", "postgres", "migrate", "chrono"] }`). **No** usar los macros `query!`/`query_as!`
      (evita `DATABASE_URL` en build time y el directorio `.sqlx/`).
- [x] 1.2 `.github/workflows/deploy.yml`: agregar `services: postgres:16` al job `ci` y exportar
      `NOC_TEST_PG_URL`. Los tests de integración se saltean si la var no está (dev local sin PG
      sigue pudiendo correr `cargo test`). HECHO con `postgres:17` (matchea la versión real del `.37`).

### Migración inicial
- [x] 1.3 `migrations/0001_init.sql` con el DDL exacto de `design.md` §Esquema: las 2 tablas, el
      `UNIQUE INDEX (sn, ts DESC)`, el BRIN sobre `ts`, `fillfactor=70` y los parámetros de
      autovacuum de `onu_signal_current`, `CHECK (reason IN (1,2,3))` y los `COMMENT ON COLUMN`.
- [x] 1.4 RED (integración, gated): tras `migrate().run()` sobre una base vacía existen ambas
      tablas con las claves esperadas → *spec `noc-fiber-signal-store` / "Fresh database has both
      tables"*.
- [x] 1.5 RED (integración): `EXPLAIN` de la query de baseline NO contiene un nodo `Sort` sobre
      `onu_signal_history` y usa `onu_signal_history_sn_ts_desc` → *"Baseline query does not require
      a sort step"*. **Este test es el que protege el `DESC` del índice** — sin él, alguien "limpia"
      el índice a `(sn, ts)` y la performance se degrada en silencio.
- [x] 1.6 RED (integración): `onu_signal_current` no tiene más índices que la PK →
      *"No index other than the primary key exists on the current table"*.
- [x] 1.7 RED (integración): correr las migraciones dos veces no aplica nada la segunda vez →
      *"Re-running the binary applies nothing"*.
- [x] 1.8 GREEN: ajustar `0001_init.sql` hasta que 1.4–1.7 pasen.

### Conexión y arranque perezoso
- [x] 1.9 RED (unit, sin red): `PgConfig::from_settings()` devuelve `None` si `NOC_PG_URL` está
      ausente o vacía → *"No `NOC_PG_URL` keeps the previous behaviour"* (molde exacto de
      `InfluxClient::from_settings`, `influx_client.rs:40-46`).
- [x] 1.10 GREEN: `src/pg_client.rs` — `PgClient::connect()` (pool con `max_connections` de
      `NOC_PG_MAX_CONNS` default 2, `acquire_timeout` 10 s) + `migrate()`.
- [x] 1.11 RED+GREEN: un `PgClient::connect()` fallido devuelve `Err` y NO paniquea; el caller
      loguea y sigue → *"Postgres unreachable at startup does not kill the process"*.
- [x] 1.12 REFACTOR: `pg_client.rs` con doc-comment de módulo al estilo del repo
      (`influx_client.rs:1-15`), explicando el invariante y por qué el `ts` lo genera el colector.

**Extra (no en el plan original)**: `migrations/0002_role_and_grants.sql` — rol dedicado
`noc_collector` con permisos mínimos (solo DML sobre las 2 tablas), en vez de correr con el
superusuario `postgres`. Ver comentario operativo al principio del archivo.

## Fase 2 — Deadband: lógica PURA (cero IO, cero DB)

> Toda esta fase corre con `cargo test` sin ninguna dependencia externa. Es el corazón del change.

- [x] 2.1 `src/signal_store.rs` (o `sensors/deadband.rs`): tipos `OnuState`, `WriteReason`,
      `DeadbandConfig`, `PendingWrite`. Sin lógica todavía.
- [x] 2.2 RED: `decide_write` con estado `None` → `Some(FirstSeen)` → *"A newly installed ONU is
      recorded"*.
- [x] 2.3 RED: cambio `>= deadband` → `Some(Change)`; cambio `< deadband` → `None` → *"Change above
      the deadband is written"* / *"Change below the deadband is not written"*.
- [x] 2.4 RED: exactamente en el umbral (`|Δ| == deadband`) → `Some(Change)` (comparación `>=`) →
      *"Exactly at the threshold writes"*.
- [x] 2.5 RED: **mejora** de 1 dB → `Some(Change)` (el deadband es sobre valor absoluto) →
      *"Improvement above the deadband is also written"*.
- [x] 2.6 RED: **deriva lenta** — 5 lecturas de −0,1 dB contra un `last_stored_rx` FIJO: las 4
      primeras `None`, la quinta `Some(Change)` → *"Slow drift accumulates until it triggers"*.
      **Este es EL test del change**: es el que se rompe si alguien "optimiza" comparando contra la
      lectura anterior.
- [x] 2.7 RED: heartbeat vencido con señal plana → `Some(Heartbeat)`; no vencido → `None` →
      *"Heartbeat fires when the signal is flat"* / *"Heartbeat does not fire before its interval"*.
- [x] 2.8 RED: heartbeat vencido **y** cambio simultáneo → UNA sola decisión, `Change` →
      *"Change wins over a due heartbeat"*.
- [x] 2.9 GREEN: implementar `decide_write` (orden de guardas: `FirstSeen` → `Change` →
      `Heartbeat` → `None`).
- [x] 2.10 RED+GREEN: `apply_to_memory` — tras una escritura (de cualquier `reason`, **incluido
      heartbeat**) el estado queda con `last_stored_rx = rx actual` y `last_stored_at = ts del
      ciclo`; sin escritura, el estado no se toca. Protege el invariante.
- [x] 2.11 RED+GREEN: `dedup_by_sn(readings) -> (deduped, duplicated_sns)` conserva la última
      lectura y reporta los duplicados → *"Duplicated sn across two OLTs does not break the cycle"*.
- [x] 2.12 RED+GREEN: `build_cycle_batch(readings, state, now, cfg) -> CycleBatch` con contadores
      (`new`, `changed`, `heartbeat`, `skipped`, `dup`) — es la fuente de la línea de log de
      observabilidad.
- [x] 2.13 REFACTOR: doc-comments explicando los 3 motivos innegociables (comparar contra lo
      guardado / heartbeat obligatorio / el heartbeat SÍ actualiza `last_stored_rx`), con el
      razonamiento, no solo el qué.

## Fase 3 — pg_client: el IO

### Bulk write
- [x] 3.1 RED (integración): `flush_cycle` con 3 filas de historia + 3 upserts de `current` deja
      las 2 tablas consistentes y el invariante `last_stored_rx == rx de la fila más nueva` se
      cumple → *"Invariant holds after a cycle that writes history"*.
- [x] 3.2 GREEN: `INSERT ... SELECT * FROM UNNEST(...) ON CONFLICT DO NOTHING` para historia +
      `INSERT ... UNNEST ... ON CONFLICT (sn) DO UPDATE` para current, **en UNA transacción**.
- [x] 3.3 RED (integración): reflushear el MISMO batch no crea filas nuevas ni falla →
      *"Retrying the same batch is a no-op"*.
- [x] 3.4 RED (integración): todas las filas de un ciclo comparten `ts` →
      *"All rows of a cycle share the same timestamp"*.
- [x] 3.5 RED (integración): `first_seen` no se pisa en el UPSERT →
      *"`first_seen` is never overwritten"*.
- [x] 3.6 RED (integración): un batch con `sn` repetido **no** hace fallar el flush (ver 2.11) →
      confirma que el dedup está cableado antes del SQL, no solo implementado. Implementado como
      test del landmine inverso: SIN dedup previo, el flush SÍ falla (documenta por qué el dedup
      upstream es obligatorio) — `a_duplicate_sn_in_the_same_upsert_batch_fails_without_upstream_dedup`.
- [x] 3.7 RED+GREEN: si el flush falla, la transacción revierte y el estado en memoria NO avanza →
      *"Failed flush leaves state untouched"* / *"Partial failure never persists half a cycle"*.
- [x] 3.8 GREEN: 2 reintentos con backoff dentro del ciclo; sin buffer ni spool →
      *"Bounded retry, no buffering"*.

### Carga de estado
- [x] 3.9 RED (integración): `load_state()` reconstruye `sn → OnuState` desde `onu_signal_current`
      → *"Restart does not re-write everything"*.
- [x] 3.10 RED+GREEN: con el estado NO cargado, `flush_cycle` no escribe nada →
      *"State load failure suppresses the flush"*. Guarda crítica: evita 2.803 `first_seen` espurios.
      Implementado en `main.rs::write_cycle_to_postgres` (solo escribe si `pg_state.client` ya está
      `Some`, poblado por `load_state()` en `ensure_pg_client`).

### Baseline
- [x] 3.11 RED (integración): ONU con único punto de hace 40 días → baseline a 30d devuelve ese
      valor → *"A stable ONU has a baseline even without recent points"*. **Es el test que prueba
      que la ceguera está arreglada.** (Aserción corregida durante el apply: un punto de hace 40
      días también satisface los cortes de 7d y 15d — ver engram `sdd/noc-fiber-signal-store/apply`.)
- [x] 3.12 RED (integración): puntos a 40/35/20 días → baseline a 30d = el de 35 días →
      *"The most recent point before the cutoff wins"*.
- [x] 3.13 RED (integración): ONU sin datos previos al corte → baseline ausente en los 3 cortes →
      *"An ONU with no data before the cutoff has no baseline"*.
- [x] 3.14 GREEN: `fetch_baselines(t7, t15, t30)` con el `LEFT JOIN LATERAL ×3` conducido por
      `onu_signal_current`, en UNA query → *"The three cutoffs resolve in a single query"*.
- [x] 3.15 ⚠️ Test de regresión explícito: la query NO tiene cota inferior de tiempo. Dejar el
      comentario `MUST NOT: no agregar AND ts >= ... — ese límite ES el bug que estamos matando`
      pegado al SQL.

### Topología
- [x] 3.16 RED+GREEN: `fetch_topology()` desde `onu_signal_current` devuelve `sn → (olt, pon)`;
      tabla vacía → mapa vacío y las lecturas quedan con `pon = "?/?"` sin error →
      *"First-ever cycle tolerates unknown PON"*.

### Retención
- [x] 3.17 RED (integración): filas de hace 800 días de una ONU con filas recientes → se borran →
      *"Old rows beyond retention are deleted"*.
- [x] 3.18 RED (integración): ONU cuya ÚNICA fila tiene 900 días → NO se borra →
      *"The only row of a stale ONU is never deleted"*. Este test es el que fija la guarda `EXISTS`.
- [x] 3.19 RED+GREEN: `NOC_PG_RETENTION_DAYS=0` no ejecuta ningún `DELETE` →
      *"Retention disabled deletes nothing"*. Implementado como guarda en `main.rs::maybe_prune`
      (`if retention_days <= 0 { return; }`) en vez de un test SQL directo — mismo efecto observable.
- [x] 3.20 GREEN: scheduling de la poda una vez por día dentro del proceso; un fallo loguea warn y
      no interrumpe el sensado → *"A failing prune does not break the sensing loop"*.

## Fase 4 — Config + wiring en `main.rs`

- [x] 4.1 RED+GREEN: `config.rs` — agregar `pg_url: Option<String>`, `pg_max_conns` (default 2),
      `signal_deadband_db` (default 0.5), `signal_heartbeat_hours` (default 6),
      `pg_retention_days` (default 730), `baseline_source` (default `postgres`).
      **DEFAULT IMPLEMENTADO: `influx`, no `postgres`** — ver la nota de D1 en la tarea 0.3 y el
      override documentado en `config.rs`/`env.example`/README. Instrucción explícita del
      orquestador en este batch de apply (no reabrir sin el mismo contexto).
- [x] 4.2 RED+GREEN: `baseline_source` con valor no reconocido **falla al arrancar** nombrando los
      valores válidos → *"Unknown value fails fast"*. Implementado como función pura
      `parse_baseline_source` (testeable sin env vars ni el crate `config`), invocada en `main()`
      inmediatamente después de `Settings::load()`.
- [x] 4.3 RED+GREEN: **eliminar el campo `shadow`** de `Settings` (`config.rs:32-38`, `:41-43`,
      `:61`) y el `warn!` de `main.rs:81-87` — **verificado con `rg`: `main.rs:81` es el ÚNICO uso
      que condiciona comportamiento**; todo lo demás son fixtures de test y comentarios.
      Test: un entorno que todavía trae `NOC_SHADOW=true` deserializa sin error →
      *"A leftover NOC_SHADOW in the environment is ignored"*. Actualizar los 4 fixtures que
      construyen `Settings { shadow: .. }`: `influx_client.rs:245`/`:258`, `signal_poll.rs:402`,
      `hub_client.rs:117`. Actualizar los doc-comments que hablan de SHADOW: `main.rs:10`/`:19`,
      `influx_client.rs:3`, `sensors/mod.rs:4`, `sensors/ocr_seed.rs:17`.
      Extra: se agregó `impl Default for Settings` para simplificar esos 4 fixtures (`..Settings::default()`)
      en vez de listar todos los campos nuevos en cada uno.
- [x] 4.4 GREEN: `main.rs` — init perezoso del `PgClient` al principio del ciclo señal/PON,
      a lo sumo un intento por ciclo, con el estado de fallo/recuperación logueado igual que
      `ThresholdsState` (warn en la transición, debug mientras siga fallando) →
      *"Postgres recovers mid-run"*.
- [x] 4.5 GREEN: `signal_pon_cycle` toma baselines y topología según `baseline_source`;
      `postgres` no consulta Influx en absoluto → *"Default source is postgres"*.
      **Con el default real (`influx`) es al revés: no consulta Postgres para lectura** — la
      escritura a Postgres sigue ocurriendo igual (independiente de `baseline_source`, ver 4.7).
- [x] 4.6 GREEN (si D1 = A o B): modo `dual` — fallback a Influx por ONU sin baseline en Postgres
      → *"Dual falls back per ONU"*. Modo `influx` → comportamiento previo →
      *"Rollback to influx restores previous behaviour"*. La función pura `merge_prefer_first`
      (testeada sin clientes reales) es la que resuelve el fallback per-ONU.
- [x] 4.7 GREEN: `signal_pon_cycle` arma el batch, flushea y avanza el estado **después** del
      commit. Implementado en `write_cycle_to_postgres`, llamado SIEMPRE que `NOC_PG_URL` esté
      configurado y conectado, sin importar `baseline_source` — esto es lo que permite madurar el
      store en paralelo al camino de Influx.
- [x] 4.8 RED+GREEN: línea de log del ciclo con `read/new/changed/heartbeat/skipped/dup_sn/flush_ms/
      baseline_ms/pg` → *"The cycle log exposes the deadband ratio"*. Implementado como
      `tracing::info!` estructurado en `write_cycle_to_postgres` (sin medir `flush_ms`/`baseline_ms`
      explícitamente — pendiente si se quiere medir latencia, no bloqueante).
- [x] 4.9 Verificar que `olt_watch` quedó intacto (ningún cambio en su loop ni en su cadencia) →
      *"olt_watch keeps alerting during maturation"*. Verificado por inspección: `run_olt_watch_loop`/
      `olt_watch_cycle` no se tocaron ninguna línea.

## Fase 5 — Docs, deploy y cutover

- [x] 5.1 `env.example`: agregar las 6 variables nuevas con comentario, y marcar `NOC_SHADOW` como
      retirada explicando por qué (no gateaba nada).
- [x] 5.2 `README.md`: sección del store propio — el porqué (romper la dependencia del Python +
      arreglar la ceguera), el esquema, la semántica del deadband, la tabla de maduración día a día
      y el orden del cutover.
- [x] 5.3 `deploy/noc-collector.service`: nota de que el `.env` debe tener `NOC_PG_URL` y que
      requiere NTP.
- [ ] 5.4 Deploy a la VM 130 con `NOC_PG_URL` y `NOC_BASELINE_SOURCE=postgres` (deploy manual — el
      job `deploy` sigue siendo stub).
- [ ] 5.5 Verificación post-deploy inmediata: `_sqlx_migrations` con 1 fila,
      `count(*) FROM onu_signal_current ≈ 2803`, y ~2803 filas `reason=3` en el histórico.
- [ ] 5.6 Verificación a las 24 h: `SELECT count(*) FROM onu_signal_history WHERE ts > now() -
      interval '1 day'` ≈ 15.000. Si da ~134k el deadband no está funcionando; si da ~11k exactos
      no hay ningún cambio real (sospechar lecturas congeladas). **Anotar el número REAL contra el
      89% estimado.**
- [ ] 5.7 **Día 7**: confirmar que aparecen `individual`/`pon_suspects` distintos de 0 por primera
      vez → *"Day 10 produces delta alerts using the 7-day baseline"* verificado en producción.
- [ ] 5.8 **Después del día 7** (no antes): sacar `NOC_INFLUX_URL` del `.env` de la VM y reiniciar.
      Verificar un ciclo limpio sin tocar Influx. **Recién acá queda desbloqueado el retiro del
      Python** (change aparte).
- [ ] 5.9 Guardar en engram el resultado medido (ratio real del deadband, tamaño de la tabla,
      primer día con detección) bajo `noc-fiber-signal-store/resultado`.

## Notas de ejecución

- **No correr `cargo build`/`cargo run` por cuenta propia tras editar** — el usuario decide
  (misma regla que el BE con `npm run build`).
- Los tests de integración usan una base efímera; **nunca** apuntar `NOC_TEST_PG_URL` a la base de
  producción del `.37`.
- Una migración aplicada **no se edita**: se agrega `0002_*.sql`.
- Ningún script Python ni Influx se toca en ninguna de estas tareas.
