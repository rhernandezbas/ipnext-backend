# Noc Fiber Signal Store Specification

## Purpose

Store propio del colector de fibra (`ipnext-noc-collector`, Rust, VM 130) para el histórico de
señal óptica de ONUs: un Postgres dedicado en EasyPanel del `.37` con dos tablas
(`onu_signal_current` + `onu_signal_history`), esquema versionado y migrado por el propio binario,
índices dimensionados para la query de baseline, y política de retención definida desde el día 1.

Reemplaza la lectura del InfluxDB que llena `onu_signal_poll.py` (Python). **No** migra datos
históricos (se arranca de cero, decisión del usuario) y **no** apaga ni toca ningún script Python,
Influx, ni el hub.

Esta capability cubre el **almacenamiento**. La política de escritura (deadband/heartbeat) está en
`noc-fiber-signal-deadband`; la lectura del baseline y la selección de fuente están en
`noc-fiber-baseline-source`.

## Requirements

### Requirement: Two-table schema with documented invariant

El sistema DEBE (MUST) persistir el estado y el histórico de señal en exactamente dos tablas:

- `onu_signal_current` — una fila por `sn` (PK `sn`), con `rx`, `olt`, `pon`, `last_seen`,
  `last_stored_rx`, `last_stored_at`, `first_seen`. Cantidad de filas ACOTADA por la cantidad de
  ONUs (~2.803); NO crece con el tiempo.
- `onu_signal_history` — append-only, con `sn`, `ts`, `rx`, `olt`, `pon`, `reason`
  (`1=change`, `2=heartbeat`, `3=first_seen`), sin columna surrogate `id`.

El sistema DEBE (MUST) mantener el invariante: `onu_signal_current.last_stored_rx` y
`.last_stored_at` son iguales al `rx` y al `ts` de la fila MÁS NUEVA de `onu_signal_history` para
ese `sn`.

Las columnas `rx` DEBEN (MUST) ser `real` (float4) y los timestamps `timestamptz`.

#### Scenario: Fresh database has both tables with the expected keys
- GIVEN una base `noc_fiber` vacía
- WHEN el colector arranca y aplica las migraciones
- THEN existen `onu_signal_current` (PK `sn`) y `onu_signal_history`, y el índice único
  `onu_signal_history (sn, ts DESC)`

#### Scenario: Invariant holds after a cycle that writes history
- GIVEN una ONU `sn=A1` sin filas previas
- WHEN se ejecuta un ciclo que escribe una fila de historia con `rx=-22.5` y `ts=T`
- THEN `onu_signal_current` para `A1` tiene `last_stored_rx = -22.5` y `last_stored_at = T`, y esa
  es la fila más nueva de `onu_signal_history` para `A1`

#### Scenario: `first_seen` is never overwritten
- GIVEN `onu_signal_current` tiene `sn=A1` con `first_seen=T0`
- WHEN un ciclo posterior en `T1 > T0` hace UPSERT de `A1`
- THEN `first_seen` sigue siendo `T0` y `last_seen` pasa a `T1`

### Requirement: Descending unique index serving uniqueness, baseline and prune

El sistema DEBE (MUST) crear el índice de `onu_signal_history` como
`CREATE UNIQUE INDEX ... ON onu_signal_history (sn, ts DESC)`.

El orden `DESC` NO es cosmético: un índice `(sn, ts)` ascendente NO satisface
`ORDER BY sn ASC, ts DESC` (el scan hacia atrás produce `sn DESC, ts DESC`), que es exactamente el
orden que necesitan la query de baseline y el `DISTINCT ON`. El sistema NO DEBE (MUST NOT) declarar
un `PRIMARY KEY (sn, ts)` adicional, que crearía un segundo índice ascendente redundante.

El sistema DEBE (MUST) además crear un índice BRIN sobre `ts` para el barrido de la poda
(`USING BRIN (ts)`), NO un btree — la tabla es append-only y `ts` está correlacionado con el orden
físico.

