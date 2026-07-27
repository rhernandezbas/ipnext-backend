# Noc Fiber Signal Deadband Specification

## Purpose

Política de escritura del histórico de señal: en vez de persistir las ~2.803 ONUs en cada ciclo de
30 min (~134.500 filas/día), se escribe **solo cuando la señal cambia** respecto del último valor
GUARDADO, más un **heartbeat** periódico y el alta de cada ONU nueva (~15.000 filas/día, -89%).

Cubre también el estado en memoria que sostiene la decisión, su recarga al arrancar, la
atomicidad e idempotencia del flush, y la degradación ante fallos de red.

La lógica de decisión es **pura** (sin IO, sin reloj propio, sin logging), en el mismo espíritu que
`sensors::pon_analysis` — es lo que la hace testeable sin base de datos.

## Requirements

### Requirement: Write decision compares against the last STORED value

El sistema DEBE (MUST) decidir si escribe una fila de historia comparando la lectura actual contra
`last_stored_rx` (el `rx` de la fila más nueva ya persistida para esa ONU), y NO DEBE (MUST NOT)
compararla contra la lectura del ciclo anterior.

Se escribe si `|rx − last_stored_rx| >= NOC_SIGNAL_DEADBAND_DB` (default `0.5`).

Motivo (y es el que fija el requisito): comparar contra la lectura anterior deja pasar cualquier
degradación gradual — 0,1 dB/día durante 20 días no supera nunca el umbral en un solo paso — y
además rompe la fidelidad del store: el valor persistido derivaría sin techo respecto de la
realidad, con lo cual el baseline sería FALSO. Comparando contra lo guardado, el sistema garantiza
en todo momento `|realidad − último_guardado| < deadband`.

#### Scenario: Change above the deadband is written
- GIVEN `last_stored_rx = -22.0` y deadband `0.5`
- WHEN se lee `rx = -22.6`
- THEN se escribe una fila con `reason=change` y `last_stored_rx` pasa a `-22.6`

#### Scenario: Change below the deadband is not written
- GIVEN `last_stored_rx = -22.0` y deadband `0.5`
- WHEN se lee `rx = -22.3`
- THEN NO se escribe fila de historia y `last_stored_rx` sigue en `-22.0`

#### Scenario: Slow drift accumulates until it triggers
- GIVEN `last_stored_rx = -22.0` y deadband `0.5`
- WHEN se leen, en ciclos sucesivos, `-22.1`, `-22.2`, `-22.3`, `-22.4`, `-22.5`
- THEN no se escribe nada en los primeros cuatro y SÍ se escribe en el quinto (`|-22.5 − -22.0| = 0.5`)

#### Scenario: Improvement above the deadband is also written
- GIVEN `last_stored_rx = -25.0` y deadband `0.5`
- WHEN se lee `rx = -24.0` (mejora de 1 dB, p.ej. tras reparar un empalme)
- THEN se escribe una fila con `reason=change` — el deadband es sobre el VALOR ABSOLUTO del delta,
  no solo sobre degradaciones

#### Scenario: Exactly at the threshold writes
- GIVEN `last_stored_rx = -22.0` y deadband `0.5`
- WHEN se lee `rx = -22.5`
- THEN se escribe (la comparación es `>=`, no `>`)

### Requirement: Mandatory heartbeat

El sistema DEBE (MUST) escribir una fila de historia con `reason=heartbeat` cuando hayan pasado
`NOC_SIGNAL_HEARTBEAT_HOURS` (default `6`) o más desde `last_stored_at`, **aunque la señal no haya
cambiado**.

La fila del heartbeat DEBE (MUST) contener el `rx` ACTUAL (no el último guardado) y, en
consecuencia, DEBE (MUST) actualizar tanto `last_stored_rx` como `last_stored_at`, para no romper
el invariante de `noc-fiber-signal-store`.

El heartbeat solo AGREGA escrituras; NO DEBE (MUST NOT) suprimir ni postergar una escritura por
cambio.

