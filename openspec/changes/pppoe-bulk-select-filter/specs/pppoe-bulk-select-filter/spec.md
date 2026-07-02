# Capability: pppoe-bulk-select-filter

Seleccionar **TODOS** los servicios PPPoE que matchean un filtro activo (endpoint liviano de ids, congelable en el FE) y aplicarles el **cambio de plan masivo en lotes de 200 secuenciales**, con progreso por lote, agregación de resultados y confirmación proporcional al blast radius, en el tab PPPoE de Gestión de Red. Evolución v2 de `pppoe-search-bulk-plan`.

## ADDED Requirements

### Requirement: Endpoint de ids del filtro

El sistema SHALL exponer `GET /api/pppoe/ids` (gate `pppoe.manage`) que acepta los MISMOS filtros que `GET /api/pppoe` (`search`, `status`, `nasId`, `includeUnassigned`; SIN `page`/`limit`) y devuelve `{ ids: string[], total: number }` liviano (solo ids, sin proyección de cliente ni enriquecimiento). La semántica del `where` SHALL ser IDÉNTICA a la de `listAllPaginated` (mismo builder de WHERE + misma normalización de `status` de negocio a `displayStatus`). El campo `total` SHALL ser igual a `ids.length` (sin paginación).

#### Scenario: ids por nasId
- **GIVEN** 340 servicios en el NAS `"NE8000-1"` y otros 50 en otros NAS
- **WHEN** se hace `GET /api/pppoe/ids?nasId=NE8000-1&includeUnassigned=true` con permiso `pppoe.manage`
- **THEN** la respuesta es `200` con `total = 340` y `ids` contiene exactamente los 340 ids del NAS `"NE8000-1"`
- **AND** `ids.length === total`

#### Scenario: ids por search (username/cliente/IP/MAC)
- **GIVEN** servicios que matchean `search = "100.64.28"` por `remoteAddress`
- **WHEN** se hace `GET /api/pppoe/ids?search=100.64.28`
- **THEN** `ids` contiene exactamente los ids de los servicios cuyo `remoteAddress` (o username/cliente/MAC) matchea, con la MISMA semántica que el listado

#### Scenario: ids por status de negocio
- **GIVEN** servicios en estado de negocio `"reduced"` y otros `"active"`
- **WHEN** se hace `GET /api/pppoe/ids?status=reduced`
- **THEN** `ids` contiene exactamente los ids de los servicios `reduced`, traducidos por el MISMO `displayStatusWhere` que usa el listado

#### Scenario: ids con combinación de filtros
- **GIVEN** servicios que matchean `nasId = "NE8000-1"` Y `search = "juan"`
- **WHEN** se hace `GET /api/pppoe/ids?nasId=NE8000-1&search=juan`
- **THEN** `ids` contiene solo los ids que matchean AMBOS filtros (AND), idéntico al listado con esos mismos filtros

### Requirement: Paridad list↔ids

Para un mismo estado de datos y un mismo conjunto de filtros, el conjunto de ids que devuelve `GET /api/pppoe/ids` SHALL ser EXACTAMENTE igual al conjunto de ids que se obtiene barriendo TODAS las páginas de `GET /api/pppoe` con esos mismos filtros. Esta paridad SHALL estar cubierta por un test automatizado (parity test) por cada filtro y combinación.

#### Scenario: mismo conjunto que el listado paginado
- **GIVEN** un seed de servicios y un filtro `nasId = "NE8000-1"` con 340 matches (14 páginas de 25)
- **WHEN** se barren las 14 páginas de `GET /api/pppoe?nasId=NE8000-1` juntando todos los ids, y se piden `GET /api/pppoe/ids?nasId=NE8000-1`
- **THEN** ambos conjuntos de ids son idénticos (mismos 340 elementos, sin faltantes ni sobrantes)

#### Scenario: paridad Prisma ↔ in-memory
- **GIVEN** el MISMO seed cargado en el adapter Prisma-shape y en el in-memory
- **WHEN** se pide `listAllIds` con un filtro cualquiera en ambos
- **THEN** los dos devuelven el mismo conjunto de ids y el mismo `total`

### Requirement: Precondición de filtro activo

`GET /api/pppoe/ids` SHALL requerir al menos UNO de los filtros de narrowing `{ search, status, nasId }`. Si NINGUNO está presente, el sistema SHALL responder `400` con código `FILTER_REQUIRED` y NO devolver ids. El parámetro `includeUnassigned` NO cuenta como filtro de narrowing (es un toggle de scope).

#### Scenario: sin filtro activo → 400
- **GIVEN** una request sin `search`, sin `status` y sin `nasId`
- **WHEN** se hace `GET /api/pppoe/ids?includeUnassigned=true`
- **THEN** la respuesta es `400` con `code = "FILTER_REQUIRED"` y no se devuelve ningún id

