# Spec — external-bulk-messaging (new capability)

RFC-2119. Capacidad NUEVA (proposal: "Modified Capabilities: None") — no reabre
`messaging-bulk` (TPL/SEG/CAMP/SEND/HIST/OPT/RBAC), lo REUSA vía `CreateCampaign`/
`matchManualContacts`/`CampaignRunner` sin alterar su spec. Cada scenario debe quedar
cubierto por al menos un test Jest verde (sdd-verify arma matriz spec↔test).

---

## Capability: autenticación M2M dedicada

### Requirement: AUTH-1 — key dedicada requerida
Todas las rutas de este router MUST exigir `X-Api-Key` validada contra
`config.externalMessaging.apiKey` (comparación constant-time, molde `createApiKeyMiddleware`).

#### Scenario: sin header → 401
- Given un request sin `X-Api-Key`
- When se llama a `POST .../messaging/bulk/validate` o `.../send`
- Then responde 401 `UNAUTHORIZED`, sin ejecutar lógica de negocio

#### Scenario: key incorrecta → 401
- Given `X-Api-Key` con un valor que no matchea la key dedicada configurada
- When se llama a cualquier ruta de este router
- Then responde 401 `UNAUTHORIZED`

### Requirement: AUTH-2 — la key GLOBAL del `/api/external/v1` no sirve acá
La key global (`config.externalApi.apiKey`, usada por `/tickets`/`/news`) MUST NOT autenticar
este router; ambas keys son independientes.

#### Scenario: key global válida, pero no la dedicada → 401
- Given `X-Api-Key` = key global válida (la que sí abre `/tickets`)
- When se llama a `POST .../messaging/bulk/validate`
- Then responde 401 `UNAUTHORIZED` (la key global NO es intercambiable con la dedicada)

### Requirement: AUTH-3 — fail-closed si la key dedicada no está configurada
Si `EXTERNAL_MESSAGING_API_KEY` está ausente o vacía, el router MUST rechazar TODO request con
401 (nunca abrir el endpoint sin key, nunca aceptar "cualquier key" por default).

#### Scenario: env var vacía/ausente en el proceso
- Given `config.externalMessaging.apiKey === ''`
- When se llama con cualquier `X-Api-Key` (incluso vacío)
- Then responde 401 `UNAUTHORIZED` en TODOS los casos

---

## Capability: kill-switch de acceso

### Requirement: KS-1 — flag `messaging-external-bulk-enabled` gatea validate y send
Ambos endpoints MUST leer el flag antes de cualquier otra lógica; `enabled !== true` (OFF,
ausente, o error del repo de flags) MUST responder 403 `FEATURE_DISABLED` (fail-safe a OFF,
molde `resolveViaChat`).

#### Scenario: flag OFF → validate rechazado
- Given el flag en `enabled: false`
- When `POST .../validate` con payload válido
- Then responde 403 `FEATURE_DISABLED`, sin persistir preview

#### Scenario: flag OFF → send rechazado aunque el preview sea válido
- Given un preview `valid` y no vencido, pero el flag pasó a `false` DESPUÉS de crearse
- When `POST .../send`
- Then responde 403 `FEATURE_DISABLED`, sin crear `Campaign` ni consumir el preview

#### Scenario: repo de flags falla → fail-safe a OFF
- Given `FeatureFlagRepository.get()` lanza una excepción
- When se llama a `validate` o `send`
- Then AMBOS responden 403 `FEATURE_DISABLED` (nunca se interpreta el error como "flag ON")

---

## Capability: validate — preview de 2 pasos

### Requirement: VAL-1 — forma del input
El body MUST tener `recipients: {phone: string, name?: string, variables?: Record<string,string>}[]`
(no vacío), `templateRef` (o `templateName`), `variables?: Record<string,string>` (GLOBAL, default
aplicado a todos), y `chatwootLabel?: string`. El `variables` POR-RECIPIENT pisa al GLOBAL **por
key** (merge, no reemplazo del mapa). Forma inválida (tipos equivocados, `recipients` vacío o
no-array, valores de `variables` que no son string, `templateRef` ausente) MUST responder 400
`VALIDATION_ERROR` antes de tocar Chatwoot/DB.

#### Scenario: recipients vacío → 400
- Given `recipients: []`
- When `POST .../validate`
- Then responde 400 `VALIDATION_ERROR`, sin llamar a Chatwoot ni persistir preview

#### Scenario: falta templateRef → 400
- Given un body sin `templateRef`/`templateName`
- When `POST .../validate`
- Then responde 400 `VALIDATION_ERROR`

### Requirement: VAL-2 — normalización E.164 AR móvil + razones de invalidez
Cada `recipient.phone` MUST normalizarse a E.164 argentino de línea móvil; los que no
normalizan (formato) van a `invalid` con `reason` propia. Duplicados
DENTRO del batch (mismo E.164 normalizado) MUST excluirse del segundo en adelante con
`reason:'duplicate'`; números con opt-out (match exacto o por sufijo, molde `matchManualContacts`)
MUST excluirse con `reason:'opted_out'`.

#### Scenario: teléfono no normalizable
- Given un recipient con `phone:"123"`
- When se valida el batch
- Then cae en `invalid` con `reason` de formato inválido; no cuenta en `valid`

#### Scenario: NSN de 10 dígitos limpio es SIEMPRE móvil — AMENDED, fix wave F3 (S1, smoke en vivo)
> LIVE: `{"phone":"1178547218"}` caía en `invalid` con `reason:'non_mobile'` (y con eso solo, en
> `EMPTY_RECIPIENTS`), pero el motor de envío (`toWhatsAppE164`, el MISMO que usa `send`) SIEMPRE
> reconstruyó ese crudo como móvil (`+5491178547218`) — `validate` rechazaba lo que `send` hubiera
> aceptado igual. En el plan de numeración argentino, un NSN ([área][abonado]) de 10 dígitos limpio
> ES la forma canónica del móvil — el "9"/"15" son artefactos de discado, no parte del número.
> `classifyArPhone` pasa a ser un wrapper CONSISTENTE con `toWhatsAppE164`: `non_mobile` YA NO SE
> EMITE (el literal se mantiene en `ExternalBulkInvalidReason`, D12, por estabilidad de wire).
- Given un recipient con `phone:"1178547218"` (NSN de 10 dígitos, sin "9"/"15")
- When se valida
- Then cae en `valid` con `phone:"+5491178547218"` — NUNCA en `invalid` con `reason:'non_mobile'`
- And lo mismo para `"11 7854-7218"`, `"011 15 7854 7218"`, `"+54 9 11 7854 7218"`, `"549 11 7854 7218"` — todos resuelven al MISMO E.164

