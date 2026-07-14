# Spec — messaging-bulk (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

**Decisiones LOCKED del proposal, formalizadas acá (no se reabren):**
- Alcance v1 = segmentación SOLO por `ClientStatus` (multi-status) + rango `Client.balanceDue`.
  Nodo queda fuera (v2).
- Send-path = **Twilio directo** vía `TemplateMessagingPort` (el use case NUNCA conoce Twilio ni
  Chatwoot — depende solo del port). Chatwoot sigue siendo el inbox (F1); las respuestas entran
  por el webhook existente sin cambios.
- Templates se listan del proveedor (Twilio Content API) por `content_sid`; solo los
  **APROBADOS** son enviables.
- Opt-out = `Client.whatsappOptOutAt DateTime?`, enforcement en preview Y en send.
- Batch async resumible, molde `ServiceCutRunner`, rate-limit proactivo ~80 msg/s + backoff
  reactivo 429-aware (clon de `GestionRealClient.backoffMs`).
- RBAC: `messaging.bulk` (crear/preview/disparar/historial) + `messaging.templates` (listar
  templates).

---

## Capability: listado de templates

### Requirement: TPL-1 — listar templates disponibles desde el proveedor
`ListTemplates` MUST delegar en `TemplateMessagingPort.listTemplates()` y devolver un DTO por
template con `contentSid`, `friendlyName`, `category`, `language`, `variables` (nombres
declarados), `approvalStatus` (`approved | pending | rejected`) y `sendable` (`true` solo si
`approvalStatus === 'approved'`). El sistema MUST NUNCA devolver el objeto crudo del proveedor.

#### Scenario: listado mixto de templates aprobados y no aprobados
- Given el proveedor devuelve 3 templates: 2 `approved` y 1 `pending`
- When se pide `GET /api/messaging/bulk/templates`
- Then los 3 vienen en la respuesta, cada uno con su `approvalStatus`; los 2 `approved` tienen
  `sendable: true` y el `pending` tiene `sendable: false`

#### Scenario: el proveedor no responde
- Given `TemplateMessagingPort.listTemplates()` lanza (timeout/5xx del proveedor)
- When se pide el listado
- Then el sistema MUST responder con un error tipado (`TemplateProviderUnavailableError` →
  503 `{ code: 'TEMPLATE_PROVIDER_UNAVAILABLE' }`), nunca colgar el request

#### Scenario: sin templates cargados
- Given el proveedor devuelve una lista vacía
- When se pide el listado
- Then responde 200 con `data: []`

### Requirement: TPL-2 — solo templates aprobados son elegibles para enviar
Ningún flujo de creación/envío de campaña MUST aceptar un `templateRef` cuyo `approvalStatus`
no sea `approved` (ver CAMP-2, que consume esta regla).

#### Scenario: template no aprobado no aparece como enviable
- Given un template `rejected` en la lista de TPL-1
- When se consulta su `sendable`
- Then MUST ser `false`, señalizando al FE que no se puede seleccionar para campaña

---

## Capability: segmentación por estado — preview y conteo

### Requirement: SEG-1 — resolver destinatarios por status multi-select + rango de balanceDue
`PreviewCampaignSegment` MUST aceptar un filtro `{ statuses: ClientStatus[], balanceMin?: number,
balanceMax?: number }` y resolver los `Client` que matchean TODOS los criterios provistos (AND
entre `status IN statuses` y `balanceDue` dentro del rango, cuando se especifica). Extiende
`ListClientsQuery`/`CustomerRepository.list` de forma aditiva (hoy solo soporta `status` único).

#### Scenario: un solo status
- Given clientes con status `active`, `late` y `blocked`
- When se previsualiza `{ statuses: ['late'] }`
- Then solo los clientes `late` entran en el conteo/preview

#### Scenario: multi-status (unión)
- Given clientes con status `late`, `blocked` y `baja`
- When se previsualiza `{ statuses: ['late', 'blocked'] }`
- Then entran los `late` Y los `blocked`, pero NO los `baja`

#### Scenario: rango de balanceDue combinado con status
- Given 2 clientes `late` con `balanceDue` 5000 y 50000
- When se previsualiza `{ statuses: ['late'], balanceMin: 10000 }`
- Then solo el cliente con `balanceDue >= 10000` entra (AND entre status y rango, no OR)

