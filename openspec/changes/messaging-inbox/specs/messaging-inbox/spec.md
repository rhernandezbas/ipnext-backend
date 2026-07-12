# Spec — messaging-inbox (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

## Capability: ingesta de webhook Chatwoot

### Requirement: HOOK-1 — verificación HMAC de la firma del webhook
`POST /api/messaging/webhook` MUST validar `X-Chatwoot-Signature: sha256=<hex>` recomputando
`HMAC-SHA256(CHATWOOT_WEBHOOK_SECRET, "{X-Chatwoot-Timestamp}.{rawBody}")` sobre el body CRUDO
(no parseado) y comparando en constant-time. Sin firma válida, el sistema MUST rechazar antes
de tocar el mirror.

#### Scenario: firma válida — el evento se procesa
- Given un POST con `X-Chatwoot-Signature` que matchea el HMAC recomputado sobre el raw body y
  el secret configurado
- When llega el webhook
- Then la firma se acepta y el evento pasa a evaluarse por tipo (HOOK-4)

#### Scenario: firma inválida — rechazo sin efectos
- Given un POST cuya firma NO matchea el HMAC recomputado (secret incorrecto, body alterado, o
  header ausente/malformado)
- When llega el webhook
- Then responde 401 `{ code: 'INVALID_SIGNATURE' }` y NO se toca el mirror ni se procesa el evento

#### Scenario: falta el body crudo — nunca se asume válido
- Given el body ya fue parseado/mutado antes de esta validación (sin acceso al raw body)
- When se intenta verificar la firma
- Then el sistema MUST tratarlo como firma inválida (fail-closed), nunca aceptar por defecto

### Requirement: HOOK-2 — anti-replay por ventana de timestamp
El sistema MUST rechazar webhooks cuyo `X-Chatwoot-Timestamp` esté fuera de una ventana de
±5 minutos respecto de la hora del servidor, incluso con firma válida.

#### Scenario: timestamp dentro de ventana
- Given firma válida y `X-Chatwoot-Timestamp` a 30 segundos de la hora actual
- When llega el webhook
- Then se acepta y continúa a HOOK-4

#### Scenario: timestamp viejo (replay)
- Given firma válida pero `X-Chatwoot-Timestamp` a más de 5 minutos en el pasado
- When llega el webhook
- Then responde 401 `{ code: 'STALE_TIMESTAMP' }` sin procesar el evento

#### Scenario: timestamp futuro fuera de tolerancia
- Given firma válida pero `X-Chatwoot-Timestamp` más de 5 minutos en el futuro
- When llega el webhook
- Then responde 401 `{ code: 'STALE_TIMESTAMP' }` sin procesar el evento

### Requirement: HOOK-3 — idempotencia por `X-Chatwoot-Delivery`
El sistema MUST deduplicar por el header `X-Chatwoot-Delivery`; una entrega ya procesada
MUST NOT reprocesarse ni reescribir el mirror.

#### Scenario: primera entrega de un delivery id
- Given un `X-Chatwoot-Delivery` nunca visto, firma y timestamp válidos
- When llega el webhook
- Then se procesa el evento y se registra el delivery id como visto

#### Scenario: delivery duplicado
- Given un `X-Chatwoot-Delivery` ya registrado (reintento de Chatwoot u otro origen)
- When llega el webhook de nuevo con el mismo delivery id
- Then responde 200 sin reprocesar el evento ni volver a escribir el mirror (ack idempotente,
  evita que Chatwoot siga reintentando)

### Requirement: HOOK-4 — procesamiento de eventos suscritos → upsert al mirror
El sistema MUST procesar `message_created` (upsert `Conversation`+`ChatMessage`),
`conversation_created` (upsert `Conversation`) y `conversation_status_changed` (actualiza
`status` de la `Conversation`), mapeando el payload de Chatwoot a los modelos mirror — nunca
persistir el payload crudo tal cual.

#### Scenario: message_created — upsert de conversación y mensaje
- Given un payload `message_created` válido (firma/timestamp/delivery OK) para una conversación
  ya existente en el mirror
- When se procesa el evento
- Then se upsertea el `ChatMessage` (idempotente por `chatwootMessageId`) y se actualiza
  `Conversation.lastMessageAt`/preview

#### Scenario: conversation_created — conversación nueva
- Given un payload `conversation_created` para una conversación que NO existe en el mirror
- When se procesa el evento
- Then se crea la `Conversation` en el mirror con contacto y estado iniciales

#### Scenario: conversation_status_changed — actualiza estado
- Given una `Conversation` existente en el mirror
- When llega `conversation_status_changed` con el nuevo estado
- Then el `status` del mirror se actualiza, sin tocar los mensajes

### Requirement: HOOK-5 — eventos no suscritos se ignoran
Eventos de tipo distinto a los tres suscritos (HOOK-4) MUST ignorarse sin error.

