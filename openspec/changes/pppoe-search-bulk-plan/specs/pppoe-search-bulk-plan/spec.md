# Capability: pppoe-search-bulk-plan

Búsqueda de servicios PPPoE por **IP** (`remoteAddress`) y por **MAC** (`callerId`, tolerante a formato) además de username/cliente, y **cambio de plan MASIVO** sobre una selección explícita de servicios (best-effort, con historial por ítem), en el tab PPPoE de Gestión de Red.

## ADDED Requirements

### Requirement: Búsqueda por IP

El `search` de la lista global de PPPoE (`GET /api/pppoe`, `ListAllPppoeServices` → `listAllPaginated`) SHALL matchear también el campo `remoteAddress` (IP asignada), por coincidencia parcial case-insensitive, además de username y nombre del cliente.

#### Scenario: buscar por IP exacta
- **GIVEN** un servicio PPPoE con `remoteAddress = "100.64.28.5"`
- **WHEN** se lista con `search = "100.64.28.5"`
- **THEN** el servicio aparece en el resultado

#### Scenario: buscar por IP parcial
- **GIVEN** servicios con `remoteAddress` `"100.64.28.5"` y `"100.64.28.9"`
- **WHEN** se lista con `search = "100.64.28"`
- **THEN** ambos servicios aparecen en el resultado

#### Scenario: la IP no matchea otros servicios
- **GIVEN** un servicio con `remoteAddress = "100.64.28.5"` y otro con `"10.75.0.1"`
- **WHEN** se lista con `search = "100.64.28.5"`
- **THEN** solo el primero aparece

### Requirement: Búsqueda por MAC tolerante a formato

El `search` SHALL matchear el campo `callerId` (MAC del CPE) cuando el término de búsqueda parece una MAC, tolerando los formatos de entrada `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` y `aabbccddeeff`, independientemente del formato en que la MAC esté persistida (que NO está normalizado en el BE). El matcheo SHALL ser case-insensitive y soportar prefijos parciales.

#### Scenario: MAC en formato con dos puntos
- **GIVEN** un servicio con `callerId = "AA:BB:CC:DD:EE:FF"` (formato persistido)
- **WHEN** se lista con `search = "AA:BB:CC:DD:EE:FF"`
- **THEN** el servicio aparece en el resultado

#### Scenario: MAC en formato con guiones
- **GIVEN** un servicio con `callerId = "AA:BB:CC:DD:EE:FF"` persistido
- **WHEN** se lista con `search = "aa-bb-cc-dd-ee-ff"`
- **THEN** el servicio aparece (la normalización tolera el separador y el case)

#### Scenario: MAC sin separadores
- **GIVEN** un servicio con `callerId = "AA:BB:CC:DD:EE:FF"` persistido
- **WHEN** se lista con `search = "aabbccddeeff"`
- **THEN** el servicio aparece

#### Scenario: MAC parcial
- **GIVEN** un servicio con `callerId = "AA:BB:CC:DD:EE:FF"` persistido
- **WHEN** se lista con `search = "aabbcc"`
- **THEN** el servicio aparece (matcheo por prefijo hex)

#### Scenario: servicio sin MAC vista no matchea
- **GIVEN** un servicio con `callerId = null` (nunca se le vio sesión)
- **WHEN** se lista con `search = "aabbccddeeff"`
- **THEN** el servicio NO aparece por MAC (esperado)

### Requirement: El search sigue matcheando username y cliente (regresión)

El search extendido SHALL preservar el comportamiento actual: matchear `username` y el nombre del cliente del contrato asociado, por coincidencia parcial case-insensitive.

#### Scenario: buscar por username
- **GIVEN** un servicio con `username = "juan@ipnext.com.ar"`
- **WHEN** se lista con `search = "juan"`
- **THEN** el servicio aparece

#### Scenario: buscar por nombre del cliente
- **GIVEN** un servicio cuyo contrato pertenece al cliente `"María González"`
- **WHEN** se lista con `search = "gonz"`
- **THEN** el servicio aparece

### Requirement: `callerId` expuesto en el DTO de lista

El DTO de item de la lista global (`PppoeServiceListItemDto`) SHALL incluir el campo `callerId: string | null` (la MAC del CPE). El DTO SHALL seguir sin exponer nunca el `password`.

#### Scenario: el item incluye la MAC
- **WHEN** se serializa un servicio con `callerId = "AA:BB:CC:DD:EE:FF"` en la lista
- **THEN** el item tiene `callerId = "AA:BB:CC:DD:EE:FF"` y NO tiene campo `password`

#### Scenario: item sin MAC
- **WHEN** se serializa un servicio con `callerId = null`
- **THEN** el item tiene `callerId = null`

### Requirement: Columna MAC visible en la tabla PPPoE (FE)

La tabla del tab PPPoE SHALL mostrar una columna "MAC" con el `callerId` del servicio (decisión del usuario 2026-07-01). Servicios sin MAC SHALL mostrar el marcador "—" accesible (patrón `NoData`), NUNCA string vacío.

#### Scenario: fila con MAC
- **GIVEN** un servicio con `callerId = "AA:BB:CC:DD:EE:FF"`
- **WHEN** se renderiza la tabla
- **THEN** la fila muestra la MAC en la columna "MAC"

#### Scenario: fila sin MAC
- **GIVEN** un servicio con `callerId = null`
- **WHEN** se renderiza la tabla
- **THEN** la columna "MAC" muestra "—" con `aria-label` accesible

