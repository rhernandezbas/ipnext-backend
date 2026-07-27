# IClass Team Location Ingest Specification

## Purpose

Traer los breadcrumbs GPS de las cuadrillas desde IClass y persistirlos en Prominense **antes de que IClass los borre**.

IClass retiene el rastro **~30 días rolling** (verificado 2026-07-26 en dos técnicos: el punto más viejo era del 25-06 con fecha actual 26-07). Sin este ingest no existe auditoría histórica: el dato se pierde solo.

El ingest es **puramente aditivo y read-only** contra IClass. No escribe nada en el sistema externo.

## Requirements

### Requirement: The trail belongs to the team, not to the service order

El sistema DEBE (MUST) modelar la ubicación como un rastro continuo **de la cuadrilla**, independiente de cualquier orden de servicio.

Justificación verificada: un técnico registró 233 puntos entre las 06:07 y las 21:53 de un mismo día, mientras la OS asociada ocupaba 2 minutos. El rastro existe haya o no haya órdenes; la OS es un filtro de consulta sobre él, no su origen.

#### Scenario: Points are ingested for a team with no service orders that day
- GIVEN la cuadrilla `T1` no tiene ninguna OS el día `D`
- WHEN corre el ingest para `T1`
- THEN los puntos del día `D` se persisten igual, asociados a `T1` y sin referencia a ninguna OS

### Requirement: Pagination MUST NOT stop on a short page

El sistema DEBE (MUST) seguir paginando `GET /teams/{id}/locations` aunque una página devuelva **menos ítems que el `pagesize`** solicitado.

El sistema DEBE (MUST) cortar el loop únicamente tras **dos páginas consecutivas** vacías o con `204`.

El sistema NO DEBE (MUST NOT) usar `hasMoreElements`, `totalpages` ni `totalobjects` como condición de corte: el paginador de IClass los omite de forma inconsistente según el `pagesize`.

Justificación verificada: cortar en la primera página incompleta trajo **2.600 de 6.286 puntos** — se perdió el 59% del rastro **en silencio**, y el tramo perdido era justamente el más antiguo (el que está por expirar y es el más valioso).

#### Scenario: A short page mid-stream does not end the ingest
- GIVEN el rastro de `T1` tiene 6.286 puntos y la página 26 devuelve 63 ítems
- WHEN corre el ingest con `pagesize=100`
- THEN el ingest continúa más allá de la página 26
- AND persiste los 6.286 puntos, no 2.600

#### Scenario: Two consecutive empty pages end the ingest
- GIVEN la página `N` devuelve 0 ítems y la página `N+1` también
- WHEN el ingest las procesa
- THEN el ingest termina y reporta el total ingestado

### Requirement: Team identity is resolved from the embedded resource URLs

El sistema DEBE (MUST) extraer el identificador de la cuadrilla del path embebido en la respuesta de `GET /teams` (campo `localizacoes`, con forma `/teams/{id}/locations`).

El sistema NO DEBE (MUST NOT) esperar un campo `id` en el objeto team: IClass **no lo devuelve** en ese listado (viene `null`).

El sistema DEBE (MUST) usar el `login` como clave de negocio estable de la cuadrilla.

#### Scenario: Team id is parsed from the locations URL
- GIVEN `GET /teams` devuelve `{ login: "IPNXANDYM", localizacoes: "/teams/30598635/locations", id: null }`
- WHEN el ingest resuelve la identidad de esa cuadrilla
- THEN usa `30598635` como id de IClass y `IPNXANDYM` como login

### Requirement: Ingested points are deduplicated

El sistema DEBE (MUST) tratar como **el mismo punto** dos registros con igual cuadrilla, igual `dataRegistro`, igual latitud y igual longitud, aunque difieran en `origem`.

Justificación verificada: IClass emite el mismo fix por dos fuentes distintas — se observó `origem: 1` y `origem: 3` con coordenadas y timestamp idénticos.

El ingest DEBE (MUST) ser **idempotente**: correrlo dos veces sobre la misma ventana no duplica filas.

#### Scenario: The same fix reported by two sources is stored once
- GIVEN IClass devuelve dos puntos con `dataRegistro` `26-07-2026 09:01:45`, misma lat/long, uno con `origem:1` y otro con `origem:3`
- WHEN el ingest los procesa
- THEN persiste UNA fila
- AND conserva ambos valores de `origem` como metadato, sin perder información

#### Scenario: Re-running the ingest does not duplicate
- GIVEN el ingest ya persistió el rastro del día `D`
- WHEN vuelve a correr sobre el día `D`
- THEN el conteo de filas para `D` no cambia

### Requirement: Accuracy and source are preserved verbatim

El sistema DEBE (MUST) persistir `raio` (precisión en metros) y `origem` tal como los devuelve IClass, sin redondear ni descartar.

Justificación: sin la precisión no se puede calificar honestamente un veredicto de presencia. Se observaron valores de 3,8 a 102,5 m — un punto con `raio` de 102 m no sostiene la misma conclusión que uno de 4 m.

#### Scenario: A low-accuracy point is stored with its accuracy
- GIVEN un punto con `raio: 102.5`
- WHEN se persiste
- THEN la precisión queda disponible para el consumidor, que decide qué hacer con ella

### Requirement: Rate limiting is respected

El sistema DEBE (MUST) throttlear las llamadas y reintentar ante `429` con backoff, reusando el manejo que ya tiene `IClassClient`.

El ingest NO DEBE (MUST NOT) abortar la corrida entera por un `429` aislado.

#### Scenario: A 429 mid-ingest is retried, not fatal
- GIVEN la página 12 devuelve `429`
- WHEN el ingest la procesa
- THEN espera y reintenta
- AND al agotar los reintentos registra la ventana como incompleta en vez de reportar éxito

### Requirement: Own retention is 12 months with purge

El sistema DEBE (MUST) conservar los breadcrumbs **12 meses** y purgar los más antiguos.

El sistema DEBE (MUST) registrar cuántos puntos purgó en cada corrida.

Volumen estimado con la dotación actual: ~6.000 puntos/técnico/mes × 6 técnicos ≈ **36k/mes ≈ 430k/año**.

#### Scenario: Points older than 12 months are purged
- GIVEN existe un punto con fecha de hace 13 meses
- WHEN corre la purga
- THEN ese punto se elimina y la corrida reporta el conteo purgado

### Requirement: Each ingest run is observable

El sistema DEBE (MUST) registrar por corrida: cuadrillas procesadas, puntos nuevos, puntos duplicados descartados, puntos purgados, páginas leídas y ventanas marcadas incompletas.

Justificación: el modo de falla peligroso de este ingest es el **silencioso** — traer de menos y parecer exitoso. Sin estos contadores, un ingest que trae el 41% del rastro se ve igual que uno completo.

#### Scenario: An incomplete window is reported, not hidden
- GIVEN una cuadrilla cuyo rastro no pudo leerse completo por `429` persistentes
- WHEN termina la corrida
- THEN el resumen la marca como incompleta y no la cuenta como exitosa
