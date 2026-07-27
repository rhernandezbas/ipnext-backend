# Design: Base propia Postgres para el histórico de señal de fibra

> Base: `proposal.md` + engram `noc-fiber-signal-store/decisiones` (decisiones del usuario, **no se
> reabren**) + `noc-alerts-hub/rust-collector-deployed` + `smartolt/api-rate-limits`.
> Citas `archivo:línea` = worktree actual de `ipnext-noc-collector` (branch `feat/sensors`).
> Este documento **aterriza** las decisiones tomadas y **abre explícitamente** las 3 que faltan
> (§Decisiones abiertas).

## Technical Approach

El colector gana un **store propio** (Postgres en EasyPanel del `.37`) y deja de leer el InfluxDB
que llena el Python. Tres piezas:

```
                       VM 130 (10.75.0.40)                      .37 (EasyPanel)
  ┌────────────────────────────────────────────────┐        ┌──────────────────────┐
  │  ciclo señal/PON (30 min)                      │        │  Postgres noc_fiber  │
  │                                                │        │                      │
  │  SmartOLT ──► readings[2803]                   │        │  onu_signal_current  │
  │                    │                           │        │   (2803 filas fijas) │
  │                    ▼                           │        │                      │
  │        ┌──── decide_write() ────┐  (PURA)      │        │  onu_signal_history  │
  │        │  vs last_stored_rx     │              │        │   (append-only)      │
  │        │  + heartbeat + nueva   │              │        │                      │
  │        └───────────┬────────────┘              │        └──────────┬───────────┘
  │                    │ batch (change|hb|first)   │                   │
  │                    ▼                           │  1 TX / ciclo     │
  │              pg_client.flush_cycle() ──────────┼───────────────────┤
  │                                                │                   │
  │              pg_client.fetch_baselines() ◄─────┼───────────────────┘
  │                    │  (LATERAL ×3, "último valor antes de X")
  │                    ▼
  │        pon_analysis::analyze()  (SIN CAMBIOS)
  └────────────────────────────────────────────────┘
```

La lógica de decisión es **pura y sin IO** (mismo criterio que `sensors/pon_analysis.rs:13-14`:
"Este módulo es lógica PURA... No hace IO — eso es responsabilidad del caller"). Todo lo que toca
la red vive en `pg_client.rs`. Eso es lo que hace posible el TDD estricto sin depender de tener
una base levantada.

## Architecture Decisions

### Decision: Esquema de 2 tablas, sin surrogate key, con la unicidad como índice de baseline

```sql
-- migrations/0001_init.sql

-- ─────────────────────────────────────────────────────────────────────────
-- Estado de AHORA. ~2803 filas FIJAS, UPSERT completo en cada ciclo.
-- No crece nunca. Es también:
--   (a) la prueba de vida por ONU (last_seen),
--   (b) la tabla conductora de la query de baseline (2803 probes, no 5M scans),
--   (c) la fuente de topología sn -> (olt, pon)  [reemplaza los tags de Influx],
--   (d) el estado que se recarga al arrancar el proceso (last_stored_rx/at).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE onu_signal_current (
    sn              text        PRIMARY KEY,
    rx              real        NOT NULL,          -- dBm de la última lectura
    olt             text        NOT NULL,
    pon             text        NOT NULL,
    last_seen       timestamptz NOT NULL,          -- último ciclo en que la ONU respondió
    last_stored_rx  real        NOT NULL,          -- rx de la fila MÁS NUEVA en history
    last_stored_at  timestamptz NOT NULL,          -- ts de esa fila
    first_seen      timestamptz NOT NULL
) WITH (
    fillfactor = 70,                               -- deja aire en la página -> HOT updates
    autovacuum_vacuum_scale_factor = 0.0,          -- 134k updates/día sobre 2803 filas:
    autovacuum_vacuum_threshold   = 1000           -- no esperar al 20% (=560), vacuumear seguido
);

COMMENT ON COLUMN onu_signal_current.last_stored_rx IS
  'INVARIANTE: == rx de la fila más nueva de onu_signal_history para este sn. '
  'Es el valor contra el que compara el deadband — NUNCA contra la lectura anterior.';

-- ─────────────────────────────────────────────────────────────────────────
-- Histórico append-only. SOLO cambios (deadband), heartbeats y altas.
-- Sin columna id: la unicidad (sn, ts) ya identifica la fila y el índice que
-- la impone es EXACTAMENTE el que necesita la query de baseline.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE onu_signal_history (
    sn      text        NOT NULL,
    ts      timestamptz NOT NULL,
    rx      real        NOT NULL,
    olt     text        NOT NULL,
    pon     text        NOT NULL,
    reason  smallint    NOT NULL CHECK (reason IN (1, 2, 3))
);

COMMENT ON COLUMN onu_signal_history.reason IS '1=change (superó el deadband)  2=heartbeat  3=first_seen (alta de la ONU)';

-- Un solo índice hace TRES trabajos:
--   1. impone la unicidad (sn, ts)  -> el flush es idempotente vía ON CONFLICT DO NOTHING
--   2. sirve ORDER BY sn ASC, ts DESC -> DISTINCT ON / LATERAL del baseline, sin sort
--   3. sirve el EXISTS de guarda de la poda
-- OJO: un índice (sn, ts) ASC NO sirve para ORDER BY sn ASC, ts DESC (el scan
-- hacia atrás da sn DESC, ts DESC). El DESC en el índice no es cosmético.
CREATE UNIQUE INDEX onu_signal_history_sn_ts_desc
    ON onu_signal_history (sn, ts DESC);

-- La poda barre por ts sobre una tabla append-only (ts perfectamente correlacionado
-- con el orden físico) -> BRIN: unos pocos KB en vez de ~180 MB/año de btree.
CREATE INDEX onu_signal_history_ts_brin
    ON onu_signal_history USING BRIN (ts) WITH (pages_per_range = 128);
```