### Requirement: Cambio de plan masivo sobre selección explícita

El sistema SHALL exponer `POST /api/pppoe/bulk/change-plan` (gate `pppoe.manage`) que cambia el plan de los servicios cuyos `ids` se pasan explícitamente en el body `{ ids: string[], profile: string, reason?: string }`. El cambio de cada servicio SHALL usar la MISMA lógica que `UpdatePppoeService` (ruteo por `nas.type`: `radius_orchestrator` → `orchestrator.changePlan` con CoA caliente `applyInSession`; otro → `router.updateSecret`). La ejecución SHALL ser best-effort: un ítem que falla NO aborta el lote. La respuesta SHALL ser síncrona `{ ok: string[], failed: { id, username, error }[] }`.

#### Scenario: bulk feliz
- **GIVEN** 3 servicios existentes `s1, s2, s3` y un plan `"IP-50M"` que existe en el catálogo
- **WHEN** se hace `POST /api/pppoe/bulk/change-plan` con `{ ids: ["s1","s2","s3"], profile: "IP-50M" }` y permiso `pppoe.manage`
- **THEN** los 3 servicios cambian al plan `"IP-50M"` en el RADIUS y en la DB
- **AND** la respuesta es `200` con `{ ok: ["s1","s2","s3"], failed: [] }`

#### Scenario: bulk con un ítem que falla — el lote sigue y reporta
- **GIVEN** 3 servicios `s1, s2, s3` donde `s2` está en un NAS cuyo router/orchestrator está caído
- **WHEN** se hace el bulk con `{ ids: ["s1","s2","s3"], profile: "IP-50M" }`
- **THEN** `s1` y `s3` cambian de plan correctamente
- **AND** la respuesta es `200` con `ok = ["s1","s3"]` y `failed = [{ id: "s2", username: "<user de s2>", error: <mensaje> }]`

#### Scenario: bulk con id inexistente
- **GIVEN** los ids `["s1", "no-existe"]` y un plan válido
- **WHEN** se hace el bulk
- **THEN** `s1` cambia de plan y `failed` incluye `{ id: "no-existe", username: "", error: "PPPOE_NOT_FOUND" }`

#### Scenario: bulk con plan inexistente — fail-fast, cero mutación
- **GIVEN** los ids `["s1","s2"]` y `profile = "PLAN-QUE-NO-EXISTE"` (no está en el catálogo `Plan`)
- **WHEN** se hace el bulk
- **THEN** la respuesta es `422` (`PLAN_NOT_FOUND`)
- **AND** NINGÚN servicio cambia de plan (ni en RADIUS ni en DB) — la validación ocurre ANTES de arrancar el lote

#### Scenario: bulk sin permiso
- **GIVEN** un usuario sin el permiso `pppoe.manage`
- **WHEN** hace `POST /api/pppoe/bulk/change-plan`
- **THEN** la respuesta es `403`

#### Scenario: bulk vacío
- **GIVEN** un body con `ids = []`
- **WHEN** se hace el bulk
- **THEN** la respuesta es `400` (o `422` de validación) y no se ejecuta nada

#### Scenario: bulk excede el tope de ids
- **GIVEN** un body con `ids` de longitud mayor a 200
- **WHEN** se hace el bulk
- **THEN** la respuesta es `422` con un mensaje claro de tope excedido y no se ejecuta nada

### Requirement: Historial por ítem con actor y reason

Por cada servicio cuyo plan cambia con éxito en el bulk, el sistema SHALL registrar un evento de historial `'modified'` (best-effort) en el historial del servicio de INTERNET de su contrato, con el actor (usuario que ejecutó), el `reason` provisto (si hay) y las notas `<plan viejo> → <plan nuevo>`. Los servicios sin contrato asociado NO registran evento (no hay contrato al que atarlo).

#### Scenario: evento por ítem exitoso
- **GIVEN** un servicio `s1` con contrato, plan actual `"IP-30M"`, y un bulk a `"IP-50M"` ejecutado por el usuario `"operador1"` con `reason = "promo"`
- **WHEN** el cambio de `s1` tiene éxito
- **THEN** se registra un evento `'modified'` en el historial del contrato de `s1` con `actorName = "operador1"`, `reason = "promo"` y notas `"IP-30M → IP-50M"`

#### Scenario: ítem sin contrato no registra evento
- **GIVEN** un servicio huérfano `s4` (`contractId = null`) incluido en un bulk exitoso
- **WHEN** su plan cambia con éxito
- **THEN** el cambio se aplica pero NO se registra evento de historial (no hay contrato)

### Requirement: Contrato del cambio de plan individual preservado

La extracción de la lógica compartida de cambio de plan SHALL preservar el comportamiento observable de `PATCH /api/pppoe/:id` (`UpdatePppoeService`): mismo ruteo por `nas.type`, mismo `applyInSession` (CoA caliente), mismo registro de evento `'modified'` con actor+reason+`old→new`, mismos códigos de error.

#### Scenario: PATCH de plan sigue funcionando igual
- **GIVEN** un servicio en un NAS `radius_orchestrator`
- **WHEN** se hace `PATCH /api/pppoe/:id` con `{ profile: "IP-50M", reason: "upgrade" }`
- **THEN** se llama `orchestrator.changePlan(username, "IP-50M", { applyInSession: true })`, la DB se actualiza, y se registra el evento `'modified'` con `notes = "<plan viejo> → IP-50M"` — idéntico al comportamiento previo a la extracción