#### Scenario: rango sin status (todos los estados, solo por deuda)
- Given clientes de distinto status con `balanceDue` variado
- When se previsualiza `{ statuses: [], balanceMin: 1000, balanceMax: 100000 }` (statuses vacío
  = sin filtro de status)
- Then entran todos los clientes cuyo `balanceDue` cae en el rango, sin importar su `status`

#### Scenario: filtro sin matches
- Given ningún cliente cumple el filtro
- When se previsualiza
- Then responde `{ count: 0, sample: [] }` sin error

### Requirement: SEG-2 — exclusión de opt-out SIEMPRE (no negociable)
`PreviewCampaignSegment` MUST excluir todo `Client` con `whatsappOptOutAt != null` del conteo y
la muestra, incluso si su status/balance matchea el filtro. No es un checkbox del operador.

#### Scenario: cliente opt-out dentro del segmento seleccionado
- Given un cliente `late` con `whatsappOptOutAt` seteado (opt-out) y otro `late` sin opt-out
- When se previsualiza `{ statuses: ['late'] }`
- Then el `count` MUST reflejar solo el cliente sin opt-out; el opt-out se contabiliza aparte en
  `skipped.optedOut` (no en `count`, no en `sample`)

### Requirement: SEG-3 — de-dup por teléfono normalizado
`PreviewCampaignSegment` MUST de-duplicar destinatarios por `normalizePhone(client.phone)`: dos
`Client` cuyo teléfono normaliza al MISMO valor cuentan como UN solo destinatario. Reusa
`normalizePhone` VERBATIM (`recapture/matchActiveClient.ts`), sin reimplementar.

#### Scenario: dos clientes con el mismo teléfono normalizado
- Given `Client A` con `phone: "011 15-4444-5555"` y `Client B` con `phone: "01144445555"`
  (normalizan al mismo valor)
- When se previsualiza un filtro que matchea a ambos
- Then el `count` MUST subir en 1 (no en 2); el segundo se contabiliza en
  `skipped.duplicatePhone`, y `sample` MUST mostrar solo uno de los dos (determinístico, p.ej.
  el de `id` menor)

### Requirement: SEG-4 — teléfono ausente o inválido → skip contabilizado
Un `Client` sin `phone`, o cuyo `normalizePhone` devuelve `null` (menos de
`PHONE_MIN_SIGNIFICANT_DIGITS` dígitos significativos), MUST excluirse del `count`/`sample` y
contabilizarse en `skipped.invalidPhone`.

#### Scenario: teléfono con menos de 6 dígitos significativos
- Given un `Client` que matchea el filtro pero su `phone` normaliza a `null` (ej. `"123"`)
- When se previsualiza
- Then el cliente NO entra en `count`/`sample`; `skipped.invalidPhone` MUST incrementar en 1

### Requirement: SEG-5 — el preview no persiste nada
`PreviewCampaignSegment` MUST ser de solo lectura: no crea `Campaign` ni `CampaignRecipient`,
no llama a `TemplateMessagingPort.sendTemplate`.

#### Scenario: previsualizar dos veces seguidas
- Given un filtro cualquiera
- When se llama a preview dos veces
- Then ninguna llamada crea filas nuevas en `CampaignRepository`; el resultado es idéntico entre
  ambas llamadas (dado el mismo estado de `Client`)

---

## Capability: creación de campaña

### Requirement: CAMP-1 — crear campaña en `pending` sin disparar el envío
`CreateCampaign` MUST persistir un `Campaign` (`status: 'pending'`, `total` = conteo resuelto por
el preview con las mismas reglas SEG-1..SEG-4) + generar un `CampaignRecipient` por destinatario
resuelto (`status: 'queued'`). El `segment` filter MUST serializarse tal cual para auditoría.
`CreateCampaign` MUST NOT llamar a `TemplateMessagingPort.sendTemplate` (el envío es un paso
posterior y explícito, ver SEND-*).

#### Scenario: create exitoso con segmento y template válidos
- Given un template aprobado con variables `["nombre", "monto_deuda"]` y un segmento que resuelve
  3 destinatarios (tras aplicar SEG-2/SEG-3/SEG-4)
- When se crea la campaña con `variablesMap` que cubre `nombre`/`monto_deuda`
- Then se persiste `Campaign` con `status: 'pending'`, `total: 3`,
  `sentCount/failedCount/skippedCount/optedOutCount = 0`, y 3 `CampaignRecipient` en `queued`