**Por qué `real` (float4) y no `double precision` ni `numeric`.** Rx vive en `[-40, 0]` dBm con
resolución de 0,01 dB (SmartOLT devuelve `"-23.47 dBm"`, ya redondeado a 2 decimales por
`round2()`). float4 tiene ~7 dígitos significativos → error relativo ~1e-6, seis órdenes de
magnitud por debajo del deadband de 0,5 dB. Ahorra 4 B/fila en heap y 4 en índice sobre 5,5M
filas/año. `numeric` sería exacto pero es variable, más lento y no aporta nada acá.

**Por qué no hay surrogate `id`.** Ahorra 8 B/fila + un índice + una secuencia, y no se pierde
nada: nadie referencia una fila del histórico por id.

**Ancho real y crecimiento** (por si alguien duda del "es chico"):

| | bytes/fila | 5,5 M filas/año |
|---|---|---|
| heap (header 24 + sn ~17 + ts 8 + rx 4 + olt ~2 + pon ~5 + reason 2 + padding) | ~70 | ~385 MB |
| índice único `(sn, ts DESC)` | ~33 | ~180 MB |
| BRIN `(ts)` | — | ~1 MB |
| **total** | | **~570 MB/año** |

Palanca guardada para el día que moleste (**no se implementa ahora**): normalizar `sn` a un
`onu_id int` en `onu_signal_current` y guardar el int en history → −30% de tamaño. A 570 MB/año
no vale el join.

### Decision: la query de baseline — "último valor conocido ANTES de X", **sin ventana**

Esto es la corrección del bug de fondo. La forma canónica:

```sql
SELECT DISTINCT ON (sn) sn, rx, ts
FROM onu_signal_history
WHERE ts <= $1
ORDER BY sn, ts DESC;
```

La forma que se implementa (misma semántica, ~3 órdenes de magnitud más barata: 2803 probes de
índice en vez de recorrer 5M entradas, y las 3 ventanas en **un solo round-trip**):

```sql
SELECT c.sn,
       b7.rx  AS rx_7d,
       b15.rx AS rx_15d,
       b30.rx AS rx_30d
FROM onu_signal_current c
LEFT JOIN LATERAL (
    SELECT h.rx FROM onu_signal_history h
    WHERE h.sn = c.sn AND h.ts <= $1 ORDER BY h.ts DESC LIMIT 1
) b7 ON TRUE
LEFT JOIN LATERAL (
    SELECT h.rx FROM onu_signal_history h
    WHERE h.sn = c.sn AND h.ts <= $2 ORDER BY h.ts DESC LIMIT 1
) b15 ON TRUE
LEFT JOIN LATERAL (
    SELECT h.rx FROM onu_signal_history h
    WHERE h.sn = c.sn AND h.ts <= $3 ORDER BY h.ts DESC LIMIT 1
) b30 ON TRUE;
```

| Query vieja (Influx) | Query nueva (Postgres) |
|---|---|
| `MEDIAN(rx)` en `(now-N-1d, now-N+1d)` | último valor con `ts <= now-Nd` |
| **ventana de 2 días de ancho** → si no hay punto ahí adentro, devuelve NADA | sin ventana → devuelve algo mientras exista **cualquier** dato anterior a X |
| El seed envejece y se cae de la ventana (medido: 63/33/18 días → vacío) | Un dato viejo sigue siendo **la respuesta correcta**: si no cambió, no cambió |
| Sensible a huecos de muestreo | Inmune a huecos |