#### Scenario: tipo de evento desconocido
- Given firma/timestamp/delivery válidos pero un `event` no suscrito (p.ej. `contact_updated`)
- When llega el webhook
- Then responde 200 sin persistir nada y sin lanzar excepción

## Capability: inbox de conversaciones

### Requirement: INBOX-1 — listado paginado ordenado por último mensaje
`GET /api/messaging/conversations` MUST devolver una página de conversaciones mapeadas a DTO
(nunca la entidad Prisma cruda), ordenadas por `lastMessageAt` descendente.

#### Scenario: listado con conversaciones
- Given 3 conversaciones en el mirror con distinto `lastMessageAt`
- When se pide `GET /api/messaging/conversations`
- Then la respuesta trae las 3 ordenadas de más reciente a más antigua, cada item como DTO
  (id/contactName/contactPhone/lastMessageAt/preview/status), sin campos internos de Prisma

#### Scenario: página vacía
- Given ninguna conversación en el mirror
- When se pide el listado
- Then responde 200 con `data: []`

### Requirement: INBOX-2 — detalle con fetch-on-open (backstop de sincronización)
`GET /api/messaging/conversations/:id` MUST disparar una sincronización fresca contra la API
de Chatwoot (mensajes de esa conversación) y upsertear idempotentemente al mirror ANTES de
responder. Un fallo de esa sincronización MUST NOT impedir servir el snapshot del mirror.

#### Scenario: fetch-on-open trae mensajes nuevos
- Given una conversación en el mirror desactualizada (le falta el último mensaje real)
- When se pide `GET /api/messaging/conversations/:id`
- Then el sistema consulta la API de Chatwoot, upsertea los mensajes faltantes (idempotente por
  `chatwootMessageId`) y la respuesta incluye el mensaje nuevo

#### Scenario: Chatwoot no responde durante el fetch-on-open
- Given la API de Chatwoot está caída o responde error
- When se pide `GET /api/messaging/conversations/:id`
- Then el sync falla silenciosamente (se loguea) y la respuesta 200 sirve el snapshot existente
  del mirror — nunca cuelga ni devuelve 500 por esto

#### Scenario: conversación inexistente
- Given un `:id` que no existe en el mirror
- When se pide el detalle
- Then responde 404

### Requirement: INBOX-3 — historial de mensajes
`GET /api/messaging/conversations/:id/messages` MUST devolver el historial mapeado a DTO en
orden cronológico ascendente (más viejo primero).

#### Scenario: historial con mensajes de ambas direcciones
- Given una conversación con mensajes inbound y outbound intercalados
- When se pide el historial
- Then vienen ordenados cronológicamente con `direction` (`inbound`/`outbound`) por mensaje,
  sin exponer ids internos de Chatwoot como claves primarias del DTO

#### Scenario: conversación sin mensajes
- Given una conversación recién creada sin mensajes aún
- When se pide el historial
- Then responde 200 con `data: []`

## Capability: envío dentro de ventana 24h

### Requirement: SEND-1 — envío exitoso dentro de la ventana
`POST /api/messaging/conversations/:id/messages` MUST reenviar el mensaje a la API de Chatwoot
y upsertear el `ChatMessage` resultante (outbound) en el mirror, solo cuando el último mensaje
INBOUND de la conversación esté dentro de las 24hs.

#### Scenario: envío dentro de ventana
- Given el último mensaje inbound de la conversación fue hace menos de 24hs
- When se hace `POST .../messages` con contenido válido
- Then se llama a la API de Chatwoot (crear mensaje), se upsertea el `ChatMessage` outbound en
  el mirror y la respuesta trae el DTO del mensaje creado

### Requirement: SEND-2 — fuera de ventana 24h → error claro (sin templates en F1)
Fuera de la ventana de 24h desde el último inbound (o si nunca hubo un inbound), el sistema
MUST rechazar el envío con un error explícito, SIN llamar a Chatwoot. Los templates
aprobados por Meta para reabrir la ventana son F2, fuera de alcance.

#### Scenario: último inbound hace más de 24hs
- Given el último mensaje inbound de la conversación fue hace más de 24hs
- When se hace `POST .../messages`
- Then responde 422 `{ code: 'MESSAGING_WINDOW_EXPIRED' }` sin llamar a Chatwoot ni tocar el
  mirror

#### Scenario: conversación sin ningún mensaje inbound
- Given una conversación en el mirror sin ningún `ChatMessage` inbound registrado
- When se hace `POST .../messages`
- Then responde 422 `{ code: 'MESSAGING_WINDOW_EXPIRED' }` (no hay ventana abierta que verificar)

### Requirement: SEND-3 — Chatwoot caído no cuelga (lección 504)
Si la API de Chatwoot no responde o responde 5xx al enviar, el sistema MUST responder con un
status mapeado de inmediato, sin dejar el request colgado y sin escribir el mirror.

