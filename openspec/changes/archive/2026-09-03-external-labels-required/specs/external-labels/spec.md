# Spec — external-labels (new capability)

RFC-2119. Capacidad NUEVA: el catálogo de labels de Chatwoot expuesto por la **API Externa M2M**
(`/api/external/v1/messaging/bulk/labels`, key dedicada). No reabre `external-bulk-messaging` (ver
el delta de ese domain para el label obligatorio) ni la capacidad admin `campaign-chatwoot-label`
(`GET|POST /api/messaging/bulk/chatwoot-labels`, sesión + RBAC): esas rutas quedan **intactas**.
Cada scenario debe quedar cubierto por al menos un test Jest verde (sdd-verify arma la matriz
spec↔test).

## Purpose

Antes de este change, un caller M2M (una IA) sólo podía ADIVINAR el título de un label existente:
sin catálogo consultable y sin forma de crear uno, `chatwootLabel` era un campo de fe. Esta
capacidad expone el catálogo y su creación por la MISMA key dedicada y el MISMO kill-switch que el
resto de la API Externa, reusando los use cases admin `ListChatwootLabels` / `CreateChatwootLabel`
sin modificarlos.

---

## Capability: catálogo de labels por la API Externa

### Requirement: LBL-1 — listado del catálogo vivo
`GET /api/external/v1/messaging/bulk/labels` MUST devolver 200 con `{data: [{title, color}]}` —
el catálogo REAL de la cuenta de Chatwoot, sin filtrar ni cachear, exactamente el mismo dato que
sirve la ruta admin `GET /api/messaging/bulk/chatwoot-labels`. Chatwoot inalcanzable MUST responder
503 `CHATWOOT_UNAVAILABLE` (fail-closed, MUST NOT degradar a `[]`). La ruta MUST NOT estar sujeta al
rate limiter de escritura (es una lectura, mismo criterio que `GET /templates` y `GET /credit`).

#### Scenario: catálogo con labels
- Given el catálogo vivo contiene `promo-agosto` y `soporte`
- When `GET .../labels` con la key dedicada
- Then responde 200 con `{data:[{title:'promo-agosto',color},{title:'soporte',color}]}`

#### Scenario: catálogo vacío
- Given la cuenta de Chatwoot no tiene ningún label
- When `GET .../labels`
- Then responde 200 con `{data: []}` (no 404)

#### Scenario: Chatwoot caído
- Given `listAccountLabels` lanza (timeout/5xx)
- When `GET .../labels`
- Then responde 503 `CHATWOOT_UNAVAILABLE`

#### Scenario: el GET no consume el presupuesto de escritura
- Given un rate limiter de escritura de N requests
- When se hacen N+1 `GET .../labels`
- Then ninguno responde 429

### Requirement: LBL-2 — creación de label con normalización del título, idempotente
`POST /api/external/v1/messaging/bulk/labels` MUST aceptar `{title: string, color?: string}`. Un
título NUEVO (tras normalizar) MUST responder 201 con la ficha FLAT del label creado (`{title,
color, created:true}`).

El título MUST normalizarse ANTES de llegar a Chatwoot, con esta regla exacta y en este orden:
`trim` → `toLowerCase` → cada run de whitespace interno → un único `-`. El título normalizado es el
que se persiste y el que se devuelve. `color` ausente MUST resolver a un default hexadecimal fijo
del sistema; `color` presente MUST ser `#RGB` o `#RRGGBB`.

Body inválido MUST responder 400 `VALIDATION_ERROR` **antes** de tocar Chatwoot: `title` ausente/no
string, `title` vacío o whitespace puro (incluso tras normalizar), `title` de más de 100 caracteres
(**fix wave F1, finding 4** — `z.string().min(1).max(100)`, mismo límite que Chatwoot aplica del
lado del server), `title` que contiene, tras normalizar, algún carácter fuera de
`[letras unicode, números, "_", "-"]` (**fix wave F1, finding 3a** — el mensaje del 400 MUST listar
los caracteres ofensores), `color` que no matchea el formato hex, o `description` presente (campo NO
soportado por el modelo de label — MUST rechazarse explícitamente, MUST NOT descartarse en
silencio).

Un título YA existente en el catálogo (comparación contra el catálogo vivo, por título normalizado,
exacta y case-sensitive sobre el valor ya en minúsculas) MUST responder **200** (no 409/4xx) con la
ficha FLAT del label EXISTENTE (`{title, color, created:false}`) **sin crear nada** — la operación
es IDEMPOTENTE: un caller M2M que reintenta una creación recibe éxito, no un error (**decisión del
orquestador, 2026-09-03**: reemplaza el 409 `CHATWOOT_LABEL_EXISTS` de una iteración anterior de
este spec). Cualquier otra falla de Chatwoot MUST responder 503 `CHATWOOT_UNAVAILABLE`.

**fix wave F1 (finding 3b)** — si `createAccountLabel` falla DESPUÉS de que el pre-chequeo pasó (el
título no estaba en el catálogo en ese momento), el sistema MUST re-listar el catálogo UNA vez antes
de responder 503: si el título normalizado YA existe (otro request ganó la carrera TOCTOU), MUST
responder el mismo 200 idempotente `{...existingLabel, created:false}`; si sigue sin existir (o el
re-listado también falla), MUST responder 503 `CHATWOOT_UNAVAILABLE`.

#### Scenario: creación normalizada
- Given el catálogo NO contiene `prueba-api-externa`
- When `POST .../labels` con `{title:"  Prueba API Externa  "}`
- Then responde 201 con `{title:'prueba-api-externa', color:<default>, created:true}`
- And Chatwoot recibió `title:'prueba-api-externa'` (no el crudo)