⚠️ **MUST NOT**: no agregar jamás un `AND h.ts >= X - interval 'M days'` "defensivo". Ese límite
inferior es exactamente el bug que estamos matando. Una ONU estable 200 días tiene su último dato
hace 200 días y ese ES su baseline correcto. (En la práctica el heartbeat garantiza un punto cada
6 h, pero la query no debe depender de eso.)

**Degradación desde cero, día a día** — vale la pena verla porque responde sola a la decisión D1:

| Día | `rx_30d` | `rx_15d` | `rx_7d` | `compute_delta` (`b30 ?? b15 ?? b7`, `pon_analysis.rs:47-52`) |
|---|---|---|---|---|
| 0–6 | ∅ | ∅ | ∅ | sin baseline → sin alertas de delta (igual que HOY) |
| 7–14 | ∅ | ∅ | ✅ | **detección viva** con ventana de 7 días |
| 15–29 | ∅ | ✅ | ✅ | mejor |
| 30+ | ✅ | ✅ | ✅ | régimen completo |

Y `olt_watch` (LOS / power-fail / uptime / categoría Critical-Warning, cada 5 min) **no usa
baseline y sigue alertando todos esos días**. La "ceguera" del período de maduración es
estrictamente la del análisis de delta — que hoy ya está ciego, medido.

### Decision: topología `sn → (olt, pon)` desde `onu_signal_current`, no desde Influx

Hoy `main.rs:185` la saca de `InfluxClient::fetch_topology()`. Es la **última** atadura real con
el Python. Alternativas evaluadas:

| Fuente | Costo API SmartOLT | Veredicto |
|---|---|---|
| Tags de Influx (hoy) | 0 | ❌ es la dependencia que este change viene a matar |
| `onu/get_all_onus_details` | **15 calls/hora de límite** — lo usa el Python cada 6 h | ❌ presupuesto durísimo (engram `smartolt/api-rate-limits`) |
| `onu/get_onus_statuses` (ya devuelve `pon`, ver `signal_poll.rs::OnuStatusRow`) | +4 calls/ciclo = +8/hora | 🟡 viable, pero innecesario |
| **`onu_signal_current` (nuestra tabla)** | **0** | ✅ **elegida** |

`onu_signal_current` guarda `olt` y `pon` por ONU y se refresca en cada ciclo. Se lee junto con el
estado al arrancar y se refresca del propio upsert. La única ventana descubierta es el **primer
ciclo de la vida de la base**, donde la tabla está vacía → `pon = "?/?"`. Es inocuo: en ese mismo
ciclo tampoco hay baseline, así que `pon_analysis` no emite nada
(`pon_analysis.rs:301-312`: sin baseline la ONU queda fuera de las dos listas).

Para una ONU **nueva** (alta posterior) pasa lo mismo por un ciclo, con el mismo argumento: sin
baseline no participa del análisis. `olt` nunca falta — viene de la propia llamada a SmartOLT
(`main.rs:203`, el loop itera por `oid`).

### Decision: el deadband como función PURA + el invariante que lo sostiene

```rust
/// Estado por ONU que vive en memoria y se persiste en onu_signal_current.
pub struct OnuState {
    pub last_stored_rx: f64,
    pub last_stored_at: DateTime<Utc>,
    pub olt: String,
    pub pon: String,
}

pub enum WriteReason { Change = 1, Heartbeat = 2, FirstSeen = 3 }

pub struct DeadbandConfig {
    pub deadband_db: f64,          // NOC_SIGNAL_DEADBAND_DB, default 0.5
    pub heartbeat: Duration,       // NOC_SIGNAL_HEARTBEAT_HOURS, default 6h
}

/// PURA. Sin IO, sin reloj propio (`now` entra por parámetro), sin logging.
pub fn decide_write(
    state: Option<&OnuState>,
    rx: f64,
    now: DateTime<Utc>,
    cfg: &DeadbandConfig,
) -> Option<WriteReason> {
    match state {
        None => Some(WriteReason::FirstSeen),
        Some(s) if (rx - s.last_stored_rx).abs() >= cfg.deadband_db => Some(WriteReason::Change),
        Some(s) if now - s.last_stored_at >= cfg.heartbeat => Some(WriteReason::Heartbeat),
        Some(_) => None,
    }
}
```

**El orden de las guardas importa**: `Change` gana sobre `Heartbeat`. Si una lectura supera el
deadband justo cuando vencía el heartbeat, se escribe **una** fila y se etiqueta como cambio — que
es la información valiosa.

**Los 3 detalles innegociables, y por qué cada uno**:

