# Capability: network-sessions-pools-redesign

Filtrado + paginado **server-side** de las sesiones RADIUS activas (`GET /api/radius/sessions` con `search`/`nasId`/`status`/`page`/`limit` + envelope condicional con KPIs), y rediseño de **presentación** del tab Pools IP (filtros, grupos colapsables, KPIs null-safe, orden por uso). Tab "Gestión de Red" (`GestionRedPage.tsx`). Ambos gated `network.read`.

> **Nota SDD:** el código de las capabilities FE vive en el repo `ipnext-frontend`. El spec.md está aquí por convención (openspec en el backend). **Backend API real:** `GET /api/radius/sessions` (NO `/api/sessions`), `GET /api/ip-pools`.

## ADDED Requirements

### Requirement: Back-compat — sin params devuelve el array legacy

`GET /api/radius/sessions` SHALL preservar su contrato actual cuando la request NO trae ningún query param: SHALL devolver un array plano `RadiusSession[]` (no un envelope).

#### Scenario: request sin params → array
- **WHEN** un usuario con `network.read` hace `GET /api/radius/sessions` sin query params
- **THEN** la respuesta es `200` y el body es un array (`Array.isArray(body) === true`)
- **AND** cada elemento tiene la forma completa de `RadiusSession` (id, sessionId, username, clientName, nasId, nasName, ipAddress, macAddress, startedAt, duration, downloadBytes, uploadBytes, downloadMbps, uploadMbps, status, contractId, clientId, customerName)

#### Scenario: RBAC preservado
- **WHEN** una request llega sin autenticación
- **THEN** la respuesta es `401`
- **AND WHEN** un usuario autenticado sin `network.read` la hace
- **THEN** la respuesta es `403` y NO se consulta el orchestrator

### Requirement: Paginación server-side con envelope

Cuando la request trae al menos un query param (`search`, `nasId`, `status`, `page` o `limit`), `GET /api/radius/sessions` SHALL devolver el envelope `{ data, total, page, limit, hasNext, stats }`. `data` SHALL contener a lo sumo `limit` filas de la página `page`. `limit` SHALL tener default `50` y cap `200`; `page` default `1`.

#### Scenario: request con page/limit → envelope
- **WHEN** un usuario hace `GET /api/radius/sessions?page=1&limit=50`
- **THEN** la respuesta es `200` y el body tiene `data` (array), `total` (number), `page`, `limit`, `hasNext` (boolean) y `stats`
- **AND** `data.length <= 50`
- **AND** `hasNext === (page * limit < total)`

#### Scenario: total refleja la cantidad filtrada
- **GIVEN** N sesiones que matchean los filtros de la request
- **WHEN** se pagina con `limit` menor a N
- **THEN** `total === N` (no el `limit`, no el `data.length` de la página)
- **AND** recorrer las páginas hasta `hasNext === false` recupera exactamente N filas sin duplicados ni huecos (orden estable cross-página)

#### Scenario: página fuera de rango → data vacía, total correcto
- **WHEN** se pide `page` mayor a la última página disponible
- **THEN** `data` es `[]`, `total` sigue siendo N y `hasNext === false`

### Requirement: Filtro search sobre 4 campos

El param `search` SHALL filtrar las sesiones cuyo `username` OR `customerName` OR `ipAddress` OR `macAddress` contenga el término (case-insensitive, substring). Las sesiones con un campo `null` (p. ej. `customerName` de un PPPoE sin contrato) NO SHALL matchear por ese campo (pero pueden matchear por otro).

#### Scenario: match por username
- **WHEN** `search=user1`
- **THEN** `data` incluye solo sesiones cuyo `username` (u otro de los 4 campos) contiene "user1" (case-insensitive)

#### Scenario: match por customerName
- **WHEN** `search=perez` y existe una sesión con `customerName="Juan Pérez"`
- **THEN** esa sesión aparece en `data`

#### Scenario: match por IP o MAC
- **WHEN** `search=10.75` (fragmento de IP) o `search=AA:BB` (fragmento de MAC)
- **THEN** `data` incluye las sesiones cuyo `ipAddress` o `macAddress` contiene el fragmento

#### Scenario: sesión sin contrato no rompe el search
- **GIVEN** una sesión con `customerName=null`, `clientId=null`
- **WHEN** `search=cualquiercosa`
- **THEN** esa sesión no matchea por `customerName` (null) y el request NO falla

### Requirement: Filtro nasId

El param `nasId` SHALL filtrar las sesiones cuyo `nasId` coincida con el valor dado. (En la fuente real `nasId === nasName === nasIp`; el filtro matchea contra ese valor.)

#### Scenario: filtrar por un NAS
- **GIVEN** sesiones distribuidas entre varios `nasId`
- **WHEN** `nasId=<uno de ellos>`
- **THEN** `data` (y `total`) incluye solo las sesiones de ese `nasId`