#### Scenario: número EXTRANJERO nunca se reconstruye como argentino — AMENDED, fix wave F1 (F11)
> El clasificador de móvil daba `true` para CUALQUIER crudo de 12 dígitos (asumiendo el formato
> local `[área][15][abonado]`). Un móvil extranjero de 12 dígitos cuyo "15" cae, por casualidad, en
> un borde de área AR válido pasaba el gate Y `toWhatsAppE164` lo "reconstruía" a un `+549…` que NO
> es el número del caller — un mensaje al número EQUIVOCADO, con los datos personales de otro. La
> regla nueva discrimina por FORMATO, no por longitud: si el crudo viene en forma internacional
> explícita (`+` o el prefijo de acceso `00`), el país DEBE ser `54`.
- Given un recipient con `phone:"+57 315 234 5678"` (Colombia; 12 dígitos, "15" en un borde de área AR válido)
- When se valida
- Then cae en `invalid` con `reason:'telefono_invalido'` — NUNCA en `valid`, y NUNCA con un `+549…` reconstruido
- And lo mismo para `+55…`, `+1…`, `+34…`, `+598…`
- And las formas AR válidas (`+5491123456789`, `54911…`, `011 15-…`, `11 15-…`) siguen resolviendo al MISMO E.164 de siempre

#### Scenario: duplicado dentro del mismo batch
- Given dos recipients cuyo `phone` normaliza al MISMO E.164
- When se valida
- Then el primero entra en `valid`; el segundo cae en `invalid` con `reason:'duplicate'`

#### Scenario: número con opt-out
- Given un recipient cuyo E.164 matchea `Client.whatsappOptOutAt != null` (exacto o sufijo)
- When se valida
- Then cae en `invalid` con `reason:'opted_out'`, excluido de `valid` y de `counts.valid`

### Requirement: VAL-3 — renderizado del mensaje POR RECIPIENT
El sistema MUST renderizar el body del template (`renderTemplateBody`) UNA VEZ POR RECIPIENT, con
el mapa resultante del merge de VAL-10. Cada recipient `valid` MUST llevar su `renderedMessage`
propio en la respuesta. El `renderedMessage` de nivel superior MUST ser una MUESTRA — el del PRIMER
recipient `valid` (`''` si no hay ninguno) — y MUST NOT interpretarse como el texto de todos.
Un recipient cuyo merge NO resuelve todos los placeholders NO se renderiza: cae en `invalid`
(VAL-10), y el batch sigue.

#### Scenario: dos recipients, dos mensajes distintos
- Given un template `"Hola {{1}}"` y dos recipients con `variables:{"1":"Ana"}` y `{"1":"Beto"}`
- When `POST .../validate`
- Then `valid[0].renderedMessage === "Hola Ana"`, `valid[1].renderedMessage === "Hola Beto"`
- And el `renderedMessage` de nivel superior es `"Hola Ana"` (muestra del primero)

#### Scenario: sin recipients válidos no hay muestra
- Given un batch donde TODOS los recipients caen en `invalid`
- When `POST .../validate`
- Then responde 422 `EMPTY_RECIPIENTS` (no se persiste un preview sin destino)

### Requirement: VAL-4 — template debe estar APROBADO
`templateRef` MUST corresponder a un template `approvalStatus === 'approved'` (TPL-2 de
`messaging-bulk`, reusado); inexistente o no-aprobado MUST responder 422 `TEMPLATE_NOT_APPROVED`.

#### Scenario: template pendiente de aprobación
- Given `templateRef` con `approvalStatus:'pending'`
- When `POST .../validate`
- Then responde 422 `TEMPLATE_NOT_APPROVED`, sin persistir preview

### Requirement: VAL-5 — label de Chatwoot debe existir en el catálogo vivo
Si `chatwootLabel` está presente, el sistema MUST consultar `ListChatwootLabels` en vivo; label
inexistente MUST responder 422 `CHATWOOT_LABEL_NOT_FOUND`; Chatwoot inalcanzable MUST responder
503 `CHATWOOT_UNAVAILABLE`. El sistema MUST NUNCA crear el label.