1. **Comparar contra `last_stored_rx` (lo GUARDADO), nunca contra la lectura anterior.**
   El argumento del usuario ("una degradación de 0,1 dB/día nunca dispara") es correcto, y hay una
   forma aún más fuerte de decirlo: comparar contra la lectura anterior **rompe el invariante de
   fidelidad**. Contra el último guardado, el store cumple en todo momento
   `|realidad − último_guardado| < deadband`. Contra la lectura anterior, el error acumula sin
   techo (0,1 dB/día × 20 días = 2 dB de mentira en el histórico) y entonces **el baseline sería
   falso**, que es peor que no detectar: sería detectar mal.

2. **Heartbeat obligatorio (~6 h).** Tres funciones, no una:
   (a) distingue "no cambió" de "dejó de reportar" en el histórico
   (`last_seen` lo cubre para el AHORA, pero no deja rastro consultable en el pasado);
   (b) da anclaje temporal a los gráficos/forenses;
   (c) — la que nadie ve venir — **es lo que hace segura la poda por tiempo**: garantiza que
   siempre existe una fila reciente por ONU, así que borrar todo lo anterior al corte nunca puede
   dejar a una ONU sin ningún dato. Sin heartbeat, una ONU estable 3 años perdería su único punto.

3. **El heartbeat SÍ actualiza `last_stored_rx`.** Escribe el `rx` actual (tiene que hacerlo: si
   escribiera el valor viejo, el histórico mentiría), y por lo tanto debe actualizar
   `last_stored_rx` para no romper el invariante `last_stored_rx == rx de la fila más nueva`.
   **Esto no debilita la detección de deriva lenta**: el heartbeat solo AGREGA escrituras, nunca
   suprime una — el chequeo `|rx − last_stored_rx| ≥ deadband` corre en cada ciclo igual, y la
   deriva de 0,1 dB/día queda registrada con granularidad de 6 h de todos modos.

**Invariante central** (lo que todo lo demás protege):

> `onu_signal_current.last_stored_rx / last_stored_at` == `rx / ts` de la fila **más nueva** de
> `onu_signal_history` para ese `sn`.

Se mantiene con: (a) una sola transacción por ciclo, (b) el estado en memoria se avanza **después**
del commit, jamás antes.

### Decision: un batch, una transacción, timestamp generado por el colector

```rust
// pseudo-código de flush_cycle
let cycle_ts = Utc::now();                    // UNO solo para todo el ciclo
let mut tx = pool.begin().await?;
insert_history_unnest(&mut tx, &to_write).await?;   // ON CONFLICT DO NOTHING
upsert_current_unnest(&mut tx, &all_readings).await?;
tx.commit().await?;
apply_to_memory(&mut state, &to_write, cycle_ts);   // ← recién ACÁ
```

```sql
-- history: un round-trip para las N filas del ciclo
INSERT INTO onu_signal_history (sn, ts, rx, olt, pon, reason)
SELECT * FROM UNNEST($1::text[], $2::timestamptz[], $3::real[],
                     $4::text[], $5::text[], $6::smallint[])
ON CONFLICT DO NOTHING;

-- current: las ~2803 filas, upsert completo
INSERT INTO onu_signal_current
    (sn, rx, olt, pon, last_seen, last_stored_rx, last_stored_at, first_seen)
SELECT * FROM UNNEST($1::text[], $2::real[], $3::text[], $4::text[],
                     $5::timestamptz[], $6::real[], $7::timestamptz[], $8::timestamptz[])
ON CONFLICT (sn) DO UPDATE SET
    rx             = EXCLUDED.rx,
    olt            = EXCLUDED.olt,
    pon            = EXCLUDED.pon,
    last_seen      = EXCLUDED.last_seen,
    last_stored_rx = EXCLUDED.last_stored_rx,
    last_stored_at = EXCLUDED.last_stored_at;
    -- first_seen NO se pisa
```

**Por qué `UNNEST` y no `COPY`.** `COPY` es más rápido pero **no soporta `ON CONFLICT`**, y la
idempotencia del flush vale más que unos milisegundos con lotes de ≤2803 filas. Un `UNNEST` de
2803 filas es un solo round-trip y termina en decenas de ms.

**Por qué `ON CONFLICT DO NOTHING` sin target.** Cubre cualquier violación de unicidad sin depender
de que la inferencia del arbiter matchee un índice con `DESC`. Simple y sin sorpresas.

