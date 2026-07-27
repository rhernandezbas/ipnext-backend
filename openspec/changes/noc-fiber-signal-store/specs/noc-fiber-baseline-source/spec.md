# Noc Fiber Baseline Source Specification

## Purpose

De dónde saca el colector el **baseline histórico** y la **topología** que alimentan
`sensors::pon_analysis::analyze`, y cómo se configura la transición desde InfluxDB.

El cambio de fondo es semántico: la query de baseline pasa de "MEDIAN de una ventana de 2 días
centrada en hace N días" (heredada de `fibra_report.py`, medida VACÍA en producción → el sistema
lleva meses sin detectar nada) a **"último valor conocido ANTES de la fecha X"**, que por
construcción no puede venir vacía mientras exista cualquier dato anterior a X.

`pon_analysis::analyze` y `compute_delta` NO se modifican: siguen recibiendo
`baseline_7d/15d/30d` en `OnuReading` y siguen prefiriendo `b30 ?? b15 ?? b7`. Lo único que cambia
es quién los calcula.

## Requirements

### Requirement: Baseline is the last known value before the cutoff, with no lower bound

El sistema DEBE (MUST) resolver el baseline de una ONU a una fecha `X` como el `rx` de la fila más
reciente de `onu_signal_history` con `ts <= X`, o ausente si no existe ninguna.

El sistema NO DEBE (MUST NOT) acotar la búsqueda por abajo (nada de
`AND ts >= X - interval 'N days'`): ese límite inferior es precisamente el defecto de la query
heredada. Un dato viejo sigue siendo la respuesta CORRECTA — si la señal no cambió, no cambió.

El sistema DEBE (MUST) resolver los tres cortes (7, 15 y 30 días) en una sola ida a la base,
conducidos por `onu_signal_current` (≈2.803 filas) mediante `LEFT JOIN LATERAL ... LIMIT 1`, para
evitar recorrer el histórico completo.

#### Scenario: A stable ONU has a baseline even without recent points at that exact date
- GIVEN `sn=A1` tiene una única fila en el histórico con `ts` de hace 40 días y `rx = -21.0`
- WHEN se pide el baseline a 30 días
- THEN devuelve `-21.0` (la query vieja habría devuelto nada, porque no hay puntos en la ventana
  `[31d, 29d]`)

#### Scenario: An ONU with no data before the cutoff has no baseline
- GIVEN `sn=NEW1` tiene su primera fila hace 3 días
- WHEN se piden los baselines a 7, 15 y 30 días
- THEN los tres vienen ausentes y `compute_delta` devuelve `baseline_used = None`, `delta_base = None`

#### Scenario: The three cutoffs resolve in a single query
- GIVEN el histórico poblado
- WHEN se resuelven los baselines de un ciclo
- THEN se ejecuta UNA sola consulta que devuelve `sn`, `rx_7d`, `rx_15d`, `rx_30d`

#### Scenario: The most recent point before the cutoff wins
- GIVEN `sn=A1` tiene filas con `ts` de hace 40, 35 y 20 días
- WHEN se pide el baseline a 30 días
- THEN devuelve el `rx` de la fila de hace 35 días (la más reciente que cumple `ts <= now()-30d`)

### Requirement: Progressive maturation from an empty store

Arrancando de cero, el sistema DEBE (MUST) degradar de forma progresiva y sin errores: sin baseline
los primeros 7 días, con baseline de 7 días a partir del día 7, de 15 desde el día 15, y el régimen
completo desde el día 30 — apoyándose en la cadena de fallback que ya existe en
`compute_delta` (`b30 ?? b15 ?? b7`).

La ausencia de baseline NO DEBE (MUST NOT) producir errores, alertas espurias ni interrumpir el
ciclo; produce exactamente lo que produce hoy: la ONU queda fuera de las dos listas del análisis.

El loop `olt_watch` (5 min) NO DEBE (MUST NOT) verse afectado por el estado de maduración del
baseline — no lo usa.

#### Scenario: Day 3 produces no delta alerts and no errors
- GIVEN el histórico tiene 3 días de datos
- WHEN corre un ciclo de señal/PON
- THEN `pon_suspects` y `worsened_individual` vienen vacíos y el ciclo termina sin error

#### Scenario: Day 10 produces delta alerts using the 7-day baseline
- GIVEN el histórico tiene 10 días de datos y una ONU cayó 3 dB respecto de hace 7 días
- WHEN corre un ciclo
- THEN esa ONU aparece en `worsened_individual` con `baseline_used` proveniente del corte de 7 días

#### Scenario: olt_watch keeps alerting during maturation
- GIVEN el histórico tiene 1 día de datos y una ONU entra en LOS
- WHEN corre el ciclo de `olt_watch`
- THEN se emite la alerta de LOS normalmente

### Requirement: Topology comes from `onu_signal_current`, not from Influx tags

El sistema DEBE (MUST) resolver el mapa `sn → (olt, pon)` desde `onu_signal_current` cuando el path
de Postgres está activo, en lugar de `InfluxClient::fetch_topology()`.

