# Spec — messaging-inbox-notes (delta, F1.5 fase D — nota privada)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Delta sobre
`openspec/specs/messaging-inbox/spec.md` — capability nueva "notas privadas" + 1 requirement
existente (SEND-1) modificado.

## MODIFIED Requirements

### Requirement: SEND-1 — envío exitoso dentro de la ventana (o nota privada sin ventana)
`POST /api/messaging/conversations/:id/messages` MUST reenviar el mensaje a la API de Chatwoot
y upsertear el `ChatMessage` resultante (outbound) en el mirror, cuando el último mensaje
INBOUND esté dentro de las 24hs — salvo que el envío sea una NOTA PRIVADA (`isPrivate:true`),
caso en el que el chequeo de ventana MUST NOT aplicarse: una nota interna nunca cruza a
WhatsApp, la ventana de 24h (regla de Meta) es irrelevante para ella.
(Previously: el guard de ventana aplicaba siempre, sin excepción — `!conversation.canReply` →
422 incondicional.)

#### Scenario: envío dentro de ventana (mensaje normal)
- Given el último inbound fue hace menos de 24hs, `isPrivate` ausente/false
- When `POST .../messages` con contenido válido
- Then se llama a Chatwoot, se upsertea el `ChatMessage` outbound (`isPrivate:false`) y la
  respuesta trae el DTO

#### Scenario: nota privada con ventana cerrada — bypass, 201 (NO 422)
- Given `conversation.canReply === false` (último inbound hace +24hs, o ninguno)
- When `POST .../messages` con `private:true`
- Then el guard de `canReply` NO se evalúa para este envío: se llama a Chatwoot con
  `private:true`, se upsertea `ChatMessage` con `isPrivate:true` y responde 201 — nunca 422
  `MESSAGING_WINDOW_EXPIRED`

## ADDED Requirements

### Requirement: NOTE-1 — modelo: columna `isPrivate` aditiva
`ChatMessage` MUST tener `isPrivate Boolean @default(false)` vía migración aditiva sin
backfill (nunca hubo filas históricas de private — F1 siempre las descartó). El port
(`ChatMessageRecord`/`UpsertChatMessageInput`), `PrismaChatMessageRepository` e
`InMemoryChatMessageRepository` MUST mapear el campo simétricamente.

#### Scenario: migración aditiva no rompe filas existentes
- Given filas `ChatMessage` sin la columna
- When corre la migración
- Then todas quedan `isPrivate:false` por default, sin error, sin backfill manual

#### Scenario: upsert sin `isPrivate` explícito
- Given un upsert (cualquier repo) sin `isPrivate` en el input
- When se persiste
- Then el registro queda `isPrivate:false`

### Requirement: NOTE-2 — captura: persistir notas privadas en vez de descartarlas
Los dos caminos de ingesta (webhook `message_created`, `ReceiveChatwootWebhook.ts:170`; y
fetch-on-open, `GetConversation.ts:73`) MUST persistir CUALQUIER mensaje `private:true` de
Chatwoot — sin distinguir si se originó en Prominense o directo en Chatwoot (modelo mirror
actual: ambos caminos ya traen TODO indiscriminadamente) — con `isPrivate:true`, en vez de
descartarlo vía `return`/`continue`.

#### Scenario: nota privada entrante por webhook se persiste marcada
- Given un payload `message_created` con `private:true`
- When se procesa el webhook
- Then se upsertea `ChatMessage` con `isPrivate:true` (el guard de descarte ya NO incluye
  `isPrivateNote`)

#### Scenario: nota privada existente en Chatwoot llega por fetch-on-open
- Given una conversación con un mensaje `private:true` en Chatwoot ausente del mirror
- When `GET .../conversations/:id`
- Then se upsertea con `isPrivate:true`

#### Scenario: mensaje normal sin cambios
- Given un mensaje sin `private` (o `false`) en cualquiera de los dos caminos
- When se captura
- Then se persiste `isPrivate:false` — comportamiento idéntico a hoy