**Por qué el `ts` lo genera el colector y no `now()` del servidor.** Tres razones, la tercera es la
que decide: (a) todas las filas del ciclo comparten un `ts` exacto → agrupación limpia; (b) la
lógica del heartbeat en memoria usa el mismo reloj que lo persistido; (c) **hace el flush
idempotente de verdad**: si la respuesta se pierde y se reintenta, las filas traen el mismo `ts`,
`ON CONFLICT DO NOTHING` las descarta y no queda basura duplicada. Con `now()` server-side cada
reintento crearía filas nuevas.
Contrapartida: depende del reloj de la VM 130 → **requisito operativo: NTP activo en VM 130**
(`timedatectl` en el checklist de deploy).

### Decision: dedup del batch por `sn` — el landmine

Postgres tira `ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time` si el mismo
`sn` aparece **dos veces en el mismo `INSERT ... ON CONFLICT DO UPDATE`**. El loop recorre 4 OLTs
(`main.rs:203`) y arma `readings` concatenando; si una ONU migró de OLT y SmartOLT la reporta en
las dos (o si hay un serial repetido), el ciclo entero **revienta**, no una fila.

⇒ El batch se **deduplica por `sn` antes de flushear**, quedándose con la última lectura y logueando
un warn con los `sn` duplicados. Es una guarda de una línea que evita perder ciclos completos.

### Decision: comportamiento ante fallo de red / PG caído — **el diseño es auto-sanador**

| Momento | Comportamiento |
|---|---|
| **Arranque**, PG inalcanzable | El proceso **no muere** (mismo criterio que `main.rs:165-167`). Init perezoso: se reintenta connect+migrate+load al principio de cada ciclo, a lo sumo una vez por ciclo. Mientras tanto, el path de PG está apagado y `olt_watch` sigue funcionando normal. |
| **Estado no cargado** pero PG vivo | **No se flushea nada.** Escribir con estado vacío generaría un snapshot completo espurio (`first_seen` ×2803) que ensucia el histórico. |
| **Flush falla** (timeout, corte, PG cae a mitad) | Se descarta el ciclo: warn + métrica. La transacción o commiteó entera o no commiteó nada. **El estado en memoria NO avanza.** |
| **Ciclo siguiente** | Como `last_stored_rx` quedó donde estaba, cualquier cambio que hubiera ocurrido en el ciclo perdido **se sigue detectando y se escribe ahora**. Solo se pierde resolución temporal (30 min), nunca el evento. |

Por eso **no hace falta buffer en memoria ni spool en disco**: el deadband ya es un mecanismo de
"pendiente por escribir". Un buffer solo recuperaría el timestamp exacto de un cambio dentro de una
ventana de 30 min — no vale la complejidad ni el riesgo de OOM. Se agregan **2 reintentos con
backoff** dentro del mismo ciclo y nada más.

Consecuencia deseable: una caída de PG de 2 horas cuesta 4 ciclos de resolución y **cero eventos**.

### Decision: retención — 24 meses de detalle crudo, podado por el propio colector

| Opción | Volumen a 24 m | Complejidad | Veredicto |
|---|---|---|---|
| Sin retención | crece ~570 MB/año, indefinido | 0 | ❌ deuda garantizada |
| **24 m crudo + poda diaria** | ~11 M filas / ~1,15 GB | baja | ✅ **recomendada** |
| 6 m crudo + rollup diario (min/max/avg/last por sn/día) | ~290 MB + ~1 M filas/año de rollup | media (2ª tabla + job + 2 caminos de lectura) | 🟡 solo si el `.37` está apretado de disco |
| Particionado mensual + `DROP PARTITION` | igual | media-alta (hay que crear particiones futuras) | 🟡 recién arriba de ~50 M filas |

Se recomienda la 2: a 5,5 M filas/año, Postgres ni se despeina, y ni el rollup ni el particionado
compran nada real hoy. Se documenta el umbral de reevaluación: **si `onu_signal_history` supera
50 M filas o 5 GB, migrar a particionado mensual.**

Poda: la corre **el propio colector**, una vez por día (no hace falta cron en el `.37`), con guarda
de seguridad:

```sql
DELETE FROM onu_signal_history h
WHERE h.ts < $1                                  -- now() - NOC_PG_RETENTION_DAYS
  AND EXISTS (                                   -- ← NUNCA dejar una ONU sin ningún dato
      SELECT 1 FROM onu_signal_history n
      WHERE n.sn = h.sn AND n.ts >= $1
  );
```

El `EXISTS` es un probe sobre el índice `(sn, ts DESC)` (barato) y hace la poda **correcta incluso
si alguien apaga el heartbeat**. `NOC_PG_RETENTION_DAYS = 0` desactiva la poda.

### Decision: `NOC_SHADOW` se **retira** (verificado: hoy no gatea nada)