- And `TemplateMessagingPort.sendTemplate` MUST NOT haberse invocado

### Requirement: CAMP-2 — validar que el template esté APROBADO
`CreateCampaign` MUST verificar (vía `TemplateMessagingPort`) que `templateRef` corresponde a un
template con `approvalStatus === 'approved'` (TPL-2). Si no lo está, MUST rechazar sin persistir
nada.

#### Scenario: template pendiente de aprobación
- Given un `templateRef` cuyo `approvalStatus` es `pending`
- When se intenta crear la campaña
- Then responde 422 `{ code: 'TEMPLATE_NOT_APPROVED' }`; no se crea `Campaign` ni
  `CampaignRecipient`

#### Scenario: templateRef inexistente
- Given un `templateRef` que no aparece en `TemplateMessagingPort.listTemplates()`
- When se intenta crear la campaña
- Then responde 422 `{ code: 'TEMPLATE_NOT_APPROVED' }` (tratado igual que no-aprobado: no hay
  evidencia de aprobación)

### Requirement: CAMP-3 — validar variables requeridas presentes
`CreateCampaign` MUST validar que TODAS las `variables` declaradas por el template estén
presentes como keys en el `variablesMap` provisto por el operador. Si falta alguna, MUST
rechazar listando las faltantes.

#### Scenario: falta una variable requerida
- Given un template con `variables: ["nombre", "monto_deuda"]` y un `variablesMap` que solo
  provee `{ nombre: "..." }`
- When se intenta crear la campaña
- Then responde 422 `{ code: 'MISSING_TEMPLATE_VARIABLES', missing: ['monto_deuda'] }`; no se
  crea `Campaign`

#### Scenario: todas las variables presentes
- Given un `variablesMap` que cubre exactamente las `variables` del template
- When se crea la campaña
- Then la creación MUST proceder (no es bloqueante tener variables EXTRA no declaradas, solo
  faltar una requerida)

### Requirement: CAMP-4 — segmento vacío se rechaza
`CreateCampaign` MUST rechazar la creación si el segmento resuelve 0 destinatarios (tras
SEG-2/SEG-3/SEG-4), para evitar campañas fantasma sin ningún efecto posible.

> Nota de spec (no lockeado explícitamente en el proposal — abierto a ajuste en design/verify si
> el negocio prefiere permitir `total: 0` como campaña "vacía" archivable).

#### Scenario: filtro que no resuelve ningún destinatario
- Given un filtro que, tras exclusiones, resuelve 0 destinatarios
- When se intenta crear la campaña
- Then responde 422 `{ code: 'EMPTY_SEGMENT' }`; no se crea `Campaign`

---

## Capability: envío de campaña (batch async resumible)

### Requirement: SEND-1 — arranque asíncrono con guard de doble-inicio
`SendCampaign.start(campaignId)` MUST ser rápido (adquiere lock + valida estado) y devolver de
inmediato; el trabajo pesado (recorrer recipients) corre en background (molde `ServiceCutRunner`,
`start()`/`run()`). Dos invocaciones concurrentes de `start()` sobre la MISMA campaña MUST NOT
resultar en dos corridas simultáneas enviando a los mismos destinatarios.

> Nota de spec: el proposal deja abierto si el lock es GLOBAL (una campaña a la vez en todo el
> cluster, como hoy `ServiceCutRunner`) o POR-CAMPAÑA (N campañas en paralelo, locks finos). Este
> requirement solo fija el comportamiento observable para la MISMA campaña; la granularidad
> exacta del lock (`SERVICE_CUT_LOCK_KEY`-style global vs `campaign-send:{id}`) queda para design.

#### Scenario: doble start sobre la misma campaña
- Given una campaña `pending` y un lock ya tomado por una corrida en curso de ESA campaña
- When se llama a `start(campaignId)` una segunda vez mientras la primera sigue corriendo
- Then la segunda invocación MUST devolver `{ accepted: false }` sin arrancar un segundo run

#### Scenario: start sobre campaña ya `done`
- Given una campaña en `status: 'done'`
- When se llama a `start(campaignId)`
- Then MUST rechazar (no re-envía una campaña ya terminada exitosamente) con un error tipado
  (`CampaignAlreadyFinishedError`)

