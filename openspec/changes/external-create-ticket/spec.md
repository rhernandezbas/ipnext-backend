# Spec — external-create-ticket (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Capability nueva
"API externa — escritura de tickets" + el invariante de bootstrap del reporter de sistema.
Tests: `externalV1.tickets.routes.test.ts`, `bootstrapSystemUsers.test.ts`,
`external-ticket-bootstrap-composition.test.ts`, `externalV1-ticket-wiring-composition.test.ts`.

## ADDED Requirements

### Requirement: CT-1 — creación exitosa de ticket externo
`POST /api/external/v1/tickets` MUST crear un ticket vía `CreateTicket` y responder 201 con un
DTO curado (`ExternalTicketDto`), estampando como `reporterId` el usuario de sistema "api"
(resuelto por login, NUNCA tomado del body). El body acepta `subject`, `description`,
`customerId`, `contractId` (ids INTERNOS de Prominense), `area` (nombre del catálogo) y
`priority` (`low|medium|high`).

#### Scenario: creación válida → 201 + reporter "api"
- Given una API-key válida y `customerId`/`contractId` que existen y coinciden (ownership), `area` en el catálogo y `priority` válida
- When `POST /api/external/v1/tickets` con el payload completo
- Then responde 201 con el DTO del ticket y el `reporterId` persistido es el id del usuario "api"

#### Scenario: DTO curado — no filtra campos internos
- Given una creación exitosa
- Then la respuesta NO incluye `reporterId`, `reporterName`, `assigneeId`, `assigneeName`, `areaId`, `areaColor`, `grCasoId`, `customerName` — sí incluye `id`, `sequenceNumber`, `status`, `priority`, `customerId`, `contractId`, `areaName`, `createdAt`

### Requirement: CT-2 — validación de entrada (400)
El endpoint MUST rechazar con 400 `VALIDATION_ERROR` cuando falte un campo requerido, cuando la
`priority` no sea `low|medium|high`, o cuando `subject`/`description` excedan su largo máximo
(200 / 5000). El body no-objeto o con tipos equivocados MUST tratarse como campos ausentes.

#### Scenario: falta un campo requerido → 400
- Given un payload sin `subject`
- When `POST .../tickets`
- Then responde 400 `VALIDATION_ERROR`, sin crear el ticket

#### Scenario: priority inválida → 400 (sin default silencioso)
- Given `priority: "urgent"`
- When `POST .../tickets`
- Then responde 400 `VALIDATION_ERROR` (NO se coacciona a `medium`)

#### Scenario: subject/description demasiado largos → 400
- Given `subject` de 201 chars (o `description` de 5001)
- When `POST .../tickets`
- Then responde 400 `VALIDATION_ERROR`

### Requirement: CT-3 — integridad referencial y ownership (422)
El endpoint MUST delegar la validación de customer/contract a `CreateTicket` y mapear sus
errores a 422: `CUSTOMER_NOT_FOUND`, `CONTRACT_NOT_FOUND`, `CONTRACT_CUSTOMER_MISMATCH`. El
área inexistente en el catálogo MUST responder 422 `TICKET_AREA_NOT_FOUND`.

#### Scenario: customer inexistente → 422
- Given `customerId` que no existe
- Then 422 `CUSTOMER_NOT_FOUND`

#### Scenario: contract inexistente → 422
- Given `contractId` que no existe
- Then 422 `CONTRACT_NOT_FOUND`

#### Scenario: contrato de otro cliente (ownership) → 422
- Given un `contractId` que pertenece a un cliente distinto de `customerId`
- Then 422 `CONTRACT_CUSTOMER_MISMATCH` (no se crea un ticket cruzado)

#### Scenario: área fuera del catálogo → 422
- Given un `area` (nombre) que no existe en `TicketAreaCatalog`
- Then 422 `TICKET_AREA_NOT_FOUND`

### Requirement: CT-4 — autenticación por API-key (M2M)
La superficie externa MUST exigir API-key (`X-API-Key` / `Bearer`); sin key o con key inválida
MUST responder 401 `UNAUTHORIZED`, sin ejecutar la lógica de creación.

#### Scenario: sin API-key → 401
- Given un `POST .../tickets` sin API-key
- Then 401 `UNAUTHORIZED`

### Requirement: CT-5 — reporter de sistema (no spoofeable, guarda 503)
El `reporterId` MUST resolverse server-side por login ("api"); el endpoint MUST NOT leer
`reporterId`/`assigneeId`/`status` del body. Si el usuario "api" no está provisionado, MUST
responder 503 `REPORTER_UNAVAILABLE` (guarda defensiva — nunca debería pasar en prod por CT-6/BOOT-1).

#### Scenario: reporter no provisionado → 503
- Given un entorno donde el usuario "api" no existe
- When `POST .../tickets` con payload válido
- Then 503 `REPORTER_UNAVAILABLE`, sin crear el ticket

### Requirement: CT-6 — rate limiting dedicado a la escritura
`POST /tickets` MUST llevar un rate limiter dedicado (por IP), aplicado SOLO a la escritura; los
GET existentes (#150/#152) MUST quedar sin tocar.

#### Scenario: el wiring monta el rate limiter en el POST
- Given el composition root de `app.ts`
- Then el router externo recibe un `rateLimiter` = `createExternalWriteRateLimiter()` y este se aplica al POST (no a los GET)

## ADDED Requirements — bootstrap del reporter (desacople de GR)

### Requirement: BOOT-1 — el reporter "api" existe INCONDICIONALMENTE
El usuario de sistema "api" MUST bootstrappearse en `main.ts` de forma incondicional y ANTES de
`createApp`, independiente de la config de Gestión Real (que está en deprecación). El bootstrap
MUST ser idempotente. `bootstrapGestionRealIngest` MUST NOT ser el único lugar que lo crea.

#### Scenario: creación en DB fresca (sin GR)
- Given una DB sin el usuario "api" y GR deshabilitado
- When corre `bootstrapSystemUsers`
- Then el usuario "api" queda creado (`login: 'api'`) y su id es usable como `reporterId`

#### Scenario: idempotencia
- Given el usuario "api" ya existe
- When corre `bootstrapSystemUsers` de nuevo
- Then devuelve el MISMO id, sin duplicar ni tocar el passwordHash

#### Scenario: incondicionalidad (composition-root)
- Given el source de `main.ts`
- Then la llamada `await bootstrapSystemUsers(` es una statement top-level del IIFE (no envuelta en un `if`) y corre ANTES de `createApp`; y `bootstrapGestionRealIngest` ya NO llama `bootstrapApiUser`

### Requirement: WIRING-1 — el endpoint está montado en prod
El `app.ts` MUST pasar al `createExternalV1Router` los `ticketDeps` (`createTicket`,
`rbacUserRepo`, `ticketAreaRepo`, `rateLimiter`), de modo que `POST /tickets` exista en prod
(anti bug W6 "feature muerta"). `createTicket` MUST tener inyectados los lookups de ownership.

#### Scenario: mount con ticketDeps (composition-root)
- Given el source de `app.ts`
- Then el mount de `/api/external/v1` pasa `createTicket` + `rbacUserRepo` + `ticketAreaRepo` + `rateLimiter: createExternalWriteRateLimiter()`
