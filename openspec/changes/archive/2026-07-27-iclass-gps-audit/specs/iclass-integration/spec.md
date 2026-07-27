# Delta for iclass-integration

> El `IClassClient` gana capacidad de leer ubicaciones de cuadrillas. Todo lo existente
> (login+retry, manejo de `429`, `fetchAllPages`, `listTeams`, `getServiceOrderHistory`)
> queda **sin cambios de comportamiento**.

## ADDED Requirements

### REQ-ICLASS-LOC-1: The client exposes a team's last known location

**Given** una cuadrilla identificada por `login` o por su id de IClass
**When** se invoca `getLastTeamLocation`
**Then** el cliente MUST llamar a `GET /teams/lastlocation` con ese filtro
**And** MUST devolver latitud, longitud, timestamp, precisión (`raio`) y origen
**And** MUST devolver ausencia (no un error) cuando IClass responde `204`

Rationale: `204` es la respuesta normal para una cuadrilla sin rastro (5 de 11 logins de IPNEXT están en esa condición por ser cuentas canceladas o duplicadas). Tratarlo como error rompería el ingest en cada corrida.

### REQ-ICLASS-LOC-2: The client reads a team's full location trail with robust pagination

**Given** una cuadrilla con rastro en IClass
**When** se invoca `listTeamLocations`
**Then** el cliente MUST paginar `GET /teams/{id}/locations`
**And** MUST NOT cortar el recorrido al recibir una página con menos ítems que el `pagesize` solicitado
**And** MUST cortar únicamente tras dos páginas consecutivas vacías o con `204`
**And** MUST NOT usar `hasMoreElements`, `totalpages` ni `totalobjects` como condición de corte

Rationale: medido contra la API real — con `pagesize=100`, cortar en la primera página incompleta trajo **2.600 de 6.286 puntos** (59% perdido, en silencio). El paginador de IClass omite los totales de forma inconsistente según el `pagesize`; el mismo defecto ya está documentado para `/serviceorders`.

### REQ-ICLASS-LOC-3: The trail endpoint accepts no date filter and the client MUST NOT pretend otherwise

**Given** que `GET /teams/{id}/locations` sólo admite `pagenumber`, `pagesize` y `orderBy`
**When** un consumidor necesita el rastro de una fecha determinada
**Then** el cliente MUST NOT enviar parámetros de fecha inventados
**And** MUST resolver la fecha recorriendo el paginado, que viene ordenado por fecha descendente
**And** MAY usar búsqueda binaria sobre `pagenumber` para ubicar la fecha sin recorrer todo el rastro

Rationale: verificado contra el spec OpenAPI y contra la API. La búsqueda binaria se probó en vivo: ubicó el día buscado en 5 requests en lugar de ~50.

### REQ-ICLASS-LOC-4: Team identity is resolved from embedded resource URLs

**Given** la respuesta de `GET /teams`
**When** el cliente construye el descriptor de cada cuadrilla
**Then** MUST extraer el id de IClass del path embebido en `localizacoes` (`/teams/{id}/locations`)
**And** MUST NOT depender del campo `id` del objeto team

Rationale: IClass devuelve `id: null` en el listado de teams; el identificador sólo aparece dentro de las URLs de sub-recursos.

### REQ-ICLASS-LOC-5: Location reads are strictly read-only

**Given** cualquier operación de esta capability
**When** se ejecuta contra IClass
**Then** MUST usar únicamente verbos de lectura
**And** MUST NOT escribir, cerrar, comentar ni modificar ninguna orden de servicio

Rationale: el `IClassClient` ya tiene métodos de escritura en prod (`closeServiceOrder`, `updateServiceOrder`). La auditoría no debe poder tocarlos ni por accidente.