### Requirement: Filtro status

El param `status` SHALL aceptar solo `active` o `idle` y filtrar por el `status` de la sesión. Un valor inválido SHALL devolver `400 VALIDATION_ERROR`.

#### Scenario: filtrar por active
- **WHEN** `status=active`
- **THEN** `data` incluye solo sesiones con `status === 'active'`

#### Scenario: filtrar por idle
- **GIVEN** la fuente contiene sesiones `idle` (el repo in-memory las produce)
- **WHEN** `status=idle`
- **THEN** `data` incluye solo sesiones con `status === 'idle'`
- **AND** (nota de prod, no testeable contra la fuente real: la fuente real siempre emite `active`, por lo que `status=idle` devolverá `data=[]` en producción — comportamiento correcto, no error)

#### Scenario: status inválido rechazado
- **WHEN** `status=foo`
- **THEN** la respuesta es `400` con `code: VALIDATION_ERROR`

### Requirement: KPIs de estado (stats) ignorando el filtro status

El envelope SHALL incluir `stats: { total, active, idle }` calculado sobre el set filtrado por `search` + `nasId` **ignorando** el filtro `status`. `stats.total` SHALL ser el número usado por el badge del tab. `stats.active` + `stats.idle` SHALL sumar `stats.total`.

#### Scenario: stats no se recorta por el filtro status
- **GIVEN** un set (tras search+nasId) con 10 active y 3 idle
- **WHEN** la request incluye `status=active`
- **THEN** `data`/`total` reflejan solo los 10 active
- **AND** `stats` es `{ total: 13, active: 10, idle: 3 }` (los idle siguen contados)

#### Scenario: badge del tab usa stats.total
- **WHEN** el FE paginado ya no tiene el array completo
- **THEN** el badge del tab muestra `stats.total`, no `data.length`

### Requirement: Combinación de filtros + paginación

`search`, `nasId`, `status`, `page`, `limit` SHALL poder combinarse. `total` SHALL reflejar las filas que matchean TODOS los filtros aplicados (incluido `status`), y `hasNext`/paginación SHALL ser consistentes con ese `total`.

#### Scenario: search + nasId + status + page
- **WHEN** `search=user&nasId=X&status=active&page=1&limit=20`
- **THEN** `data` contiene la página 1 (≤20) de las sesiones que matchean los tres filtros
- **AND** `total` es la cantidad total que matchea los tres filtros
- **AND** `stats` refleja el set de search+nasId (sin status)

### Requirement: Validación de params numéricos

`page` y `limit` SHALL ser enteros positivos; un valor no entero, cero o negativo SHALL devolver `400 VALIDATION_ERROR` (patrón `parseIntPositive` de las rutas de auditoría).

#### Scenario: page inválido
- **WHEN** `page=0` o `page=abc`
- **THEN** `400` con `code: VALIDATION_ERROR`

#### Scenario: limit inválido
- **WHEN** `limit=-1` o `limit=0`
- **THEN** `400` con `code: VALIDATION_ERROR`

### Requirement: Semántica de params vacíos y repetidos (W1/W2, post-review adversarial)

Para `search`, `nasId` y `status`: un valor **vacío** (`?search=`, `?nasId=`, `?status=`) SHALL
normalizarse a "sin filtro" (equivalente a omitir el param) de forma coherente entre los tres —
NO SHALL devolver cero resultados silenciosamente (bug previo de `nasId=''`) ni `400` (bug previo
de `status=''`). La **presencia** de la key (aunque el valor sea vacío) SHALL seguir activando el
modo envelope junto con `search`/`nasId`/`status`/`page`/`limit`. El FE puede omitir el param o
mandarlo vacío indistintamente. Un param **repetido** (`?search=a&search=b`, que Express entrega
como array) SHALL devolver `400 VALIDATION_ERROR` — NO SHALL propagarse al use case y romper con
un error no controlado (bug previo: `500 INTERNAL_ERROR` por `search.toLowerCase()` sobre un
array).

#### Scenario: nasId vacío = sin filtro
- **WHEN** `nasId=&page=1`
- **THEN** `200` con el envelope completo (todas las sesiones), NO `total=0`

#### Scenario: status vacío = sin filtro
- **WHEN** `status=`
- **THEN** `200` con el envelope completo, NO `400`

#### Scenario: search vacío = sin filtro
- **WHEN** `search=`
- **THEN** `200` con el envelope completo (sin filtrar)

#### Scenario: param repetido rechazado
- **WHEN** `search=a&search=b` o `nasId=a&nasId=b` (Express los entrega como array)
- **THEN** `400` con `code: VALIDATION_ERROR` (nunca `500`)

### Requirement: DIP y no-fuga de la entidad

`ListRadiusSessions` SHALL depender solo de los ports (`RadiusSessionRepository`, `PppoeServiceRepository`); NO SHALL importar Prisma, axios ni Express. La respuesta paginada SHALL mapearse a un DTO (`RadiusSessionDto`), NO devolver la entidad Prisma/dominio cruda.