`main.rs:81-87` es el **único** uso de `settings.shadow`: un `warn!` si viene en `false`. No
condiciona ninguna escritura — el read-only de Influx es una propiedad del código
(`influx_client.rs:1-2`), no del flag. Es config muerta con nombre engañoso.

Redefinirlo ("shadow = no escribo a Influx pero sí a mi Postgres") sería seguir cargando un
booleano cuyo significado ya derivó dos veces. Se reemplaza por switches **ortogonales y
explícitos**:

| Antes | Ahora |
|---|---|
| `NOC_SHADOW=true` (no hacía nada) | *(eliminado)* |
| — | `NOC_PG_URL` presente/ausente → el path de Postgres existe o no |
| `NOC_INFLUX_URL` presente/ausente | igual, pero ahora **opcional de verdad** |
| — | `NOC_BASELINE_SOURCE` = `postgres` \| `influx` \| `dual` → quién alimenta a `pon_analysis` |

Quitar el campo del struct es **seguro aunque la env var siga en el `.env` de la VM**: `config`
deserializa con serde sin `deny_unknown_fields`, así que una var de más se ignora. No requiere
tocar la VM antes de deployar.

### Decision: crate de acceso a Postgres — `sqlx`

| | `sqlx` 0.8 | `tokio-postgres` (+ `deadpool-postgres`) |
|---|---|---|
| Pool | incluido | dep extra |
| **Migraciones versionadas** | **`sqlx::migrate!` incluido**: `.sql` embebidos en el binario, tabla `_sqlx_migrations` con checksums, corren en TX al arrancar | **no existe** → hay que escribirlo a mano (tabla `schema_version` + `include_str!` + match) = reimplementar esto mismo, peor |
| Bulk insert | `UNNEST` con `Vec<T>` bindeado nativo a arrays | idem, o `COPY` binario (más rápido, sin `ON CONFLICT`) |
| TLS | `tls-rustls` — alineado con el `reqwest` rustls que ya usa el repo | `tokio-postgres-rustls`, dep extra |
| Costo de compilación | mayor | menor |
| Macros con chequeo en compile-time | opcionales — **NO se usan** (requieren DB o metadata offline en CI); se usa la API runtime `query()`/`query_as()` | n/a |

**Elegido `sqlx`** y el argumento decisivo es el que planteó el propio brief: *"el colector NO tiene
un framework de migraciones — proponé algo simple y reproducible"*. `sqlx::migrate!` **es**
exactamente eso, ya escrito y probado, sin herramienta externa, sin paso manual de `psql`, sin
`kubectl exec`. Con `tokio-postgres` habría que construirlo.

```toml
sqlx = { version = "0.8", default-features = false, features = [
    "runtime-tokio", "tls-rustls", "postgres", "migrate", "chrono", "macros"
] }
```
(`macros` solo por `sqlx::migrate!`; **no** se usan `query!`/`query_as!` → no hay `DATABASE_URL` en
build time ni `.sqlx/` que mantener.)

### Decision: cómo se crea y versiona el esquema

```
ipnext-noc-collector/
└── migrations/
    └── 0001_init.sql        ← versionado en git, embebido en el binario
```

Al arrancar (y en cada reintento de init perezoso):

```rust
let pool = PgPoolOptions::new().max_connections(cfg.pg_max_conns)
    .acquire_timeout(Duration::from_secs(10))
    .connect(&cfg.pg_url).await?;
sqlx::migrate!("./migrations").run(&pool).await?;   // idempotente, transaccional, checksummeada
```

Propiedades que compran esto: reproducible desde cero (`DROP DATABASE` + arrancar el binario),
idempotente (re-arrancar no hace nada), auditable en git, y **detecta si alguien editó una
migración ya aplicada** (checksum mismatch → error explícito en vez de deriva silenciosa).
Regla operativa: **una migración aplicada nunca se edita**, se agrega `0002_*.sql`.

## Nuevas variables de entorno

| Var | Default | Qué hace |
|---|---|---|
| `NOC_PG_URL` | *(ninguno)* | `postgres://noc:***@<host .37>:5432/noc_fiber?sslmode=require`. **Ausente ⇒ el path de Postgres queda apagado por completo** (el colector corre como hoy). |
| `NOC_PG_MAX_CONNS` | `2` | Un writer + un reader alcanza. |
| `NOC_SIGNAL_DEADBAND_DB` | `0.5` | Umbral de cambio en dB. Debajo de ~0,3 dB es ruido de medición; el análisis busca 1,5–2 dB. |
| `NOC_SIGNAL_HEARTBEAT_HOURS` | `6` | Cada cuánto se escribe aunque no cambie. **Es el 75% del volumen** (ver tabla en `proposal.md`). |
| `NOC_PG_RETENTION_DAYS` | `730` | `0` = no podar. |
| `NOC_BASELINE_SOURCE` | `postgres` | `postgres` \| `influx` \| `dual` (ver D1). |
| ~~`NOC_SHADOW`~~ | — | **retirada** (no gateaba nada). Puede quedar en el `.env`, se ignora. |