### Requirement: SEND-2 — envío por destinatario con status resultante
Por cada `CampaignRecipient` en `queued`, el worker MUST invocar
`TemplateMessagingPort.sendTemplate(phone, templateRef, variables)`; éxito → `status: 'sent'` +
`sentAt`; fallo (tras agotar reintentos, ver SEND-3) → `status: 'failed'` + `error`. Un fallo
por-destinatario MUST NOT abortar el resto del batch (best-effort, mismo criterio que
`ServiceCutBatch`).

#### Scenario: batch con éxitos y un fallo aislado
- Given una campaña con 3 recipients `queued`; el proveedor responde OK para 2 y error
  persistente para 1
- When corre el worker
- Then al finalizar: 2 recipients `sent` (con `sentAt`), 1 `failed` (con `error`), y la campaña
  queda `status: 'done'` (el fallo aislado no la marca `failed` globalmente)

### Requirement: SEND-3 — reintentos por-destinatario con backoff 429-aware
Por cada destinatario, el worker MUST reintentar 2-3 veces ante errores retryables
(`RETRYABLE_STATUS = {429,500,502,503,504}`, clon de `GestionRealClient.isRetryableAxiosError`/
`backoffMs`: exponencial `base·3^i + jitter`, respeta `Retry-After` en 429). Errores NO retryables
(4xx de validación) MUST fallar de inmediato sin agotar reintentos.

#### Scenario: falla transitoria y luego éxito
- Given el proveedor responde 503 en los primeros 2 intentos y OK en el 3ro, para UN recipient
- When el worker lo procesa
- Then el recipient termina `sent` (los reintentos son transparentes al resultado final)

#### Scenario: falla persistente agota los reintentos
- Given el proveedor responde 500 en TODOS los intentos configurados (2-3) para UN recipient
- When el worker lo procesa
- Then el recipient termina `failed` con el error del último intento; el worker MUST continuar
  con el resto de la campaña

#### Scenario: error no-retryable falla sin reintentar
- Given el proveedor responde 400 (ej. `content_sid` inválido) para UN recipient
- When el worker lo procesa
- Then el recipient termina `failed` en el PRIMER intento, sin agotar los 2-3 reintentos
  (ahorra tiempo y costo de un error que no se va a autocorregir)

### Requirement: SEND-4 — rate-limit proactivo (~80 msg/s)
El worker MUST throttlear los envíos contra un límite configurado (token bucket, ~80/s en prod)
ANTES de invocar `sendTemplate`, no solo reaccionar a un 429 recibido. El limiter MUST ser
inyectable (mismo criterio de testabilidad que `sleep`/`random` en `GestionRealClient`) para que
los tests fijen un límite bajo y determinístico.

#### Scenario: el worker consulta el limiter antes de cada envío
- Given un rate limiter inyectado configurado para permitir como máximo 2 envíos por "tick" y una
  campaña con 5 recipients `queued`
- When corre el worker
- Then el limiter MUST ser consultado exactamente 5 veces (una por recipient) ANTES de la
  llamada a `sendTemplate` correspondiente, y ningún `sendTemplate` se dispara sin que el limiter
  lo haya permitido primero

#### Scenario: el limiter frena sin descartar al destinatario
- Given el limiter señala "esperar" para el 3er recipient de 5
- When el worker continúa
- Then el 3er recipient MUST seguir procesándose (esperar y reintentar la consulta al limiter),
  nunca marcarse `failed`/`skipped` solo por el throttle

### Requirement: SEND-5 — re-check de opt-out en el momento del envío
Además del filtro aplicado en preview/create (SEG-2), el worker MUST re-verificar
`whatsappOptOutAt` de cada `Client` INMEDIATAMENTE ANTES de invocar `sendTemplate` (un cliente
puede optar por baja DESPUÉS de creada la campaña pero ANTES de que el worker lo alcance).

#### Scenario: opt-out ocurre entre el create y el send
- Given un `CampaignRecipient` en `queued` cuyo `Client` NO tenía opt-out al crear la campaña
- And el cliente responde "BAJA" (setea `whatsappOptOutAt`) ANTES de que el worker llegue a su
  turno
- When el worker procesa ese recipient
- Then el recipient termina `status: 'opted-out'` SIN invocar `sendTemplate`; se contabiliza en
  `Campaign.optedOutCount`, no en `sentCount` ni `failedCount`