#### Scenario: Baseline query does not require a sort step
- GIVEN `onu_signal_history` con datos de varias ONUs
- WHEN se ejecuta `EXPLAIN` de la query de baseline (`LATERAL ... ORDER BY ts DESC LIMIT 1`)
- THEN el plan usa `onu_signal_history_sn_ts_desc` y NO contiene un nodo `Sort` sobre la historia

#### Scenario: Duplicate (sn, ts) is rejected by the index
- GIVEN existe una fila `(sn=A1, ts=T)`
- WHEN se intenta insertar otra fila `(sn=A1, ts=T)`
- THEN la unicidad la rechaza (y el flush, que usa `ON CONFLICT DO NOTHING`, la descarta sin error)

### Requirement: Versioned, embedded, idempotent migrations run by the collector

El sistema DEBE (MUST) versionar el esquema como archivos `.sql` numerados en `migrations/` del
repo `ipnext-noc-collector`, embebidos en el binario en tiempo de compilación, y ser CAPAZ de
aplicarlos al arrancar de forma idempotente y transaccional, registrando lo aplicado con su
checksum — sin depender de ninguna herramienta externa, paso manual de `psql`, ni acceso a la UI
de EasyPanel para crear o actualizar el esquema.

**Drift documentado post-F2 (review adversarial de `feat/sensors`):** en OPERACIÓN NORMAL, el
colector corre con `NOC_PG_RUN_MIGRATIONS=false` y el rol de permisos mínimos `noc_collector`
(`migrations/0002_role_and_grants.sql`), que NO tiene `CREATE` sobre el schema —
`sqlx::migrate!().run()` necesita ese privilegio para su propia tabla de control
(`_sqlx_migrations`, `CREATE TABLE IF NOT EXISTS`) INCLUSO cuando no hay ninguna migración nueva
que aplicar, así que correrlo con ese rol falla con "permission denied" en TODOS los ciclos. El
patrón operativo real es dos fases: (1) el PRIMER deploy (o cualquier migración nueva) corre con
`NOC_PG_URL` apuntando a un rol elevado y `run_migrations=true` (el default) — ahí SÍ se cumple
"el binario aplica las migraciones, sin paso manual"; (2) la operación normal después cambia
`NOC_PG_URL` al rol `noc_collector` con `run_migrations=false`. La capacidad ("el binario ES CAPAZ
de migrar solo, sin `psql`") se sostiene; lo que no es cierto en régimen normal es "el binario
SIEMPRE migra en cada arranque" — ver README de `ipnext-noc-collector`, sección "Rol dedicado".

Una migración ya aplicada NO DEBE (MUST NOT) editarse; los cambios van en un archivo nuevo con
número siguiente.

#### Scenario: Schema is reproducible from an empty database
- GIVEN una base sin ninguna tabla
- WHEN se ejecuta el binario con `run_migrations=true` (rol elevado, primer deploy)
- THEN el esquema completo queda creado y el proceso sigue a los loops normales

#### Scenario: Re-running the binary applies nothing
- GIVEN una base con todas las migraciones ya aplicadas
- WHEN el binario arranca otra vez con `run_migrations=true`
- THEN no se aplica ninguna migración y no se produce error

#### Scenario: Normal operation runs with migrations disabled under the restricted role
- GIVEN el esquema ya está migrado (fase 1 completada) y `NOC_PG_URL` apunta al rol
  `noc_collector` (sin `CREATE` sobre el schema)
- WHEN el colector arranca con `NOC_PG_RUN_MIGRATIONS=false`
- THEN conecta y opera normalmente (`load_state`, `flush_cycle`, `prune_history`) sin intentar
  `sqlx::migrate!().run()`, y sin ningún error de permisos

#### Scenario: Editing an already-applied migration is detected
- GIVEN la migración `0001_init.sql` ya está aplicada
- WHEN alguien edita ese archivo y se recompila y arranca el binario
- THEN el arranque falla con un error explícito de checksum (no queda una deriva silenciosa entre
  el archivo y la base)

### Requirement: Update-heavy `onu_signal_current` is tuned against bloat

Dado que `onu_signal_current` recibe ~134.000 UPDATEs por día sobre ~2.803 filas, el sistema DEBE
(MUST) declarar la tabla con `fillfactor = 70` (para habilitar HOT updates) y con autovacuum por
tabla más agresivo que el default (`autovacuum_vacuum_scale_factor = 0.0`,
`autovacuum_vacuum_threshold = 1000`).

El sistema NO DEBE (MUST NOT) indexar ninguna columna de `onu_signal_current` distinta de la PK
`sn` — cualquier índice adicional sobre una columna que se actualiza cada ciclo anularía los HOT
updates.

#### Scenario: No index other than the primary key exists on the current table
- GIVEN el esquema aplicado
- WHEN se listan los índices de `onu_signal_current`
- THEN solo existe el índice de la clave primaria

### Requirement: Retention policy with a safety guard

El sistema DEBE (MUST) podar `onu_signal_history` una vez por día, borrando las filas con
`ts` anterior a `now() - NOC_PG_RETENTION_DAYS`, con `NOC_PG_RETENTION_DAYS` configurable
(default `730`) y `0` = poda desactivada.

La poda NO DEBE (MUST NOT) poder dejar a una ONU sin ninguna fila en el histórico: el borrado DEBE
(MUST) incluir la guarda `AND EXISTS (SELECT 1 FROM onu_signal_history n WHERE n.sn = h.sn AND
n.ts >= <corte>)`. Esta guarda DEBE existir aunque el heartbeat garantice el mismo resultado — la
corrección de la poda no debe depender de que el heartbeat esté activo.

Un fallo de la poda NO DEBE (MUST NOT) interrumpir los ciclos de sensado.

#### Scenario: Old rows beyond retention are deleted
- GIVEN `NOC_PG_RETENTION_DAYS=730` y filas de hace 800 días para una ONU que también tiene filas
  recientes
- WHEN corre la poda diaria
- THEN las filas de hace 800 días se borran y las recientes quedan

#### Scenario: The only row of a stale ONU is never deleted
- GIVEN una ONU cuya ÚNICA fila en el histórico tiene `ts` de hace 900 días
- WHEN corre la poda con corte a 730 días
- THEN esa fila NO se borra (la guarda `EXISTS` no encuentra ninguna fila posterior al corte)

#### Scenario: Retention disabled deletes nothing
- GIVEN `NOC_PG_RETENTION_DAYS=0`
- WHEN llega la hora de la poda diaria
- THEN no se ejecuta ningún `DELETE`

#### Scenario: A failing prune does not break the sensing loop
- GIVEN la poda falla (timeout, permisos)
- WHEN termina el intento
- THEN se loguea un warning y el ciclo de señal/PON siguiente corre normalmente

### Requirement: Postgres path is entirely optional

Si `NOC_PG_URL` no está configurada, el sistema NO DEBE (MUST NOT) intentar conectarse, migrar ni
escribir, y DEBE (MUST) seguir corriendo sus loops con el comportamiento previo a este change.

Si `NOC_PG_URL` está configurada pero Postgres no responde, el proceso NO DEBE (MUST NOT) morir:
DEBE (MUST) reintentar la inicialización (conexión + migraciones + carga de estado) a lo sumo una
vez por ciclo, y mientras tanto operar con el path de Postgres apagado.

#### Scenario: No `NOC_PG_URL` keeps the previous behaviour
- GIVEN `NOC_PG_URL` ausente
- WHEN arranca el colector
- THEN no se intenta ninguna conexión a Postgres y los dos loops (señal/PON y olt_watch) corren
  como antes

#### Scenario: Postgres unreachable at startup does not kill the process
- GIVEN `NOC_PG_URL` apunta a un host inalcanzable
- WHEN arranca el colector
- THEN se loguea un error, el proceso sigue vivo, el loop `olt_watch` funciona normal, y en el
  ciclo siguiente se reintenta la inicialización

#### Scenario: Postgres recovers mid-run
- GIVEN el colector viene fallando la inicialización de Postgres desde hace 3 ciclos
- WHEN Postgres vuelve a estar disponible
- THEN el ciclo siguiente completa conexión + migraciones + carga de estado y empieza a escribir