#### Scenario: Heartbeat fires when the signal is flat
- GIVEN `last_stored_at` hace 6 h y `last_stored_rx = -22.0`
- WHEN se lee `rx = -22.05` (dentro del deadband)
- THEN se escribe una fila con `reason=heartbeat` y `rx = -22.05`, y `last_stored_rx` pasa a `-22.05`

#### Scenario: Heartbeat does not fire before its interval
- GIVEN `last_stored_at` hace 2 h
- WHEN se lee un `rx` dentro del deadband
- THEN NO se escribe ninguna fila

#### Scenario: Change wins over a due heartbeat
- GIVEN `last_stored_at` hace 7 h y `last_stored_rx = -22.0`
- WHEN se lee `rx = -23.0`
- THEN se escribe UNA sola fila, con `reason=change` (no dos filas, y no etiquetada como heartbeat)

### Requirement: New ONU is recorded on first sight

Una ONU sin estado previo (ni en memoria ni en `onu_signal_current`) DEBE (MUST) escribir una fila
con `reason=first_seen` en el primer ciclo en que se la lee, quedando así con baseline desde ese
momento.

#### Scenario: First-ever cycle writes a full snapshot
- GIVEN una base vacía y 2.803 ONUs leídas
- WHEN corre el primer ciclo
- THEN se escriben 2.803 filas con `reason=first_seen` y `onu_signal_current` queda con 2.803 filas

#### Scenario: A newly installed ONU is recorded without affecting the others
- GIVEN 2.803 ONUs con estado y una ONU nueva `sn=NEW1`
- WHEN corre un ciclo donde ninguna otra cambió ni tiene heartbeat vencido
- THEN se escribe exactamente 1 fila (`NEW1`, `reason=first_seen`)

#### Scenario: A new ONU produces no delta alert on its first cycles
- GIVEN `sn=NEW1` acaba de ser dada de alta
- WHEN corre el análisis de ese ciclo
- THEN `NEW1` no aparece ni en `pon_suspects` ni en `worsened_individual` (no tiene baseline —
  comportamiento ya existente de `pon_analysis::compute_delta`)

### Requirement: One transaction per cycle, memory advanced only after commit

El sistema DEBE (MUST) escribir el INSERT de `onu_signal_history` y el UPSERT de
`onu_signal_current` de un ciclo dentro de UNA sola transacción.

El estado en memoria (`last_stored_rx` / `last_stored_at`) NO DEBE (MUST NOT) avanzarse antes del
commit; solo se actualiza después de que la transacción commiteó con éxito.

#### Scenario: Failed flush leaves state untouched and the change is written next cycle
- GIVEN `last_stored_rx = -22.0` y una lectura `rx = -23.0` que debería escribirse
- WHEN el flush falla (Postgres caído / timeout)
- THEN no queda nada persistido, `last_stored_rx` sigue en `-22.0`, se loguea un warning
- AND en el ciclo siguiente, con `rx = -23.0`, se vuelve a decidir escribir y la fila se persiste

#### Scenario: Partial failure never persists half a cycle
- GIVEN el INSERT de historia tiene éxito y el UPSERT de `current` falla
- WHEN termina el intento
- THEN la transacción se revierte y `onu_signal_history` no conserva las filas de ese ciclo

### Requirement: Idempotent flush via collector-generated timestamp

Todas las filas de un mismo ciclo DEBEN (MUST) compartir un único timestamp generado por el
colector al inicio del ciclo. El sistema NO DEBE (MUST NOT) usar `now()` del servidor Postgres para
el `ts` de las filas.

El INSERT de historia DEBE (MUST) usar `ON CONFLICT DO NOTHING`, de modo que reintentar el flush
de un ciclo (por ejemplo, si se perdió la respuesta pero el commit sí ocurrió) no duplique filas ni
falle.