### Requirement: SEND-6 — resumible: no re-envía a los ya `sent`
Al reanudar una campaña (worker reiniciado, o `start()` invocado de nuevo sobre una campaña
`running`/`paused`), el worker MUST saltar los `CampaignRecipient` ya en `status: 'sent'` /
`'opted-out'` / `'skipped'` (estados terminales) y procesar SOLO los que siguen en `queued`.

#### Scenario: el worker se reinicia a mitad de batch
- Given una campaña con 5 recipients: 2 ya `sent` (de una corrida previa interrumpida) y 3
  `queued`
- When se reanuda el envío
- Then el worker MUST invocar `sendTemplate` SOLO para los 3 `queued`; los 2 `sent` MUST NOT
  recibir un segundo envío

### Requirement: SEND-7 — contadores de campaña consistentes (conteo real, no `.length` truncado)
Los contadores (`sentCount`/`failedCount`/`skippedCount`/`optedOutCount`) del `Campaign` MUST
reflejar el total REAL de recipients procesados en cada estado — nunca derivarse del `.length`
de una llamada potencialmente paginada a `listRecipients()`.

#### Scenario: campaña con más recipients que una página típica
- Given una campaña con 30 `CampaignRecipient` (más que el tamaño de página usual, ej. 25) que
  terminan todos `sent`
- When el worker finaliza
- Then `Campaign.sentCount` MUST ser 30 (no 25 ni ningún valor truncado a un tamaño de página);
  `sentCount + failedCount + skippedCount + optedOutCount` MUST igualar `total`

---

## Capability: historial de campañas

### Requirement: HIST-1 — listado paginado de campañas
`GET /api/messaging/bulk/campaigns` MUST devolver una página de campañas mapeadas a DTO (header +
contadores: `id/name/templateName/status/total/sentCount/failedCount/skippedCount/optedOutCount/
createdAt/startedAt/finishedAt`), ordenadas por `createdAt` descendente.

#### Scenario: listado con campañas de distinto estado
- Given 3 campañas (`pending`, `running`, `done`)
- When se pide el listado
- Then las 3 vienen paginadas, más reciente primero, cada una con sus contadores actuales

#### Scenario: sin campañas
- Given ninguna campaña creada
- When se pide el listado
- Then responde 200 con `data: []`

### Requirement: HIST-2 — detalle de campaña con recipients paginados
`GET /api/messaging/bulk/campaigns/:id` MUST devolver el header de la campaña + una página de
`CampaignRecipient` (filtrable por `status`), poleable durante el envío (progreso en vivo) y
consultable después (auditoría).

#### Scenario: detalle durante el envío (polling)
- Given una campaña `running` con recipients en `sent`/`queued`/`failed` mezclados
- When se pide el detalle repetidas veces mientras el worker avanza
- Then cada respuesta refleja los contadores y statuses ACTUALIZADOS al momento de la consulta

#### Scenario: detalle con más recipients que una página
- Given una campaña con 50 recipients
- When se pide el detalle con paginación (ej. `?page=2&limit=25`)
- Then la respuesta trae la página correspondiente (25 recipients) + el total real (50), sin
  perder recipients fuera de la página pedida

#### Scenario: campaña inexistente
- Given un `:id` que no existe
- When se pide el detalle
- Then responde 404 `{ code: 'CAMPAIGN_NOT_FOUND' }`

### Requirement: HIST-3 — DTO curado, sin datos sensibles del proveedor
El detalle por-destinatario MUST NUNCA exponer el payload/response crudo del proveedor
(`TemplateMessagingPort`) ni credenciales — solo un `error` saneado (string legible) cuando
`status: 'failed'`.

#### Scenario: recipient fallido con error crudo del proveedor
- Given un recipient `failed` cuyo error interno incluye detalles crudos de la respuesta HTTP del
  proveedor (headers, tokens, body completo)
- When se pide el detalle de la campaña
- Then el DTO expone SOLO un mensaje de error saneado (string), nunca el objeto/response crudo
  ni ningún header/credential del proveedor

---

## Capability: opt-out y RBAC transversal

### Requirement: OPT-1 — registrar opt-out con timestamp
El sistema MUST exponer una forma de setear `Client.whatsappOptOutAt = now()` para un cliente
dado. Repetir la operación sobre un cliente YA opt-out MUST ser idempotente (no lanza error) y
MUST NOT pisar el timestamp original (se preserva el momento de la baja real, primer-en-ganar).