### Requirement: NOTE-3 — anti-leak: una nota privada NUNCA bumpea el preview del inbox
Ni la captura (`bumpsPreview` en el webhook) ni el envío (`SendMessage`) MUST bumpear
`Conversation.lastMessageAt`/`lastMessagePreview` cuando el mensaje es privado — la lista de
conversaciones no debe delatar una nota interna sin abrir el thread. Un mensaje NORMAL enviado
o recibido SIGUE bumpeando igual que hoy (no debe romperse por este cambio).

#### Scenario: nota privada entrante no cambia el preview
- Given una conversación con `lastMessagePreview: "Hola"`
- When llega una nota privada por webhook (`private:true`)
- Then `lastMessageAt`/`lastMessagePreview` NO cambian (`bumpsPreview` sigue excluyendo
  private — sin tocar esa línea)

#### Scenario: nota privada enviada no cambia el preview
- Given una conversación con `lastMessagePreview: "Hola"`
- When se escribe una nota (`POST .../messages` con `private:true`)
- Then el bump al final de `SendMessage.execute` NO se ejecuta — preview sin cambios

#### Scenario: mensaje normal enviado SIGUE bumpeando
- Given una conversación con ventana abierta
- When se envía un mensaje normal (`private` ausente/false)
- Then `lastMessageAt`/`lastMessagePreview` SÍ se actualizan, igual que en F1.5 hoy

### Requirement: NOTE-4 — gateway: Chatwoot recibe `private:true`
`ChatwootGateway.sendMessage` MUST aceptar una forma de indicar `private:true` (aditiva —
compatible con los call sites de 3 argumentos existentes) y `HttpChatwootGateway` MUST
propagarlo en ambos caminos (JSON body / `form.append('private','true')` en multipart).

#### Scenario: nota → Chatwoot recibe private:true
- Given `SendMessage.execute(..., isPrivate: true)`
- When se llama al gateway
- Then el POST a Chatwoot incluye `private:true`

#### Scenario: mensaje normal → sin campo private (compat)
- Given `isPrivate` ausente/false
- When se llama al gateway
- Then el POST a Chatwoot NO incluye `private` — idéntico a hoy

### Requirement: NOTE-5 — DTO: `ChatMessageDto.private`
`toChatMessageDto` MUST exponer `private: boolean`, mapeado 1:1 desde
`ChatMessageRecord.isPrivate` (rename de wire: `isPrivate` en schema/dominio ↔ `private` en el
DTO — mismo nombre que Chatwoot usa en su propio wire). Nunca exponer la entidad Prisma cruda.

#### Scenario: mensaje privado en el DTO
- Given `ChatMessageRecord.isPrivate === true`
- When se mapea a DTO
- Then `ChatMessageDto.private === true`

#### Scenario: mensaje normal en el DTO
- Given `isPrivate === false`
- When se mapea
- Then `ChatMessageDto.private === false`

### Requirement: NOTE-6 — endpoint: `POST /conversations/:id/messages` acepta `private`
La ruta MUST leer un flag `private`/`isPrivate` tanto del body JSON como del multipart y
pasarlo a `sendMessage.execute` como `isPrivate` (default `false` si está ausente — cero
regresión sobre F1). Adjuntos en notas quedan FUERA de alcance v1 (ver Risks del explore).

#### Scenario: nota vía JSON
- Given `POST` con body `{ content, private: true }`
- When se procesa
- Then `sendMessage.execute` recibe `isPrivate: true`

#### Scenario: nota vía multipart
- Given `POST` multipart con campo `private=true`
- When se procesa
- Then `sendMessage.execute` recibe `isPrivate: true`

#### Scenario: ausencia de `private` → comportamiento F1 idéntico
- Given `POST` sin `private`/`isPrivate` en el body
- When se procesa
- Then `sendMessage.execute` recibe `isPrivate: false` — sin regresión

### Requirement: NOTE-7 — RBAC: `messaging:send` gatea escribir una nota
Escribir una nota privada MUST requerir `messaging:send` — el mismo guard `perms.send` que
responder. No se introduce un permiso separado `messaging:note`.

#### Scenario: sin messaging:send
- Given un usuario solo con `messaging:read`
- When intenta `POST .../messages` con `private:true`
- Then responde 403, sin llamar a Chatwoot