El sistema NO DEBE (MUST NOT) usar `onu/get_all_onus_details` para esto (límite de 15 llamadas/hora
en SmartOLT), ni agregar ninguna llamada nueva a la API de SmartOLT: la topología ya está en la
tabla propia y se refresca en cada ciclo.

Un `sn` sin entrada de topología DEBE (MUST) seguir el comportamiento actual: `pon = "?/?"`, sin
error. Esto solo puede ocurrir en el primer ciclo de la vida de la base o para una ONU recién dada
de alta — casos en los que además no hay baseline, por lo que la ONU no participa del análisis.

#### Scenario: Topology is read without extra SmartOLT calls
- GIVEN el path de Postgres está activo
- WHEN corre un ciclo de señal/PON
- THEN el mapa `sn → (olt, pon)` se arma desde `onu_signal_current` y la cantidad de llamadas a
  SmartOLT del ciclo no aumenta respecto del comportamiento previo

#### Scenario: First-ever cycle tolerates unknown PON
- GIVEN `onu_signal_current` está vacía
- WHEN corre el primer ciclo
- THEN todas las lecturas quedan con `pon = "?/?"`, el análisis no emite nada (no hay baseline) y
  el ciclo termina sin error

### Requirement: Configurable baseline source

El sistema DEBE (MUST) exponer `NOC_BASELINE_SOURCE` con los valores `postgres` (default), `influx`
y `dual`:

- `postgres`: el baseline sale exclusivamente de la base propia.
- `influx`: comportamiento previo a este change (compatibilidad / rollback).
- `dual`: se consulta Postgres y, para las ONUs sin baseline ahí, se cae a Influx.

Un valor **presente pero no reconocido** (ej. un typo armando un cutover, `NOC_BASELINE_SOURCE=postgress`)
DEBE (MUST) fallar de forma explícita al arrancar (el proceso termina con código != 0), nombrando
los valores válidos, no elegir un default silencioso — es un crash-loop deliberado: se nota en el
journal/`systemctl status`, mientras que un cutover que "aplicó mal" en silencio no.

Un valor **ausente o vacío** (`NOC_BASELINE_SOURCE` sin setear, o seteada a `""`) NO DEBE (MUST NOT)
fallar el arranque: es el caso normal de operación (así corre la VM hoy) y cae al default vigente
SIN loguear ningún warning — solo lo no reconocido pero presente es indicio de un error humano.

Si `NOC_BASELINE_SOURCE` requiere Influx (`influx` o `dual`) y `NOC_INFLUX_URL` no está
configurada, el sistema DEBE (MUST) loguear un warning claro y seguir corriendo sin esa fuente.

#### Scenario: Default source is postgres
- GIVEN `NOC_BASELINE_SOURCE` no está seteada y `NOC_PG_URL` sí
- WHEN arranca el colector
- THEN el baseline se resuelve contra Postgres y no se consulta Influx
- NOTA (drift documentado, ver README/config.rs de `ipnext-noc-collector`): el default OPERATIVO
  actual sigue siendo `influx`, no `postgres` — decisión posterior explícita del orquestador
  mientras el store propio madura, no una contradicción de este escenario respecto al plan
  original.

#### Scenario: An absent or empty value falls back to the default without any warning
- GIVEN `NOC_BASELINE_SOURCE` no está seteada (o está seteada a `""`)
- WHEN arranca el colector
- THEN el arranque es exitoso, se usa el default vigente, y NO se loguea ningún warning (a
  diferencia de un valor presente pero no reconocido, que sí falla)

#### Scenario: Dual falls back per ONU
- GIVEN `NOC_BASELINE_SOURCE=dual`, `sn=A1` con baseline en Postgres y `sn=A2` sin baseline ahí
- WHEN se resuelven los baselines
- THEN `A1` usa el valor de Postgres y para `A2` se intenta el de Influx

#### Scenario: Rollback to influx restores previous behaviour
- GIVEN `NOC_BASELINE_SOURCE=influx`
- WHEN corre un ciclo
- THEN el baseline se resuelve como antes de este change (mediana por ventana desde Influx), aunque
  el colector siga escribiendo su Postgres

#### Scenario: Unknown value fails fast
- GIVEN `NOC_BASELINE_SOURCE=pgsql`
- WHEN arranca el colector
- THEN el arranque falla con un error que nombra los valores válidos

### Requirement: `NOC_SHADOW` is retired

El sistema DEBE (MUST) eliminar el campo `shadow` de `Settings`. Está verificado que hoy no gatea
ningún comportamiento: su único uso es un `warn!` en `main.rs`, y el carácter read-only del cliente
de Influx es una propiedad del código, no del flag.

La presencia residual de `NOC_SHADOW` en el `.env` de la VM NO DEBE (MUST NOT) impedir el arranque
(las variables desconocidas se ignoran al deserializar).

El README y `env.example` DEBEN (MUST) documentar el reemplazo por `NOC_PG_URL` +
`NOC_BASELINE_SOURCE`.

#### Scenario: A leftover NOC_SHADOW in the environment is ignored
- GIVEN `NOC_SHADOW=true` sigue presente en el entorno
- WHEN arranca el colector con la config nueva
- THEN el arranque es exitoso y la variable no tiene ningún efecto