#### Scenario: includeUnassigned solo NO habilita la selección
- **GIVEN** una request con únicamente `includeUnassigned=true` (sin search/status/nasId)
- **WHEN** se hace `GET /api/pppoe/ids?includeUnassigned=true`
- **THEN** la respuesta es `400` `FILTER_REQUIRED` (includeUnassigned no es un filtro de narrowing)

### Requirement: Gate del endpoint de ids

`GET /api/pppoe/ids` SHALL estar protegido por el permiso `pppoe.manage` (NO `pppoe.read`), porque existe exclusivamente para alimentar la mutación bulk.

#### Scenario: sin permiso manage → 403
- **GIVEN** un usuario con `pppoe.read` pero SIN `pppoe.manage`
- **WHEN** hace `GET /api/pppoe/ids?nasId=NE8000-1`
- **THEN** la respuesta es `403`

### Requirement: Botón "Seleccionar los N del filtro" (FE)

El tab PPPoE SHALL mostrar un botón "Seleccionar los N del filtro" visible ÚNICAMENTE cuando hay un filtro activo (`search`, `nasId` o `status` — al menos uno) Y el usuario tiene `pppoe.manage`. Al hacer clic, el FE SHALL obtener los ids del filtro vigente vía `GET /api/pppoe/ids` y CONGELARLOS en la selección (esos ids son los que se mutan). SIN filtro activo el botón NO aparece.

#### Scenario: botón visible solo con filtro activo
- **GIVEN** un operador con `pppoe.manage` y un filtro `nasId = "NE8000-1"` activo
- **WHEN** se renderiza el tab
- **THEN** el botón "Seleccionar los N del filtro" es visible (N = total del listado)

#### Scenario: botón oculto sin filtro
- **GIVEN** un operador con `pppoe.manage` y NINGÚN filtro activo
- **WHEN** se renderiza el tab
- **THEN** el botón "Seleccionar los N del filtro" NO aparece

#### Scenario: botón oculto sin permiso
- **GIVEN** un operador SIN `pppoe.manage` con un filtro activo
- **WHEN** se renderiza el tab
- **THEN** el botón "Seleccionar los N del filtro" NO aparece (gate en el FE, además del 403 del BE)

#### Scenario: clic congela el set
- **GIVEN** un filtro `nasId = "NE8000-1"` con 340 matches
- **WHEN** el operador hace clic en "Seleccionar los N del filtro" y el endpoint devuelve `{ ids: [340 ids], total: 340 }`
- **THEN** la selección queda con esos 340 ids congelados y el toolbar muestra "340 seleccionados"

### Requirement: Congelamiento del set (anti-TOCTOU)

El conjunto seleccionado vía el filtro SHALL congelarse en el FE en el momento del clic. El bulk SHALL mutar EXACTAMENTE los ids capturados, sin re-resolver el filtro server-side al ejecutar. Cambiar cualquier filtro DESPUÉS de seleccionar SHALL LIMPIAR la selección (consistente con el comportamiento actual de limpiar-al-filtrar), para no mutar servicios que el operador ya no está viendo.

#### Scenario: cambiar el filtro tras seleccionar limpia la selección
- **GIVEN** una selección congelada de 340 ids obtenida con `nasId = "NE8000-1"`
- **WHEN** el operador cambia el filtro (ej. escribe en el search, o cambia el NAS, o el status)
- **THEN** la selección se LIMPIA (queda vacía) y el toolbar de selección desaparece

#### Scenario: el bulk usa los ids congelados, no el filtro
- **GIVEN** una selección congelada de 340 ids
- **WHEN** el operador confirma el bulk
- **THEN** el FE envía esos 340 ids literales (particionados en lotes), y el BE NUNCA re-resuelve el filtro — un servicio dado de baja entre seleccionar y confirmar cae en `failed` con `PPPOE_NOT_FOUND`, nunca se toca un servicio fuera del snapshot

### Requirement: Envío en lotes de 200 secuenciales con agregación

Para una selección de más de 200 ids, el FE SHALL particionar la selección en lotes de ≤200 y enviarlos SECUENCIALMENTE (uno por vez, no en paralelo) reutilizando `POST /api/pppoe/bulk/change-plan` SIN modificar su tope de 200 por request. El FE SHALL mostrar progreso por lote y AGREGAR el resultado `{ ok, failed }` de todos los lotes en un resumen único.

#### Scenario: 340 seleccionados → 2 lotes
- **GIVEN** una selección de 340 ids y un plan válido
- **WHEN** el operador confirma el bulk
- **THEN** el FE hace 2 requests secuenciales a `POST /api/pppoe/bulk/change-plan`: el primero con 200 ids, el segundo con 140
- **AND** muestra el progreso "lote 1/2" y luego "lote 2/2 — 340 servicios"