#### Scenario: Retrying the same batch is a no-op
- GIVEN un batch de un ciclo ya persistido con `ts = T`
- WHEN se reintenta exactamente el mismo batch
- THEN no se crean filas nuevas y la operación no lanza error

#### Scenario: All rows of a cycle share the same timestamp
- GIVEN un ciclo que escribe 71 cambios y 468 heartbeats
- WHEN se consultan esas filas
- THEN las 539 tienen exactamente el mismo `ts`

### Requirement: Batch is deduplicated by `sn` before flushing

El sistema DEBE (MUST) deduplicar el batch por `sn` antes de enviarlo, conservando la última
lectura y logueando un warning con los `sn` duplicados.

Motivo: el ciclo concatena las lecturas de 4 OLTs; si una ONU aparece en dos (migración de OLT,
serial repetido), un `INSERT ... ON CONFLICT DO UPDATE` con el mismo `sn` dos veces hace fallar a
Postgres con `ON CONFLICT DO UPDATE command cannot affect row a second time` y se pierde el CICLO
COMPLETO, no una fila.

#### Scenario: Duplicated sn across two OLTs does not break the cycle
- GIVEN las lecturas del ciclo traen `sn=A1` desde la OLT `1` y también desde la OLT `3`
- WHEN se prepara el flush
- THEN el batch contiene `A1` una sola vez (la última lectura), se loguea un warning con `A1`, y la
  transacción del ciclo commitea normalmente

### Requirement: In-memory state is rebuilt from `onu_signal_current` at startup

Al inicializar el path de Postgres, el sistema DEBE (MUST) cargar el estado
(`sn → {last_stored_rx, last_stored_at, olt, pon}`) leyendo `onu_signal_current`.

Mientras el estado NO esté cargado, el sistema NO DEBE (MUST NOT) flushear nada — escribir con
estado vacío generaría un snapshot completo espurio de `first_seen` que ensuciaría el histórico y
falsearía el conteo de altas.

#### Scenario: Restart does not re-write everything
- GIVEN una base con 2.803 ONUs cuyo estado no cambió
- WHEN se reinicia el proceso y corre el primer ciclo
- THEN el estado se recarga de `onu_signal_current` y se escriben SOLO los cambios y heartbeats
  vencidos (no 2.803 filas de `first_seen`)

#### Scenario: State load failure suppresses the flush
- GIVEN la carga de estado falla
- WHEN termina el ciclo
- THEN no se escribió nada en ninguna de las dos tablas y se loguea el motivo

### Requirement: Bounded retry, no buffering

El flush DEBE (MUST) reintentarse a lo sumo 2 veces con backoff dentro del mismo ciclo, con un
timeout de conexión/consulta acotado (≈10 s).

El sistema NO DEBE (MUST NOT) mantener un buffer en memoria ni un spool en disco de ciclos no
flusheados: el propio deadband ya actúa como "pendiente por escribir" (el cambio se vuelve a
detectar en el ciclo siguiente). Se pierde resolución temporal, nunca el evento.

#### Scenario: A two-hour Postgres outage costs resolution, not events
- GIVEN Postgres está caído durante 4 ciclos consecutivos y en el ciclo 2 una ONU se degradó 3 dB
- WHEN Postgres vuelve en el ciclo 5
- THEN el ciclo 5 detecta el cambio contra `last_stored_rx` (que nunca avanzó) y lo persiste

### Requirement: Per-cycle observability

Cada ciclo DEBE (MUST) emitir una línea de log con, al menos: cantidad de lecturas, altas nuevas,
cambios escritos, heartbeats escritos, ONUs sin escritura, duplicados detectados, duración del
flush y estado del path de Postgres.

Esto es lo que permite MEDIR el ahorro real del deadband contra el ~89% estimado.

#### Scenario: The cycle log exposes the deadband ratio
- GIVEN un ciclo con 2.803 lecturas, 71 cambios y 468 heartbeats
- WHEN termina el ciclo
- THEN el log incluye `read=2803 changed=71 heartbeat=468 skipped=2264`