#### Scenario: application layer limpia
- **WHEN** se inspeccionan los imports de `ListRadiusSessions` y su DTO
- **THEN** no hay imports de `@infrastructure/*`, Prisma, axios ni Express

## ADDED Requirements — Pools IP (presentación, FE-only; contrato de datos en el BE)

### Requirement: ipKind en el contrato de pools

`GET /api/ip-pools` SHALL exponer `ipKind` (`cgnat` | `public` | `null`) por pool, sin alterar el resto del contrato (`assignedCount` puede ser `null`). El tipo del FE SHALL declarar `ipKind`.

#### Scenario: body incluye ipKind
- **WHEN** un usuario con `network.read` hace `GET /api/ip-pools`
- **THEN** cada pool del body tiene `ipKind ∈ { 'cgnat', 'public', null }`
- **AND** los pools con `assignedCount === null` conservan ese `null` (NO convertido a 0)

### Requirement: Filtros del tab Pools

El tab Pools SHALL permitir filtrar por NAS, por tipo (`dynamic`/`static`), por `ipKind` (`cgnat`/`public`), y por texto (name/rangeStart/rangeEnd, debounced). Los filtros son del lado FE (sin request nuevo); operan sobre el array completo de ~30 pools.

#### Scenario: filtro por ipKind
- **WHEN** el operador selecciona `ipKind=cgnat`
- **THEN** la vista muestra solo pools con `ipKind === 'cgnat'`

#### Scenario: filtro por tipo
- **WHEN** el operador selecciona tipo `dynamic`
- **THEN** la vista muestra solo pools con `type === 'dynamic'`

#### Scenario: filtro de texto debounced
- **WHEN** el operador tipea en el buscador
- **THEN** el filtrado (name/rangeStart/rangeEnd, case-insensitive) se aplica tras el debounce (300ms), sin recargar datos del server

### Requirement: KPIs de pools null-safe

Los KPIs de cabecera (IPs totales / asignadas / libres) SHALL **excluir** del agregado los pools con `assignedCount === null` y SHALL mostrar por separado el conteo de pools "sin dato". `assignedCount === null` NUNCA SHALL contarse como `0` en ningún agregado.

#### Scenario: pool sin dato excluido del total
- **GIVEN** 3 pools con `assignedCount = 10, 20, null` y `totalCount = 100, 100, 100`
- **WHEN** se calculan los KPIs
- **THEN** "asignadas" es `30` (10+20, excluyendo el null), NO `30` tratando null como 0 dentro de un promedio contaminado
- **AND** se muestra un indicador "1 sin dato"
- **AND** "IPs totales" incluye los 3 (`300`, porque `totalCount` nunca es null)

#### Scenario: NoData y UsageBar preservados
- **WHEN** un pool tiene `assignedCount === null`
- **THEN** su celda de asignadas muestra `NoData` (—, con `role="img"`/`aria-label`) y su `UsageBar` muestra `NoData` (no una barra a 0%)

### Requirement: Grupos colapsables y orden por uso

Los pools SHALL agruparse por router (nasId) en grupos colapsables con subtotales por grupo. Dentro de cada grupo, los pools SHALL ordenarse por **% de uso descendente** (`assignedCount / totalCount`); los pools con `assignedCount === null` SHALL ir al final del grupo (sin asignarles % 0).

#### Scenario: orden por uso
- **GIVEN** un grupo con pools al 90%, 50%, 100% de uso y uno con `assignedCount === null`
- **WHEN** se renderiza el grupo
- **THEN** el orden es 100%, 90%, 50%, luego el de `null` (al final)

#### Scenario: grupo colapsable
- **WHEN** el operador colapsa un grupo
- **THEN** las filas del grupo se ocultan pero el header con el subtotal permanece visible

## ADDED Requirements — UX / Accesibilidad (ambos tabs)

### Requirement: Accesibilidad y consistencia visual

El redesign SHALL usar CSS Modules + tokens de `variables.css` (NO Tailwind) y SHALL cumplir: contraste de texto ≥ 4.5:1, targets táctiles ≥ 44px, focus visible en controles interactivos, y `aria-label` en el indicador NoData.

#### Scenario: filtros accesibles
- **WHEN** el operador navega los filtros por teclado
- **THEN** cada control muestra un focus visible y es operable por teclado

#### Scenario: reset de página al filtrar
- **WHEN** el operador cambia cualquier filtro de sesiones (search/nasId/status)
- **THEN** la paginación se resetea a `page = 1` y se dispara un único request (search debounced 300ms)

#### Scenario: estado vacío
- **WHEN** ningún registro matchea los filtros
- **THEN** se muestra un empty-state ("Sin sesiones/pools para los filtros seleccionados"), no una tabla vacía sin contexto