#### Scenario: opt-out de un cliente sin baja previa
- Given un `Client` con `whatsappOptOutAt: null`
- When se registra su opt-out
- Then `whatsappOptOutAt` queda seteado a la hora actual

#### Scenario: opt-out repetido sobre un cliente ya dado de baja
- Given un `Client` con `whatsappOptOutAt` ya seteado a un timestamp `T1`
- When se registra opt-out de nuevo (segunda vez)
- Then la operación MUST NOT fallar y `whatsappOptOutAt` MUST seguir siendo `T1` (no se
  sobreescribe con la hora actual)

### Requirement: OPT-2 — detección de baja por keyword en el webhook inbound
`ReceiveChatwootWebhook` MUST detectar las keywords `BAJA`/`STOP` (case-insensitive, trim de
espacios) en el contenido de un mensaje INBOUND y, si matchea, registrar el opt-out (OPT-1) del
`Client` resuelto por teléfono (mismo matcher `normalizePhone`/`suffixMatch` de F1).

#### Scenario: mensaje inbound con la keyword exacta
- Given un mensaje inbound con contenido `"BAJA"` de un contacto cuyo teléfono matchea un
  `Client` sin opt-out previo
- When se procesa el webhook
- Then el `Client` matcheado queda con `whatsappOptOutAt` seteado

#### Scenario: variantes de la keyword (minúsculas, espacios)
- Given un mensaje inbound con contenido `"  stop  "` (minúsculas, espacios extra)
- When se procesa el webhook
- Then el opt-out MUST registrarse igual (detección case-insensitive y trim-tolerant)

#### Scenario: mensaje inbound sin la keyword
- Given un mensaje inbound con contenido `"Hola, tengo un problema con mi factura"`
- When se procesa el webhook
- Then `whatsappOptOutAt` del `Client` matcheado MUST NOT modificarse

#### Scenario: keyword de un teléfono sin match a ningún Client
- Given un mensaje inbound con contenido `"BAJA"` cuyo teléfono no matchea ningún `Client`
  (matcher `unknown`)
- When se procesa el webhook
- Then el webhook MUST procesarse sin error (no-op sobre opt-out), igual que hoy un contacto sin
  match no rompe el resto del procesamiento (HOOK-4/5 de `messaging-inbox`)

### Requirement: RBAC-1 — `messaging.bulk` gatea preview/create/send/historial
`GET/POST /api/messaging/bulk/segment/preview`, `POST /api/messaging/bulk/campaigns`,
`POST /api/messaging/bulk/campaigns/:id/send`, `GET /api/messaging/bulk/campaigns` y
`GET /api/messaging/bulk/campaigns/:id` MUST requerir el permiso `messaging.bulk`.

#### Scenario: sin permiso `messaging.bulk`
- Given un usuario autenticado sin `messaging.bulk`
- When llama a cualquiera de esas rutas
- Then responde 403 sin efectos (no se crea campaña, no se dispara envío, no se filtra data)

### Requirement: RBAC-2 — `messaging.templates` gatea el listado de templates
`GET /api/messaging/bulk/templates` MUST requerir el permiso `messaging.templates`; tener
`messaging.bulk` MUST NOT ser suficiente por sí solo para listar templates (permisos separados,
no implican uno al otro).

#### Scenario: usuario con messaging.bulk pero sin messaging.templates
- Given un usuario con `messaging.bulk` pero sin `messaging.templates`
- When llama a `GET /api/messaging/bulk/templates`
- Then responde 403

#### Scenario: usuario con messaging.templates pero sin messaging.bulk
- Given un usuario con `messaging.templates` pero sin `messaging.bulk`
- When llama a `POST /api/messaging/bulk/campaigns`
- Then responde 403

### Requirement: RBAC-3 — seed idempotente de `messaging.bulk`/`messaging.templates`
La migración RBAC nueva MUST sembrar los permisos `bulk`/`templates` bajo el módulo `messaging`
existente + otorgarlos a `super_admin`/`administrador`, clonando el patrón idempotente
(`ON CONFLICT DO NOTHING`) de `20260904000100_messaging_permissions`.

#### Scenario: la migración corre dos veces
- When la migración de seed de `bulk`/`templates` corre dos veces
- Then no falla ni duplica filas de permiso/grant (mismo criterio que RBAC-3 de
  `messaging-inbox`)