Nota para el futuro: mover `deadband`/`heartbeat` a `GET /api/alerts/thresholds` sería consistente
con cómo se editan los otros umbrales desde la UI, **pero** `config::Thresholds` no tiene
`#[serde(default)]` en ningún campo (`config.rs:72-85`) → hoy es un struct rígido: agregarle campos
lo rompe contra un hub viejo. Si se hace, va con `#[serde(default)]`. Fuera de scope acá.

## Observabilidad

Una línea por ciclo, que hace auditable todo el mecanismo y permite **medir** el ahorro real contra
el 89% estimado:

```
INFO ciclo señal/PON: read=2803 new=0 changed=71 heartbeat=468 skipped=2264
     dup_sn=0 flush_ms=143 baseline_ms=38 pg=ok
```

Chequeo de sanidad operativo, una vez por semana:
`SELECT count(*) FROM onu_signal_history WHERE ts > now() - interval '1 day';` → debe estabilizarse
en ~15k. Si da ~134k, el deadband no está funcionando; si da ~11k constante, no hay cambios reales
(sospechar de lecturas congeladas).

## Plan de cutover (el orden importa)

| # | Paso | Quién | Verificación |
|---|---|---|---|
| 0 | Crear servicio Postgres en EasyPanel `.37`, DB `noc_fiber`, rol dedicado, alcanzable desde `10.75.0.40` | **usuario** (bloqueante) | `psql` desde la VM 130 conecta |
| 1 | Deploy del binario con `NOC_PG_URL` seteado y `NOC_BASELINE_SOURCE=postgres` | asistente | migraciones aplicadas; `_sqlx_migrations` tiene 1 fila |
| 2 | Ciclo 1: se escribe el snapshot completo (~2803 filas `reason=3`) | — | `count(*) FROM onu_signal_current = ~2803` |
| 3 | Días 1–6: madura. `pon_analysis` sin baseline (igual que hoy). `olt_watch` **alerta normal** | — | filas/día tendiendo a ~15k |
| 4 | **Día 7**: `rx_7d` empieza a resolver → detección de delta VIVA por primera vez | — | log con `individual`/`pon_suspects` ya no siempre 0 |
| 5 | Día 30: régimen completo 7/15/30 | — | — |
| 6 | **Sacar `NOC_INFLUX_URL` del `.env`** + restart | asistente | un ciclo limpio sin tocar Influx |
| 7 | *(change aparte)* jubilar `onu_signal_poll.py` / `fibra_report.py` / Influx | — | fuera de scope |

El paso 6 va **antes** que el 7 y nunca al revés: hasta que el colector no deje de leer Influx, el
Python no se puede apagar. Ese es literalmente el bloqueo que este change viene a levantar.

## Risks / Trade-offs

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Servicio EasyPanel no creado (bloqueante) | 🔴 alta | Acción del usuario. Todas las fases 1–4 se construyen y testean sin él (service container en CI). |
| Latencia / caída del link VM 130 → `.37` | 🟡 media | Diseño auto-sanador (§Decision fallo de red): se pierde resolución, no eventos. 2 reintentos + timeout de 10 s. |
| Reloj de la VM 130 desincronizado | 🟡 media | `ts` lo genera el colector → NTP es requisito operativo. Verificar `timedatectl` en el deploy. |
| Batch con `sn` duplicado revienta el ciclo entero | 🟡 media | Dedup por `sn` antes del flush + warn. Escenario cubierto por spec. |
| Bloat de `onu_signal_current` (134k updates/día sobre 2803 filas) | 🟢 baja | `fillfactor = 70` (habilita HOT updates: solo la PK indexa, ninguna columna actualizada está indexada) + autovacuum agresivo por tabla. |
| Crecimiento de `onu_signal_history` | 🟢 baja | Medido: ~570 MB/año. Retención 24 m + umbral documentado de reevaluación (50 M filas). |
| ONU nueva sin `last_stored_rx` | 🟢 baja | `WriteReason::FirstSeen`; queda fuera del análisis un ciclo por no tener baseline — comportamiento ya existente. |
| Reinicio del colector | 🟢 baja | El estado se recarga de `onu_signal_current` (una query de 2803 filas). Si falla, no se flushea (nunca se escribe con estado vacío). |
| Ceguera de delta durante 7 días | 🟢 baja | **Hoy ya está ciego** (medido). `olt_watch` no se ve afectado. Ver D1 si igual se quiere cubrir. |
| Credenciales de PG en el `.env` de la VM | 🟢 baja | Mismo tratamiento que los tokens actuales: `0600`, dueño = usuario del servicio. `sslmode=require`. |