#### Scenario: color explícito
- Given `{title:"promo", color:"#FF6B00"}`
- When `POST .../labels`
- Then responde 201 con `color:'#FF6B00'`

#### Scenario: color inválido
- Given `{title:"promo", color:"naranja"}`
- When `POST .../labels`
- Then responde 400 `VALIDATION_ERROR`, sin llamar a Chatwoot

#### Scenario: title vacío tras normalizar
- Given `{title:"   "}`
- When `POST .../labels`
- Then responde 400 `VALIDATION_ERROR`, sin llamar a Chatwoot

#### Scenario: description no soportada
- Given `{title:"promo", description:"campaña de septiembre"}`
- When `POST .../labels`
- Then responde 400 `VALIDATION_ERROR` (el campo no existe en el modelo de label), sin crear nada

#### Scenario: label duplicado — idempotente (decisión del orquestador)
- Given el catálogo vivo ya contiene `promo-agosto`
- When `POST .../labels` con `{title:"Promo Agosto"}` (normaliza a `promo-agosto`)
- Then responde 200 con `{title:'promo-agosto', color:<del catálogo>, created:false}`, y Chatwoot NO
  recibió ningún POST de creación (`createAccountLabel` NO fue llamado)

#### Scenario: Chatwoot caído durante la creación
- Given el pre-chequeo del catálogo pasa, `createAccountLabel` lanza, Y el re-chequeo (finding 3b)
  TAMPOCO encuentra el título
- When `POST .../labels`
- Then responde 503 `CHATWOOT_UNAVAILABLE`

#### Scenario: TOCTOU — otro request ganó la carrera (fix wave F1, finding 3b, nuevo)
- Given el pre-chequeo del catálogo NO contiene `promo`, `createAccountLabel` lanza, pero el
  RE-chequeo (después de la falla) SÍ encuentra `promo` en el catálogo
- When `POST .../labels` con `{title:"promo"}`
- Then responde 200 `{title:'promo', color:<del catálogo>, created:false}`, NUNCA 503

#### Scenario: título con caracteres no soportados (fix wave F1, finding 3a, nuevo)
- Given `{title:"promo #agosto 🎉"}`
- When `POST .../labels`
- Then responde 400 `VALIDATION_ERROR` con un mensaje que lista los caracteres ofensores (`#`, `🎉`),
  sin llamar a Chatwoot

#### Scenario: título de más de 100 caracteres (fix wave F1, finding 4, nuevo)
- Given `{title:"a".repeat(101)}`
- When `POST .../labels`
- Then responde 400 `VALIDATION_ERROR`, sin llamar a Chatwoot

### Requirement: LBL-3 — key dedicada y kill-switch aplican a AMBAS rutas
`GET` y `POST .../labels` MUST exigir la key DEDICADA (`config.externalMessaging.apiKey`,
AUTH-1/AUTH-2): sin key o con la key GLOBAL del `/api/external/v1` MUST responder 401
`UNAUTHORIZED`. Con el flag `messaging-external-bulk-enabled` OFF, ausente, o si su lectura lanza,
ambas rutas MUST responder 403 `FEATURE_DISABLED` **antes** de tocar Chatwoot (fail-safe a OFF,
mismo criterio KS-1/TPL-0). `POST .../labels` MUST estar sujeto al rate limiter de escritura.

#### Scenario: sin key
- Given un request sin header de api-key
- When `GET .../labels`
- Then responde 401 `UNAUTHORIZED`

#### Scenario: flag apagado
- Given el flag `messaging-external-bulk-enabled` en `false`
- When `GET .../labels` o `POST .../labels` con la key dedicada
- Then responde 403 `FEATURE_DISABLED`, sin ninguna llamada a Chatwoot

#### Scenario: el repo de flags lanza
- Given `FeatureFlagRepository.get()` tira
- When `POST .../labels`
- Then responde 403 `FEATURE_DISABLED` (nunca se interpreta el error como flag ON)

### Requirement: LBL-4 — la creación queda auditada, el listado no
`POST .../labels` MUST dejar un registro de auditoría con `actorLogin:'api-messaging'` y un
`actorId` no nulo (mismo `machineActorMiddleware` + `auditMutationsMiddleware` que cubre el resto
de los POST del prefijo, AUDIT-2). `GET .../labels` MUST NOT auditarse (es una lectura).

#### Scenario: creación auditada
- Given un `POST .../labels` exitoso con la key dedicada
- When se procesa el request
- Then queda una fila de auditoría con `actorLogin:'api-messaging'` y `actorId` no nulo

#### Scenario: el listado no audita
- Given un `GET .../labels`
- When se procesa
- Then no se agrega ninguna fila de auditoría

### Requirement: LBL-5 — la ruta admin NO cambia
`GET|POST /api/messaging/bulk/chatwoot-labels` (sesión + RBAC `messaging.templates`/
`messaging.manage`) MUST conservar su comportamiento actual: sin normalización de título, sin
default de color, sin 409 por duplicado. Los use cases `ListChatwootLabels` y `CreateChatwootLabel`
MUST NOT cambiar de firma ni de semántica; la normalización, el default de color y el pre-chequeo
de duplicado son responsabilidad EXCLUSIVA de la capa HTTP externa.

#### Scenario: el admin sigue sin normalizar
- Given un `POST /api/messaging/bulk/chatwoot-labels` con `{title:"Promo Agosto", color:"#FF6B00"}`
- When se procesa con sesión y `messaging.manage`
- Then Chatwoot recibe `title:"Promo Agosto"` TAL CUAL (comportamiento preexistente, sin regresión)

#### Scenario: el admin sigue sin default de color
- Given un `POST /api/messaging/bulk/chatwoot-labels` sin `color`
- When se procesa
- Then responde 400 `VALIDATION_ERROR` (comportamiento preexistente)