#### Scenario: Chatwoot inalcanzable al enviar
- Given la ventana de 24h está abierta pero la API de Chatwoot está caída/timeoutea
- When se hace `POST .../messages`
- Then responde 503 `{ code: 'CHATWOOT_UNAVAILABLE' }` de inmediato, sin upsert en el mirror

## Capability: contexto de cliente por teléfono

### Requirement: CTX-1 — match de teléfono contra clientes activos
`GetClientContextByPhone` MUST normalizar el teléfono del contacto de la conversación
(reusando `normalizePhone`) y compararlo por sufijo (`suffixMatch`/`matchActiveClient`) contra
`CustomerRepository.listActiveContacts()`, devolviendo un DTO — nunca la entidad `Client` cruda.

#### Scenario: un único cliente activo matchea
- Given el teléfono del contacto normaliza al mismo sufijo que UN cliente activo
- When se abre la conversación
- Then el contexto devuelve `{ status: 'matched', clients: [{ id, name, status }] }`

#### Scenario: sin match — cliente desconocido
- Given el teléfono del contacto no matchea ningún cliente activo
- When se abre la conversación
- Then el contexto devuelve `{ status: 'unknown', clients: [] }`, sin excepción

#### Scenario: múltiples clientes matchean (ambiguo)
- Given el teléfono del contacto matchea 2+ clientes activos distintos
- When se abre la conversación
- Then el contexto devuelve `{ status: 'ambiguous', clients: [...] }` con todos los candidatos
  (el agente decide, no se bloquea la conversación)

#### Scenario: teléfono del contacto ausente o basura
- Given el contacto de la conversación no tiene teléfono, o tiene menos de 8 dígitos tras
  normalizar
- When se abre la conversación
- Then el contexto devuelve `{ status: 'unknown', clients: [] }` sin lanzar excepción

### Requirement: CTX-2 — el contexto no muta nada
Calcular o exponer el contexto de cliente MUST NOT modificar `Client` ni la `Conversation`.

#### Scenario: abrir la conversación repetidamente no cambia nada
- Given una conversación con contexto `matched`
- When se pide el detalle repetidas veces
- Then el `updatedAt` del `Client` matcheado no cambia por este efecto

## Capability: RBAC y robustez de messaging

### Requirement: RBAC-1 — `messaging:read` gatea la lectura del inbox
`GET /api/messaging/conversations`, `GET .../conversations/:id` y `GET .../messages` MUST
requerir el permiso `messaging:read` (módulo `messaging`, acción `read` — equivalente a
`messaging.read` en la decisión del usuario).

#### Scenario: sin permiso
- Given un usuario autenticado sin `messaging:read`
- When llama a cualquiera de las rutas de lectura
- Then responde 403 sin efectos

### Requirement: RBAC-2 — `messaging:send` gatea la respuesta
`POST /api/messaging/conversations/:id/messages` MUST requerir `messaging:send`; tener
`messaging:read` MUST NOT ser suficiente para enviar.

#### Scenario: solo con messaging:read
- Given un usuario con `messaging:read` pero sin `messaging:send`
- When hace `POST .../messages`
- Then responde 403 sin llamar a Chatwoot

### Requirement: RBAC-3 — seed idempotente del módulo `messaging`
La migración MUST crear el módulo `messaging` con permisos `read`/`send` y otorgarlos a
`super_admin`/`administrador`, clonando el patrón idempotente de
`20260903000000_actions_permissions` (`ON CONFLICT DO NOTHING`).

#### Scenario: la migración corre dos veces
- When la migración de seed corre dos veces
- Then no falla ni duplica filas de módulo/permiso/grant

### Requirement: RBAC-4 — el webhook NO usa RBAC de sesión
`POST /api/messaging/webhook` MUST autenticarse solo por firma HMAC (HOOK-1/2/3) — MUST NOT
requerir sesión de usuario ni `messaging:read`/`send` (es tráfico máquina-a-máquina de
Chatwoot, no un usuario de Prominense).

#### Scenario: webhook sin cookie/JWT de sesión
- Given un request al webhook sin ningún header de auth de usuario, solo firma HMAC válida
- When llega el webhook
- Then se procesa normalmente (HOOK-1..5), sin pasar por el middleware de sesión/RBAC de
  usuario

### Requirement: ROB-1 — ninguna ruta de messaging cuelga (lección 504)
Todos los handlers async de `messaging` MUST responder con un status inmediato ante errores
(repo caído, Chatwoot inalcanzable, error de parseo), nunca dejar el request sin resolver.

#### Scenario: el mirror repository lanza
- Given `ConversationRepository` (o `ChatMessageRepository`) lanza en cualquier ruta de
  messaging
- When se ejecuta el handler
- Then responde con un status de error inmediato (`next(err)` o mapeo tipado), nunca cuelga