## Decisiones abiertas — **requieren confirmación del usuario**

### D1 — ¿Modo dual, o Postgres puro desde el día 1?

El usuario eligió "arrancar de cero". La pregunta honesta es si conviene un puente temporal.

| Opción | A favor | En contra |
|---|---|---|
| **A. Postgres puro** (`NOC_BASELINE_SOURCE=postgres`) | Un solo camino de datos; corta la dependencia del Python **ya**; el código más simple posible. | 7 días sin detección de delta. |
| **B. Dual** (`postgres` con fallback a `influx` por ONU sin baseline) | Cubriría la maduración… | …**solo si Influx tuviera datos, y está medido que NO los tiene** (las 3 ventanas vienen vacías, engram `noc-alerts-hub/rust-collector-deployed`). Mantiene viva la atadura que el change viene a cortar, y agrega un camino de datos que hay que testear. |
| **C. Dual con query nueva sobre Influx** (portar el "último valor antes de X" a InfluxQL: `SELECT LAST(rx) ... WHERE time <= X GROUP BY sn`) | Esta **sí** daría baseline real desde el día 0 — el dato existe en Influx desde ~23/07, lo que está roto es la *query*, no la serie. | Es trabajo nuevo sobre el componente que estamos jubilando; cambia el criterio (median → last) en dos lugares a la vez. Alarga el cutover. |

**Recomendación: A.** Y el argumento no es "aguantemos 7 días": es que el costo real de la ceguera
es **cero incremental** — hoy el sistema ya no detecta nada, y `olt_watch` (LOS, power-fail,
uptime, señal crítica) sigue cubriendo todo lo urgente durante la maduración. La opción C es
tentadora y técnicamente correcta, pero invierte esfuerzo en Influx justo cuando lo estamos
sacando del camino.
Propuesta concreta: implementar `NOC_BASELINE_SOURCE` con las tres variantes **cableadas pero con
default `postgres`** — el modo `dual` (opción B) sale casi gratis porque `influx_client.rs` ya
existe y no se toca. Queda como escape hatch de una env var, sin promesa de que sirva.
**Confirmar: ¿A (recomendada), o se quiere que haga C?**

> **Corrección post-hoc (re-review adversarial de `feat/sensors`, G7) — el cutover real DEBE pasar
> por `dual`, NO ir directo a "A. Postgres puro".** La recomendación de arriba subestimó un efecto
> secundario de la opción A: en modo `postgres` puro, la topología `sn -> (olt, pon)` sale
> ÚNICAMENTE de `onu_signal_current` (`pg_client::fetch_topology`, que filtra `WHERE pon <> ''`) —
> y NADA en el código actual escribe el PON de una ONU ahí una vez que queda en blanco; el PON
> real ya viene en la respuesta de `sensors::signal_poll::get_onus_statuses` (`OnuStatusRow.pon`),
> pero ese campo no se persiste en el store propio. Una ONU cuya topología no resolvió en el
> primer ciclo (o que Influx tampoco tenía, ver el riesgo de abajo) queda con PON desconocido
> **PARA SIEMPRE** en modo `postgres` puro, mientras que en modo `dual` sigue resolviendo desde
> Influx mientras tanto. Orden correcto: cutover a `dual` primero, medir cuántas ONUs (si alguna)
> dependen del fallback a Influx para su PON, e implementar que el store propio escriba el PON
> desde `get_onus_statuses` ANTES de saltar a `postgres` puro.

### D2 — Retención

**Recomendación: 24 meses de detalle crudo** (`NOC_PG_RETENTION_DAYS=730`), poda diaria desde el
colector, sin rollups ni particiones. Techo ~11 M filas / ~1,15 GB, con el umbral de reevaluación
documentado (50 M filas o 5 GB → particionado mensual).
**Confirmar: ¿730 días está bien, o se prefiere 12 meses (~5,5 M / ~570 MB) o "no borrar nunca"?**
Dato para decidir: el análisis actual nunca mira más de 30 días atrás; los 24 meses son para
forensia y tendencia, no para el algoritmo.

### D3 — Crate

**Recomendación: `sqlx` 0.8** (API runtime, sin macros de query), por el runner de migraciones.
Alternativa `tokio-postgres` + `deadpool` si se prefiere el árbol de dependencias más chico y se
acepta escribir el migrador a mano.
**Confirmar: ¿`sqlx`?**