#### Scenario: label inexistente
- Given `chatwootLabel:"no-existe"` y el catálogo vivo no lo contiene
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_NOT_FOUND`

#### Scenario: Chatwoot caído
- Given `ListChatwootLabels` lanza (timeout/5xx)
- When `POST .../validate` con `chatwootLabel` presente
- Then responde 503 `CHATWOOT_UNAVAILABLE`, sin persistir preview ni aceptar a ciegas

### Requirement: VAL-6 — tope por request (`maxPerRequest`, default 500)
Si el conteo de `valid` (post-normalización/dedup/opt-out) excede `maxPerRequest`, MUST responder
422 `CAP_EXCEEDED` con `{limit:'perRequest', maxPerRequest, received}`.

#### Scenario: 501 válidos con tope 500
- Given `maxPerRequest = 500` y el batch resuelve 501 recipients `valid`
- When `POST .../validate`
- Then responde 422 `CAP_EXCEEDED` con `limit:'perRequest'`, sin persistir preview

### Requirement: VAL-7 — tope diario (`maxPerDay`, default 2000) sobre lo AUTORIZADO
> **AMENDED — fix wave F1 (finding F2).** La versión original contaba `status='sent'`, lo que hacía
> el cupo INEXIGIBLE: el envío corre asincrónico detrás del `CampaignRunner`, así que entre el `send`
> que autoriza N destinatarios y el momento en que salen, el conteo devuelve ~0 y el lote siguiente
> pasa igual (traza K1/K2/K3 verificada: 3N autorizados con `maxPerDay = 2N`). Además `delivered`
> desaparecía del conteo al avanzar de estado. Ver design D6.

`remainingToday` MUST calcularse como `maxPerDay - count(CampaignRecipient de Campaigns con
createdById = api-messaging, con `createdAt` dentro del día calendario Argentina — INCLUSIVO en el
inicio del día — y `status NOT IN ('skipped','opted_out')`)`. Es decir: cuenta TODO intento
AUTORIZADO (`queued|sent|delivered|failed`), que quema cupo en el instante en que la `Campaign` se
crea. Si `valid.length > remainingToday`, MUST responder 422 `CAP_EXCEEDED` con `{limit:'perDay',
remainingToday}`.

#### Scenario: cupo diario ya consumido por envíos previos
- Given 1990 recipients ya AUTORIZADOS hoy (AR) de campañas `api-messaging` y `maxPerDay = 2000`
- When se valida un batch de 15 `valid`
- Then responde 422 `CAP_EXCEEDED` con `limit:'perDay', remainingToday: 10`

#### Scenario: el cupo NO espera al envío real — AMENDED, fix wave F1 (F2)
- Given `maxPerDay = 2N` y un `send` (K1) que YA creó una campaña de N destinatarios, ninguno `sent` todavía
- When llega un segundo `send` (K2) de N y después un tercero (K3) de N
- Then K2 pasa (2N autorizados = el tope exacto) y K3 responde 422 `CAP_EXCEEDED` con `limit:'perDay'`
- And K3 MUST NOT crear ninguna `Campaign`

#### Scenario: `delivered` sigue contando; `skipped`/`opted_out` no
- Given un recipient autorizado hoy que ya avanzó a `delivered`
- Then MUST seguir contando contra el cupo (no desaparece al cambiar de estado)
- And un recipient en `skipped` u `opted_out` MUST NOT contar (nunca se le autorizó un mensaje)

#### Scenario: previews no consumidos no descuentan cupo
- Given otro preview `valid` de 100 recipients, NUNCA enviado (no consumido)
- When se calcula `remainingToday` para un nuevo `validate`
- Then el cupo NO se ve afectado por ese preview no-consumido (solo cuenta `sent` real)

### Requirement: VAL-8 — preview persistido con hash + expiración de 15 min
`validate` exitoso MUST persistir `ExternalBulkPreview` con `payloadHash` (hash canónico del
input normalizado), `expiresAt = createdAt + 15min`, y `consumedAt: null`.

#### Scenario: dos validate idénticos generan previews independientes
- Given el mismo payload enviado dos veces
- When se llama `validate` dos veces seguidas
- Then se crean DOS `ExternalBulkPreview` con `previewId` distinto, cada uno con su propio
  `expiresAt` (15 min desde su propia creación)

### Requirement: VAL-9 — forma de la respuesta
200 MUST devolver `{previewId, expiresAt, renderedMessage /*muestra, VAL-3*/,
counts:{received,valid,invalid,optedOut,duplicated}, valid:[{phone,name,variables,
renderedMessage}], invalid:[{input,reason,missingVariables?}], caps:{maxPerRequest,maxPerDay,
remainingToday}, credit:{available,currency,category,unitCost,estimatedCost,sufficient,
categoryAssumed?,unknown?}, warnings?:['INSUFFICIENT_CREDIT'|'CREDIT_UNAVAILABLE']}`.
`valid[].variables` MUST ser el mapa MERGEADO efectivo de ese recipient (no el
global crudo) — es lo que el humano audita antes de autorizar el `send`. El bloque `credit` MUST calcularse según
`messaging-credit-guard` (COST-1..4, CG-VAL-1) y MUST NUNCA convertir un 200 en error por
insuficiencia/inalcanzabilidad de crédito (eso es CG-VAL-1, `warnings`, no un código 4xx/5xx).
(Previously: la respuesta no incluía `credit` ni `warnings` — solo conteos/caps.)

#### Scenario: respuesta completa con mezcla de válidos/inválidos
- Given un batch con 2 válidos, 1 duplicado, 1 opt-out, 1 formato inválido
- When `POST .../validate`
- Then `counts = {received:5, valid:2, invalid:2, optedOut:1, duplicated:1}` y `invalid` trae los
  3 excluidos con su `reason` propia
- And cada entrada de `valid` trae su `variables` mergeado y su `renderedMessage` propio

#### Scenario: la respuesta trae el bloque credit (nuevo, twilio-credit-guard)
- Given un batch con 2 `valid`, template `UTILITY`, tarifas y saldo suficientes
- When `POST .../validate`
- Then la respuesta 200 incluye `credit:{available, currency, category:'UTILITY', unitCost,
  estimatedCost, sufficient:true}` junto a `counts`/`caps`/`valid`/`invalid` de siempre
- And no hay `warnings` en la respuesta (crédito suficiente, sin degradación)

#### Scenario: warnings conviven con un 200 exitoso
- Given el mismo batch, pero con `estimatedCost > available`
- When `POST .../validate`
- Then sigue respondiendo 200 (VAL-9 no cambia de código por esto), con
  `credit.sufficient:false` y `warnings:['INSUFFICIENT_CREDIT']` agregados a la respuesta

### Requirement: VAL-10 — resolución de variables POR RECIPIENT
El sistema MUST calcular, para cada recipient, `merged = {...variablesGlobales,
...recipient.variables}` (la key del recipient GANA). Tras el merge, TODA variable declarada por el
template (`TemplateDto.variables`, y por extensión todo placeholder `{{n}}` de su body) MUST estar
presente y no vacía; si falta alguna, ESE recipient MUST caer en `invalid` con
`reason:'variables_faltantes'` y `missingVariables: string[]` (las keys faltantes, ordenadas) — el
batch NO se rechaza entero. Variables EXTRA no declaradas MUST permitirse y MUST ignorarse en el
render (mismo criterio no-bloqueante de CAMP-3 de `messaging-bulk`, reusado sin cambiarlo). El
`payloadHash` (VAL-8) MUST incluir el `variables` por-recipient con sus keys ORDENADAS.

#### Scenario: el valor por-recipient pisa al global
- Given `variables:{"1":"Cliente","2":"hoy"}` global y un recipient con `variables:{"1":"Ana"}`
- When `POST .../validate`
- Then el merge de ESE recipient es `{"1":"Ana","2":"hoy"}` (override por key, `"2"` sobrevive)

#### Scenario: variable faltante invalida SOLO a ese recipient
- Given un template que declara `{"1","2"}`, `variables` global `{"1":"Hola"}`, un recipient A con
  `variables:{"2":"Ana"}` y un recipient B sin `variables`
- When `POST .../validate`
- Then A entra en `valid`; B cae en `invalid` con `reason:'variables_faltantes'` y
  `missingVariables:["2"]`
- And responde 200 (NUNCA 422 `MISSING_TEMPLATE_VARIABLES` por culpa de B)

#### Scenario: variable extra no declarada — permitida e ignorada
- Given un recipient con `variables:{"1":"Ana","99":"basura"}` y un template que solo declara `{"1"}`
- When `POST .../validate`
- Then el recipient entra en `valid`, `renderedMessage` no contiene `"basura"`, y no hay error

#### Scenario: el hash distingue variables por-recipient
- Given dos batches IDÉNTICOS salvo el `variables` de UN recipient (`{"1":"Ana"}` vs `{"1":"Beto"}`)
- When se calcula `payloadHash` de cada uno
- Then los dos hashes MUST ser distintos
- And reordenar las KEYS del mismo mapa de variables MUST producir el MISMO hash

---

## Capability: send — consumo del preview

### Requirement: SEND-1 — requiere `previewId` + `Idempotency-Key`
`POST .../send` MUST exigir `previewId` en el body Y el header `Idempotency-Key`; falta cualquiera
de los dos MUST responder 400 `VALIDATION_ERROR`.

#### Scenario: sin Idempotency-Key
- Given un body `{previewId}` válido pero sin el header `Idempotency-Key`
- When `POST .../send`
- Then responde 400 `VALIDATION_ERROR`, sin tocar el preview

### Requirement: SEND-2 — ciclo de vida del preview
`previewId` inexistente MUST responder 404 `PREVIEW_NOT_FOUND`. Vencido (`now > expiresAt`) y aún
no consumido MUST responder 410 `PREVIEW_EXPIRED`. Ya consumido por OTRA `Idempotency-Key` MUST
responder 409 `PREVIEW_ALREADY_CONSUMED` (el replay de la MISMA key sigue el camino idempotente,
ver SEND-6).

#### Scenario: previewId inexistente
- Given un `previewId` que no matchea ningún `ExternalBulkPreview`
- When `POST .../send`
- Then responde 404 `PREVIEW_NOT_FOUND`

#### Scenario: preview vencido
- Given un preview con `expiresAt` en el pasado y `consumedAt: null`
- When `POST .../send`
- Then responde 410 `PREVIEW_EXPIRED`, sin crear `Campaign`

#### Scenario: vencido Y consumido — gana el 410 — AMENDED, fix wave F1 (F10)
> El código chequeaba `consumedAt` ANTES que `expiresAt`, invirtiendo el orden que enumera este
> requirement: un preview vencido y consumido devolvía 409, que le sugiere al caller "reintentá con
> otra key", cuando la verdad es "ese preview ya no sirve para nadie".
- Given un preview con `expiresAt` en el pasado Y `consumedAt` seteado
- When `POST .../send`
- Then responde 410 `PREVIEW_EXPIRED` (el vencimiento es la condición MÁS FUERTE), no 409

#### Scenario: preview ya consumido por otra key
- Given un preview con `consumedAt` seteado por una `Idempotency-Key` distinta
- When `POST .../send` con una `Idempotency-Key` nueva sobre el MISMO `previewId`
- Then responde 409 `PREVIEW_ALREADY_CONSUMED`, sin crear una segunda `Campaign`

### Requirement: SEND-3 — mismatch de payload
Si el request de `send` incluye el payload original (o su hash) junto al `previewId`, el sistema
MUST re-hashear y compararlo contra el `payloadHash` guardado; distinto MUST responder 409
`PREVIEW_PAYLOAD_MISMATCH` — nunca éxito silencioso con datos viejos.

#### Scenario: hash distinto para el mismo previewId
- Given un preview con `payloadHash = H1` y un `send` que incluye un payload cuyo hash es `H2 != H1`
- When `POST .../send`
- Then responde 409 `PREVIEW_PAYLOAD_MISMATCH`, sin crear `Campaign` ni consumir el preview

### Requirement: SEND-4 — re-validación completa al momento del send
`send` MUST re-chequear: flag ON (KS-1), template sigue `approved` (VAL-4), topes vigentes
(VAL-6/VAL-7), opt-out no cambió desde el `validate`, Y (nuevo, `twilio-credit-guard`) crédito
suficiente contra los destinatarios que REALMENTE se van a crear (`messaging-credit-guard`
CG-SEND-1) — un preview válido puede rechazarse acá si el estado cambió. El re-chequeo de crédito
MUST ejecutarse ANTES de crear la `Campaign` y ANTES de consumir el preview (mismo punto del flujo
que el resto de SEND-4): insuficiente ⇒ 422 `INSUFFICIENT_CREDIT` (CG-SEND-2); balance
inalcanzable o `currency` distinta a la de `MessagingRatesConfig` ⇒ 503 `CREDIT_UNAVAILABLE`
(CG-SEND-3), fail-closed. El replay (SEND-6, misma `Idempotency-Key`, campaña ya creada) MUST NOT
re-chequear crédito (CG-SEND-4), mismo criterio que los caps.
(Previously: el bloque de re-validación cubría flag/template/topes/opt-out; no existía chequeo de
crédito en `send`.)

#### Scenario: template desaprobado entre validate y send
- Given un preview `valid` cuyo template pasó a `pending`/`rejected` DESPUÉS del `validate`
- When `POST .../send`
- Then responde 422 `TEMPLATE_NOT_APPROVED`, sin crear `Campaign`, sin consumir el preview

#### Scenario: cupo diario agotado entre validate y send
- Given un preview `valid` de 50 recipients, pero otra campaña `api-messaging` consumió el cupo
  diario DESPUÉS de ese `validate`
- When `POST .../send`
- Then responde 422 `CAP_EXCEEDED`, sin crear `Campaign`

#### Scenario: recipient opt-out entre validate y send
- Given un preview con un recipient `valid`, que se da de baja (opt-out) DESPUÉS del `validate`
- When `POST .../send`
- Then ese recipient MUST excluirse de la `Campaign` creada (no se le envía)

#### Scenario: crédito insuficiente entre validate y send (nuevo, twilio-credit-guard)
- Given un preview `valid`, pero el saldo Twilio cayó por debajo del costo estimado DESPUÉS del
  `validate`
- When `POST .../send`
- Then responde 422 `INSUFFICIENT_CREDIT` con `{available, estimatedCost, currency}`, sin crear
  `Campaign`, sin consumir el preview — el chequeo de crédito corre ANTES de esos dos side-effects

#### Scenario: el orden de los guards deja crédito al final, antes de crear la Campaign
- Given un preview cuyo template SIGUE aprobado, topes OK, opt-out sin cambios, pero crédito
  insuficiente
- When `POST .../send`
- Then el rechazo es 422 `INSUFFICIENT_CREDIT` (los guards previos de este mismo requirement ya
  pasaron) — ningún guard posterior a crédito llega a ejecutarse porque la `Campaign` aún no existe

### Requirement: SEND-5 — creación de la `Campaign`
`send` exitoso MUST crear `Campaign` vía `CreateCampaign` con `createdById` = id del `RbacUser
api-messaging`, `chatwootLabel` seteado desde el preview, `externalIdempotencyKey` = el header
recibido (`@unique`). `manualContacts` sin `name` MUST mapearse con `name = phone` (placeholder,
molde documentado en el proposal) para pasar la validación de `matchManualContacts`.

#### Scenario: recipient sin name
- Given un recipient del preview con `name` ausente
- When `send` crea la `Campaign`
- Then el `manualContact` correspondiente tiene `name` igual al `phone` E.164 (no vacío)

#### Scenario: chatwootLabel propagado
- Given un preview con `chatwootLabel:"promo-agosto"`
- When `send` crea la `Campaign`
- Then `Campaign.chatwootLabel === "promo-agosto"`

### Requirement: SEND-10 — las variables mergeadas viajan hasta el envío
`send` MUST propagar el `variables` MERGEADO de cada recipient del preview hasta
`CampaignRecipient.variables` (columna `Json?`, nullable y aditiva). Al enviar, el mapa de
variables efectivo MUST ser `{...resolveCampaignVariables(campaign.variableSpec, candidate),
...(recipient.variables ?? {})}` — el por-recipient GANA. Ese MISMO mapa MUST usarse para el envío
al proveedor, para el body renderizado que se proyecta al inbox y para el que va a Chatwoot (nunca
tres mapas distintos). `Campaign.variableSpec` MUST declarar TODAS las keys que el template exige
(valor global, o `''` cuando solo la aportan los recipients) para no violar CAMP-3 de
`messaging-bulk`. Un recipient sin `variables` (toda campaña de la UI admin) MUST comportarse
EXACTAMENTE como hoy (`null` → merge vacío → cero cambio de comportamiento).

#### Scenario: cada destinatario recibe SU mensaje
- Given una campaña externa con recipients A (`variables:{"1":"Ana"}`) y B (`{"1":"Beto"}`)
- When corre el envío
- Then a A se le manda `{"1":"Ana"}` y a B `{"1":"Beto"}`
- And el `ChatMessage` proyectado al inbox de A dice "Ana" y el de B dice "Beto"

#### Scenario: override sobre la variable resuelta del Client
- Given un recipient VINCULADO a un `Client` llamado "Juan", con `variableSpec` `{"1":{source:'name'}}`
  y `recipient.variables = {"1":"Ana"}`
- When corre el envío
- Then la variable `"1"` enviada es `"Ana"` (el override por-recipient gana sobre `source:'name'`)

#### Scenario: campaña de la UI admin — sin regresión
- Given una campaña creada desde la UI admin, con `CampaignRecipient.variables = null` en todas las filas
- When corre el envío
- Then las variables son EXACTAMENTE las de `resolveCampaignVariables` (comportamiento idéntico al previo)

### Requirement: SEND-6 — replay idempotente (misma key + mismo preview)
Reintentar `send` con el MISMO `previewId` + la MISMA `Idempotency-Key` (ya consumida) MUST
responder 200 con la `Campaign` YA creada, sin crear una segunda ni re-disparar side-effects de
creación.

> **AMENDED — fix wave F1 (finding F3).** El camino de replay (a) salteaba el kill-switch y (b)
> llamaba `campaignStarter.start()` A CIEGAS, sin mirar el estado de la campaña — re-disparando una
> campaña ya terminada. Se agregan las dos reglas de abajo y dos campos ADITIVOS a la respuesta
> (`resumed`, `status`).

El replay MUST re-chequear el kill-switch (KS-1 no declara ninguna exención de replay: el fast-path
dispara envíos REALES vía `start()`) y MUST NOT re-chequear los caps (esos destinatarios ya quemaron
cupo al crearse la campaña, VAL-7 revisado — volver a contarlos los cobraría dos veces).

Según el estado de la `Campaign`, el replay MUST:
- `done` / `failed` → responder 200 `{campaignId, accepted:true, total, resumed:false, status}` y
  MUST NOT llamar `start()` (una campaña terminada no se re-arranca).
- `running` → responder 200 `{…, resumed:true, status:'running'}` SIN llamar `start()`.
- `pending` / `paused` → llamar `start()` (resume real); ocupado ⇒ 409 `CAMPAIGN_RUNNER_BUSY` (SEND-8).

#### Scenario: el kill-switch también apaga el replay
- Given un `send` exitoso previo con `Idempotency-Key=K1` y el flag apagado DESPUÉS
- When se repite `POST .../send` con `K1`
- Then responde 403 `FEATURE_DISABLED` y MUST NOT llamar `CampaignRunner.start()`

#### Scenario: replay sobre una campaña YA terminada
- Given la campaña de `K1` en estado `done` (o `failed`)
- When se repite `POST .../send` con `K1` + el mismo `previewId`
- Then responde 200 `{campaignId, accepted:true, total, resumed:false, status:'done'}`
- And `CampaignRunner.start()` MUST NOT invocarse

#### Scenario: replay sobre una campaña en curso
- Given la campaña de `K1` en estado `running`
- When se repite `POST .../send` con `K1`
- Then responde 200 con `resumed:true`, `status:'running'`, sin llamar `start()`

#### Scenario: carrera de dos `send` con la MISMA key — fix wave F1 (F5)
- Given dos `send` concurrentes con la misma `Idempotency-Key` que AMBOS pasaron el guard-0
- When el segundo choca contra el `@unique` de `Campaign.externalIdempotencyKey`
- Then MUST re-leer la `Campaign` GANADORA y responder la forma idempotente de este requirement
- And MUST NOT propagar un 500

#### Scenario: doble POST idéntico
- Given un `send` exitoso previo con `previewId=P1`, `Idempotency-Key=K1` → `campaignId=C1`
- When se repite `POST .../send` con `previewId=P1`, `Idempotency-Key=K1`
- Then responde 200 con `campaignId: C1`; NO se crea una segunda `Campaign`

### Requirement: SEND-7 — conflicto de idempotencia (misma key, distinto preview)
La MISMA `Idempotency-Key` usada con un `previewId` DISTINTO al que consumió originalmente MUST
responder 409 `IDEMPOTENCY_KEY_CONFLICT`, sin crear `Campaign`.

#### Scenario: reuso de key con otro preview
- Given `Idempotency-Key=K1` ya consumió `previewId=P1` → `campaignId=C1`
- When `POST .../send` con `Idempotency-Key=K1` y `previewId=P2` (distinto)
- Then responde 409 `IDEMPOTENCY_KEY_CONFLICT`; `C1` no se toca, no se crea otra `Campaign`

### Requirement: SEND-8 — runner ocupado → 409 honesto, la Campaign ya existe
Si `CampaignRunner.start()` devuelve `{accepted:false}` (lock global tomado), `send` MUST
responder 409 `CAMPAIGN_RUNNER_BUSY` con `{retryAfterSeconds, campaignId}` — la `Campaign` YA
quedó creada/consumida; reintentar `send` (SEND-6) reanuda la MISMA campaña, nunca crea otra.

#### Scenario: lock tomado por otra corrida
- Given el lock global de `CampaignRunner` tomado por otra campaña en curso
- When `POST .../send` con un preview válido
- Then responde 409 `CAMPAIGN_RUNNER_BUSY` con `campaignId` (la recién creada) y
  `retryAfterSeconds > 0`; el preview queda consumido (no se puede re-crear otra `Campaign` para él)

#### Scenario: retry tras liberarse el lock
- Given el 409 anterior con `campaignId=C1`
- When se reintenta `send` (misma key+preview) tras liberarse el lock
- Then responde 200/202 según SEND-6/SEND-9, arrancando/reanudando `C1` (nunca crea `C2`)

### Requirement: SEND-9 — éxito
`send` exitoso (Campaign creada + runner aceptó el start) MUST responder 202
`{campaignId, accepted:true, total}`.

#### Scenario: send exitoso
- Given un preview válido, flag ON, topes OK, runner libre
- When `POST .../send`
- Then responde 202 con `campaignId`, `accepted:true`, `total` = cantidad de recipients enviados

---

## Capability: administración de templates desde la API Externa

> Rutas bajo `/api/external/v1/messaging/bulk/templates/*`, en el MISMO router de key dedicada.
> Reusan los use cases YA existentes (`ListTemplates`, `GetTemplate`, `CreateTemplate`,
> `SubmitTemplateForApproval`) y el MISMO mapeo de errores del router admin
> (`templates.routes.ts`) — cero lógica de negocio nueva.

### Requirement: TPL-0 — key dedicada y kill-switch aplican a TODAS las rutas de templates
Las 4 rutas de templates MUST estar detrás de la MISMA key dedicada (AUTH-1/2/3) y del MISMO flag
`messaging-external-bulk-enabled` (KS-1). El router MUST NOT exponer templates cuando el bulk está
apagado — es la misma superficie de riesgo.

#### Scenario: flag OFF apaga también los templates
- Given el flag en `enabled:false`
- When `GET .../templates` con la key dedicada válida
- Then responde 403 `FEATURE_DISABLED`, sin llamar al proveedor

#### Scenario: key global no abre templates
- Given `X-Api-Key` = la key GLOBAL de `/api/external/v1`
- When `GET .../templates`
- Then responde 401 `UNAUTHORIZED`

### Requirement: TPL-1 — listado de templates con su estado
`GET .../templates` MUST devolver TODOS los templates del proveedor (no solo los aprobados) como
`{data: [{contentSid, friendlyName, language, variables: string[], approvalStatus, category,
sendable, body}]}` — `sendable === (approvalStatus === 'approved')`, mismo DTO curado que la UI
admin (`ListTemplates`). MUST NOT devolver el JSON crudo del proveedor. Fix wave F5 — cada item
MUST incluir `rejectionReason` cuando el proveedor lo informa (additivo, `ContentAndApprovals` ya
lo trae en el listado sin GET extra).

#### Scenario: listado mixto aprobado/pendiente
- Given el proveedor tiene un template `approved` y otro `pending`
- When `GET .../templates`
- Then responde 200 con los DOS, `sendable:true` en el aprobado y `false` en el pendiente
- And cada item trae `variables` (los placeholders declarados) y `body`

#### Scenario: rejectionReason llega al wire en el listado (fix wave F5)
- Given el proveedor tiene un template `rejected` con `rejection_reason:'Tag_Content_Mismatch'`
- When `GET .../templates`
- Then el item de ESE template en `data[]` trae `rejectionReason:'Tag_Content_Mismatch'`
- And ANTES del fix el campo moría en el mapper (`ListTemplates.execute`/`TemplateSummaryDto`) —
  el adapter ya lo traía (F4/S4), pero nunca llegaba al wire

### Requirement: TPL-2 — ficha/estado de UN template
`GET .../templates/:sid` MUST consultar el estado VIVO contra el proveedor (`GetTemplate`) y
devolver el DTO curado. Un `sid` inexistente MUST responder 404 `TEMPLATE_NOT_FOUND`; el proveedor
caído/mal configurado MUST responder 503.

Fix wave F4 (S4) — el adapter (`TwilioContentGateway.getTemplate`) MUST consultar TAMBIÉN
`GET /v1/Content/{sid}/ApprovalRequests` (la Content API sola no trae `approval_requests`) y
mergear ese estado real por encima del mapeo content-only, incluyendo `rejectionReason` cuando el
proveedor lo informa. Si ese segundo GET falla (404 = nunca sometido, timeout, 5xx) el endpoint
MUST degradar a `approvalStatus:'unsubmitted'` SIN tirar — es un dato secundario, no debe volver
503 la ficha del template.

#### Scenario: consulta del estado de aprobación
- Given un template recién submitido, todavía `pending` en Meta
- When `GET .../templates/:sid`
- Then responde 200 con `approvalStatus:'pending'` y `sendable:false`

#### Scenario: rechazado por Meta, con motivo
- Given un template cuyo `ApprovalRequests` en el proveedor trae `status:'rejected'` y
  `rejection_reason:'Tag_Content_Mismatch'`
- When `GET .../templates/:sid`
- Then responde 200 con `approvalStatus:'rejected'`, `sendable:false`,
  `rejectionReason:'Tag_Content_Mismatch'` y `approvalCategory` (la categoría según ese mismo
  endpoint de aprobación)
- And ANTES del fix (S4) esto respondía `approvalStatus:'unsubmitted'` (bug S4 — la Content API
  sola no trae `approval_requests`)
- And fix wave F5 — `rejectionReason`/`approvalCategory` YA los completaba el adapter desde S4, pero
  el mapper (`toTemplateDetailDto`) los descartaba antes del wire: el 200 respondía SIN esos campos
  aunque el proveedor los hubiera informado. Bug de mapper, no del adapter.

#### Scenario: status crudo del proveedor fuera del union (paused/disabled) — fix wave F5
- Given un template YA aprobado que el proveedor reporta como `status:'paused'` (o `'disabled'`) en
  `ApprovalRequests` — un estado válido de Twilio, fuera del union `approved|pending|rejected|unsubmitted`
- When `GET .../templates/:sid`
- Then responde 200 con `approvalStatus:'unsubmitted'` (degradado, MISMO criterio que cualquier
  status desconocido — el union NO cambia, lo espejea el FE) pero `providerStatus:'paused'`
  (o `'disabled'`) con el string CRUDO, para que un operador/AI distinga "nunca sometido" de
  "aprobado y luego pausado/desactivado"

#### Scenario: ApprovalRequests no disponible (nunca sometido, o falla transitoria del proveedor)
- Given el proveedor responde 404 (o timeout/5xx) en `GET .../ApprovalRequests` para ese `sid`
- When `GET .../templates/:sid`
- Then responde 200 con `approvalStatus:'unsubmitted'` (degradado, NO 503)

#### Scenario: sid inexistente
- Given un `sid` que el proveedor no conoce
- When `GET .../templates/:sid`
- Then responde 404 `TEMPLATE_NOT_FOUND`

### Requirement: TPL-3 — creación de template
`POST .../templates` MUST aceptar `{friendlyName, language, body, category?, variables?: string[]}`
y delegar en `CreateTemplate` (que valida `friendlyName`/`language`/`body` no vacíos y `category` ∈
{UTILITY, MARKETING, AUTHENTICATION} si viene). Éxito MUST responder 201 con el DTO curado del
template creado (`approvalStatus:'unsubmitted'`). Input inválido MUST responder 400
`VALIDATION_ERROR` (mismo código que el router admin — `InvalidTemplateInputError` no es 422).
La creación MUST NOT submitir el template a Meta: submit es un paso EXPLÍCITO y separado (TPL-4).

#### Scenario: creación válida
- Given `{friendlyName:"promo_setiembre", language:"es", body:"Hola {{1}}", variables:["1"]}`
- When `POST .../templates`
- Then responde 201 con `contentSid`, `approvalStatus:'unsubmitted'`, `sendable:false`
- And el proveedor NO recibió ningún pedido de aprobación

#### Scenario: body vacío
- Given `{friendlyName:"x", language:"es", body:"   "}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR`, sin llamar al proveedor

#### Scenario: category fuera del enum
- Given `{friendlyName:"x", language:"es", body:"y", category:"PROMO"}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR`, sin crear nada

### Requirement: TPL-4 — submit a Meta, explícito y separado
`POST .../templates/:sid/submit` MUST aceptar `{category, name?}` — `name` es OPCIONAL (AMENDED,
fix wave F3, S3): si no vino, el handler lo resuelve del propio template (`friendlyName`, vía
`GetTemplate`, ya inyectado, D4.f — cero use case nuevo); si vino explícito, gana siempre. Ambos
caminos normalizan `name` a `[a-z0-9_]` (`normalizeTemplateName`) y validan `category` ∈ el enum,
delegando en `SubmitTemplateForApproval`. Éxito MUST responder 202 `{contentSid, submitted:true}`.
`sid` inexistente MUST responder 404 `TEMPLATE_NOT_FOUND` (con o sin `name` en el body — la
resolución del `friendlyName` toca `GetTemplate` ANTES que `submitTemplate`, así que un `sid`
inexistente 404-ea igual sin `name`); `name` (explícito o resuelto) que normaliza a vacío, o
`category` inválida, MUST responder 400 `VALIDATION_ERROR`.

#### Scenario: submit válido, name explícito
- Given un template `unsubmitted` y `{name:"Promo SETIEMBRE #1", category:"MARKETING"}`
- When `POST .../templates/:sid/submit`
- Then responde 202 y el proveedor recibió `name:"promo_setiembre_1"`, `category:"MARKETING"`

#### Scenario: submit sin `name` → default al friendlyName — AMENDED, fix wave F3 (S3, smoke en vivo)
> LIVE: `{"category":"UTILITY"}` (sin `name`) → 400 "name" required. Fricción innecesaria para el
> caller AI — el template YA tiene un `friendlyName`.
- Given un template `unsubmitted` con `friendlyName:"recordatorio_deuda"` y `{category:"UTILITY"}` (sin `name`)
- When `POST .../templates/:sid/submit`
- Then responde 202 y el proveedor recibió `name:"recordatorio_deuda"` (el `friendlyName` normalizado)

#### Scenario: name que normaliza a vacío
- Given `{name:"###", category:"UTILITY"}`
- When `POST .../templates/:sid/submit`
- Then responde 400 `VALIDATION_ERROR`, sin tocar el proveedor

#### Scenario: re-submit de un template ya submitido/aprobado
- Given un template cuyo submit previo ya fue aceptado y el proveedor rechaza el nuevo pedido
- When `POST .../templates/:sid/submit`
- Then el error del proveedor se propaga con su código mapeado (nunca 202 silencioso)

#### Scenario: sid inexistente
- Given un `sid` que el proveedor no conoce
- When `POST .../templates/:sid/submit` (con o sin `name`)
- Then responde 404 `TEMPLATE_NOT_FOUND`, y `submitTemplate` NUNCA se invoca

### Requirement: TPL-5 — el borrado NO se expone
El router externo MUST NOT exponer ningún verbo de borrado de templates (decisión de scope: es
destructivo e irreversible en Meta con `deleteInWaba`). `DELETE .../templates/:sid` MUST responder
404 y MUST NOT alcanzar `DeleteTemplate` ni el port del proveedor.

#### Scenario: intento de DELETE
- Given un `sid` existente y la key dedicada válida
- When `DELETE .../templates/:sid`
- Then responde 404 `NOT_FOUND` (ruta no registrada), y `TemplateAdminPort.deleteTemplate` NO se invoca

#### Scenario: el router queda SELLADO — AMENDED, fix wave F3 (S2, smoke en vivo)
> LIVE: `DELETE .../templates/:sid` y `GET .../campaigns/` (id vacío) devolvían 401 `UNAUTHORIZED`
> en vez de 404. La causa NO era la ruta faltante en sí: sin un catch-all propio, Express seguía
> buscando un match y caía en el mount GLOBAL de `app.ts` (`/api/external/v1`, key GLOBAL sin la
> key dedicada) — el 401 venía de ESE middleware de auth, no de "ruta inexistente". Un caller M2M
> viendo 401 en una ruta mal tipeada cree que su key está mal, no que el path no existe. El router
> ahora termina en un catch-all propio (`router.use`, ÚLTIMO handler) que sella el prefijo entero
> ANTES de que Express siga cayendo afuera — mismo shape del 404 global (`{error:'Not found',
> code:'NOT_FOUND'}`).
- Given el router dedicado montado ANTES del mount global (COMP-1, orden intacto)
- When `DELETE .../templates/:sid` o `GET .../campaigns/` (id vacío) con la key dedicada válida
- Then responde 404 `NOT_FOUND` — NUNCA el 401 del mount global, cualquiera sea el orden de matching de Express

---

## Capability: status de campaña (para polling del caller M2M)

### Requirement: STATUS-1 — lectura acotada a campañas propias
`GET /api/external/v1/messaging/bulk/campaigns/:id` MUST devolver el DTO de estado
(`status/total/sentCount/failedCount/skippedCount/optedOutCount`) SOLO si `Campaign.createdById`
es `api-messaging`; cualquier otra campaña (creada desde la UI admin) MUST responder 404, para no
filtrar existencia de campañas ajenas al caller M2M.

#### Scenario: consulta de una campaña propia
- Given una `Campaign` con `createdById = api-messaging`
- When `GET .../campaigns/:id` con esa id
- Then responde 200 con el estado/contadores actuales

#### Scenario: consulta de una campaña de la UI admin
- Given una `Campaign` creada por un usuario admin (no `api-messaging`)
- When `GET .../campaigns/:id` con esa id, autenticado con la key dedicada
- Then responde 404 `CAMPAIGN_NOT_FOUND` (no revela que existe)

---

## Capability: configuración de topes (admin)

### Requirement: CONFIG-1 — singleton con defaults 500/2000
`ExternalBulkMessagingConfig` MUST ser fila única (`id:'singleton'`) con `maxPerRequest:
Int @default(500)`, `maxPerDay: Int @default(2000)`.

#### Scenario: primera lectura sin config previa
- Given ninguna fila de config creada aún (post-migración)
- When se resuelve la config para `validate`
- Then usa `maxPerRequest:500, maxPerDay:2000` (defaults de la migración, no un fallback en código)

### Requirement: CONFIG-2 — `GET/PUT /api/messaging/config/external-bulk` gateados por permiso
`GET` MUST requerir `messaging:read`; `PUT` MUST requerir `messaging:manage` (molde
`taskStageConfig.routes.ts`/`nocBroadcast.routes.ts`).

#### Scenario: GET sin messaging:read
- Given un usuario admin sin `messaging:read`
- When `GET /api/messaging/config/external-bulk`
- Then responde 403

#### Scenario: PUT con messaging:read pero sin messaging:manage
- Given un usuario con `messaging:read` pero sin `messaging:manage`
- When `PUT /api/messaging/config/external-bulk`
- Then responde 403, la config no cambia

### Requirement: CONFIG-3 — validación de los topes
`PUT` MUST rechazar valores no enteros positivos, y MUST rechazar `maxPerRequest > maxPerDay`
(inconsistencia: un solo request no puede exceder el tope diario).

> **AMENDED — fix wave F1 (finding F4).** `maxPerRequest` no tenía techo contra `MAX_MANUAL_CONTACTS`
> (5000), la cota DURA de `resolveCombinedRecipients`. Con `maxPerRequest: 6000` el sistema quedaba
> en un estado imposible: `validate` aceptaba 5500 destinatarios (200 + preview persistido) y el
> `send` de ESE preview reventaba con 422 `TOO_MANY_MANUAL_CONTACTS` para siempre. La config no
> puede prometer más de lo que el motor puede enviar.

`PUT` MUST rechazar `maxPerRequest > 5000` (`MAX_MANUAL_CONTACTS`) con 400 `VALIDATION_ERROR`,
nombrando el techo en el mensaje. `validate` MUST además CLAMPEAR defensivamente el
`maxPerRequest` leído de la config a ese mismo techo (la fila es editable por fuera del use case).

#### Scenario: maxPerRequest por encima del techo del motor de envío
- Given `PUT` con `{maxPerRequest: 5001, maxPerDay: 100000}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR` mencionando `5000`, la config NO se persiste
- And `{maxPerRequest: 5000}` (el techo exacto) SÍ es válido

#### Scenario: maxPerRequest > maxPerDay
- Given `PUT` con `{maxPerRequest: 3000, maxPerDay: 2000}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR`, la config NO se persiste

#### Scenario: valor no positivo
- Given `PUT` con `{maxPerRequest: 0, maxPerDay: 2000}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR`

#### Scenario: update válido
- Given `PUT` con `{maxPerRequest: 300, maxPerDay: 1500}` (positivos, `maxPerRequest <= maxPerDay`)
- When se ejecuta con `messaging:manage`
- Then responde 200 y `validate`/`send` subsiguientes usan los nuevos topes

---

## Capability: auditoría

### Requirement: AUDIT-1 — validate y send quedan auditados
Toda llamada a `validate` y `send` (éxito o rechazo por reglas de negocio) MUST dejar un registro
de auditoría identificando el origen (`api-messaging`) y el resultado: `counts`/`templateRef`/
`chatwootLabel` para `validate`; `campaignId`/`total`/outcome para `send`.

> **AMENDED — fix wave F1 (finding F6).** La implementación se apoyaba en el
> `auditMutationsMiddleware` global (que sí registra POSTs, éxitos y 4xx) más un `console.log` en
> `SendExternalBulk`. Eso NO satisfacía este requirement: la fila quedaba con
> `actorLogin:'anonymous'` (sin identificar el origen, que es justo lo que el requirement pide) y un
> log a stdout no es auditoría — no se consulta desde `GET /api/admin/audit-events` ni sobrevive a
> un redeploy, y el rechazo (el escenario `CAP_EXCEEDED` de abajo) ni siquiera lo emitía.

El registro MUST llevar `actorLogin = 'api-messaging'` y el `actorId` del `RbacUser` real
correspondiente. El `console.log` se eliminó.

#### Scenario: el actor auditado es api-messaging, no anonymous
- Given un `validate` (200 o 422) o un `send` (202 o 409) con la key dedicada
- When se procesa el request
- Then la fila de auditoría MUST tener `actorLogin:'api-messaging'` y un `actorId` no nulo

#### Scenario: validate rechazado por CAP_EXCEEDED también audita
- Given un `validate` que resulta en 422 `CAP_EXCEEDED`
- When se procesa el request
- Then queda un registro de auditoría con el resultado del rechazo (no solo los éxitos)

#### Scenario: send exitoso audita el campaignId creado
- Given un `send` exitoso con `campaignId=C1`
- When se procesa
- Then el registro de auditoría incluye `C1` y el total de recipients

### Requirement: AUDIT-2 — los POST de templates también quedan auditados
`POST .../templates` y `POST .../templates/:sid/submit` MUST quedar auditados (mismo
`auditMutationsMiddleware` global que cubre todo POST bajo `/api`), identificando el origen externo.
Los `GET` de templates MUST NOT auditarse (son lecturas, mismo criterio del resto del sistema).

#### Scenario: creación de template auditada
- Given un `POST .../templates` exitoso
- When se procesa
- Then queda un registro de auditoría de la mutación (el `GET .../templates` previo, no)

---

## Capability: endpoint GET /credit (crédito de solo lectura)

### Requirement: CRED-ROUTE-1 — `GET /credit` es una ruta hermana en el MISMO router dedicado
El router de `external-bulk-messaging` MUST montar `GET /credit` junto a `/validate`/`/send`/
`/templates/*`/`/campaigns/:id`, bajo la MISMA key dedicada (AUTH-1/2/3) y el MISMO kill-switch
(KS-1) por construcción — no una exención nueva. El comportamiento detallado de la respuesta y sus
errores está especificado en `messaging-credit-guard` (CRED-1, CRED-2, CG-AUTH-1); este requirement
cubre solo el punto de integración: la ruta existe en este router y respeta el orden de mount
(COMP-1).

#### Scenario: /credit hereda el orden de mount de COMP-1
- Given el `app.ts` real ensamblado, router dedicado montado ANTES del mount global
- When `GET .../messaging/bulk/credit` se llama con la key GLOBAL
- Then responde 401 (AUTH-2, mismo criterio que `/validate`/`/send`)
- And con la key DEDICADA responde 200/503 según CRED-1/CRED-2

---

## Capability: composición del router (app.ts)

### Requirement: COMP-1 — orden de mount fija la key dedicada ANTES de la global
El router de `external-bulk-messaging` MUST montarse ANTES del `app.use('/api/external/v1',
createApiKeyMiddleware(), ...)` global; si no, la key global intercepta la ruta nueva y AUTH-2 se
rompe en runtime aunque los tests de middleware aislado pasen.

#### Scenario: test de composition-root (orden de mounts)
- Given el `app.ts` real ensamblado (no un router aislado)
- When se hace `POST .../messaging/bulk/validate` con la key GLOBAL
- Then responde 401 (AUTH-2)
- And con la key DEDICADA responde 200/202 según el caso — probando el orden real de montaje, no
  solo el middleware en aislamiento