#### Scenario: agregación ok/failed cross-lote
- **GIVEN** una selección de 340 ids donde el lote 1 devuelve `{ ok: [190 ids], failed: [10 ítems] }` y el lote 2 devuelve `{ ok: [135 ids], failed: [5 ítems] }`
- **WHEN** ambos lotes terminan
- **THEN** el resumen agregado muestra `ok = 325` y `failed` = la concatenación de los 15 ítems fallidos (con `username` + `error` de ambos lotes)

#### Scenario: N≤200 flujo intacto
- **GIVEN** una selección de 150 ids (≤200)
- **WHEN** el operador confirma el bulk
- **THEN** el FE hace UN solo request a `POST /api/pppoe/bulk/change-plan` con los 150 ids (idéntico al comportamiento del change padre), sin lotes ni checkbox extra

### Requirement: Corte por fallo de lote entero

Si un lote entero RECHAZA (error de red / 500 / 401 — NO ítems `failed` individuales), el FE SHALL CORTAR el envío de los lotes restantes y mostrar el agregado PARCIAL de lo ya aplicado, más un error claro indicando en qué lote se cortó. Los ítems `failed` individuales (best-effort del bulk) NO cortan el envío.

#### Scenario: rechazo de lote entero corta y reporta parcial
- **GIVEN** una selección de 500 ids (3 lotes: 200 + 200 + 100) donde el 2º lote RECHAZA con error de red
- **WHEN** se ejecuta el bulk
- **THEN** el lote 1 se aplica y su `{ ok, failed }` queda en el agregado
- **AND** los lotes 2 y 3 NO se envían
- **AND** se muestra un error claro ("Se cortó en el lote 2/3. Se aplicaron los N del lote 1.") con el agregado parcial

#### Scenario: ítems failed no cortan
- **GIVEN** una selección de 340 ids (2 lotes) donde el lote 1 devuelve algunos ítems en `failed` (routers caídos) pero responde `200`
- **WHEN** se ejecuta el bulk
- **THEN** el lote 2 SÍ se envía (los `failed` individuales no cortan) y el agregado final incluye ambos lotes

### Requirement: Aviso de lotes y confirmación proporcional

El toolbar de selección SHALL informar, para más de 200 seleccionados, "N seleccionados — se enviará en X lotes de 200" (con `X = ceil(N/200)`) SIN bloquear el botón. Para más de 200, el modal de confirmación SHALL exigir un checkbox obligatorio "Entiendo que voy a cambiar el plan de N servicios" que gatea el botón de confirmar. Para 200 o menos, el flujo actual (sin checkbox, sin aviso de lotes) SHALL permanecer intacto.

#### Scenario: aviso informativo de lotes (no bloquea)
- **GIVEN** una selección de 340 ids
- **WHEN** se renderiza el toolbar de selección
- **THEN** muestra "340 seleccionados — se enviará en 2 lotes de 200" y el botón "Cambiar plan" está HABILITADO (no `aria-disabled`)

#### Scenario: checkbox obligatorio para N>200
- **GIVEN** una selección de 340 ids y el modal de bulk abierto
- **WHEN** el checkbox "Entiendo que voy a cambiar el plan de 340 servicios" NO está tildado
- **THEN** el botón de confirmar está deshabilitado
- **AND** al tildar el checkbox, el botón de confirmar se habilita

#### Scenario: N≤200 sin checkbox
- **GIVEN** una selección de 150 ids y el modal de bulk abierto
- **WHEN** se renderiza el modal
- **THEN** NO aparece el checkbox de confirmación extra y el botón de confirmar sigue el flujo actual (habilitado con un plan elegido)

### Requirement: Comportamiento del cap W1 reemplazado

El comportamiento anterior (más de 200 seleccionados → botón "Cambiar plan" bloqueado con `aria-disabled` y mensaje "máximo 200") SHALL ser REEMPLAZADO por el envío en lotes. Los tests que codificaban el bloqueo (201 → disabled) SHALL reescribirse honestamente para afirmar el comportamiento nuevo (201 → habilitado + aviso de lotes + checkbox de confirmación), NO debilitarse ni borrarse.

#### Scenario: 201 seleccionados ahora es ejecutable
- **GIVEN** una selección de 201 ids
- **WHEN** se renderiza el toolbar
- **THEN** el botón "Cambiar plan" está HABILITADO (no `aria-disabled`) y el aviso indica "se enviará en 2 lotes de 200"
- **AND** al abrir el modal, el checkbox de confirmación de 201 servicios gatea el confirm
