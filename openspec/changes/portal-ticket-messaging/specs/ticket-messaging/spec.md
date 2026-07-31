# Ticket Messaging Specification

## Purpose

Convertir el reclamo en una conversación cliente↔staff dentro del ticket, con adjuntos, sin que
una sola nota interna se le escape al cliente.

**Invariante central**: un comentario con `visibility = internal` NO SALE JAMÁS por
`/api/portal/*`. Se filtra en la **query del repositorio**, no en el mapper — un filtro en el
mapper puede olvidarse en un endpoint nuevo; uno en el repo es el default.

**Fuera de alcance:** push (v2.C), Chatwoot/WhatsApp, chat fuera de un ticket, editar/borrar.

## Requirements

### Requirement: Autoría y visibilidad de cada comentario
Cada `TicketComment` DEBE (MUST) registrar **quién lo escribió** (`client` | `staff`, con el id
del autor cuando exista) y **para quién es visible** (`public` = lo ve el cliente | `internal` =
solo staff). Ambos campos son obligatorios en toda escritura nueva.

#### Scenario: Comentario del cliente
- **WHEN** un cliente escribe desde la app
- **THEN** el comentario queda `authorKind: client` + `visibility: public` (lo que el cliente
  escribe es, por definición, parte de la conversación)

#### Scenario: Nota interna del staff
- **WHEN** un operador escribe una nota interna
- **THEN** queda `authorKind: staff` + `visibility: internal` y **jamás** aparece en el portal

### Requirement: Backfill conservador de lo existente
La migración DEBE (MUST) marcar TODOS los `TicketComment` preexistentes como `authorKind: staff`
y `visibility: internal`. Ningún comentario histórico se vuelve visible para clientes por efecto
de este cambio.

#### Scenario: Ticket viejo con notas internas
- **WHEN** un cliente abre un reclamo que ya existía, con comentarios previos del equipo
- **THEN** no ve NINGUNO de esos comentarios — solo lo que se escriba desde ahora como público

### Requirement: El cliente lee y escribe en SU reclamo
`GET /api/portal/tickets/:number/messages` DEBE (MUST) devolver **solo los `public`** del ticket
del cliente del token, en orden cronológico. `POST` agrega un mensaje del cliente, con
validación de contenido y **rate limit** propio.

#### Scenario: Hilo del cliente
- **WHEN** el cliente abre un reclamo con 2 públicos y 3 internos
- **THEN** ve exactamente 2 mensajes

#### Scenario: Reclamo ajeno
- **WHEN** pide los mensajes de un reclamo de otro cliente
- **THEN** 404 indistinguible de "no existe" (misma respuesta que el detalle del ticket)

#### Scenario: Mensaje vacío o gigante
- **WHEN** el body no tiene contenido ni adjuntos, o excede el largo máximo
- **THEN** 400 con el detalle del campo, sin crear nada

### Requirement: La visibilidad la determina la RUTA, no el payload
**Decisión del usuario (revisión durante implementación):** en vez de un único endpoint admin con
un campo `visibility` obligatorio, existen **dos rutas admin separadas** — una que SIEMPRE crea el
mensaje **público** (la respuesta al cliente) y otra que SIEMPRE crea la **nota interna**. Ninguna
de las dos acepta `visibility` como parámetro del body: el estado ilegal ("nota interna" publicada
por accidente, o viceversa) queda **irrepresentable** — no hay campo que alguien pueda setear mal,
ni default que alguien cambie sin entender. Lo mismo aplica del lado del portal: el mensaje del
cliente es público por definición de su propia ruta, sin campo `visibility` en el request.

Si el body de cualquiera de estas rutas (admin público, admin interno, o portal) trae un campo
`visibility` de todos modos, la operación se **rechaza con 400** — nunca se ignora en silencio ni
cambia el resultado. Un intento ruidoso es preferible a una ambigüedad silenciosa.

#### Scenario: Respuesta pública al cliente
- **WHEN** el operador usa la ruta de respuesta pública
- **THEN** el mensaje se crea `visibility: public` y aparece en la app del cliente

#### Scenario: Nota interna
- **WHEN** el operador usa la ruta de nota interna
- **THEN** el mensaje se crea `visibility: internal` y jamás sale por el portal

#### Scenario: Visibility en el body no cambia nada
- **WHEN** el request a cualquiera de las tres rutas de escritura (admin público, admin interno,
  portal) trae un campo `visibility` en el body
- **THEN** 400 — el campo se rechaza, nunca determina el resultado (la ruta ya lo fijó)

### Requirement: Adjuntos de foto, audio y video
Un mensaje DEBE (MUST) poder llevar adjuntos (imagen, audio, video) persistidos en MinIO y
referenciados por `TicketCommentAttachment` (`url`, `filename`, `mimeType`, `sizeBytes`). Los
tipos permitidos y el tamaño máximo se validan **en el backend**, tanto por el tipo declarado
como por los **magic bytes del contenido real** (un ejecutable renombrado a `.jpg` con
`Content-Type: image/jpeg` se rechaza igual — la app filtra por comodidad, el BE es la
autoridad). Las URLs entregadas al cliente NUNCA son un bucket público ni un objeto S3
prefirmado (presigned): son una **ruta permanente del propio backend**
(`GET /api/tickets/messages/attachments/:id/file` del lado admin,
`GET /api/portal/tickets/:number/messages/attachments/:id/file` del lado portal) que exige
autenticación y **revalida pertenencia en cada request** (fix wave, corrección de esta spec —
la redacción original pedía "acceso temporal", pero eso describe una presigned URL de
vencimiento corto, que es un mecanismo **peor** para este caso: una presigned es válida para
cualquiera que la tenga hasta que expira, sin revocación ni re-chequeo de dueño; la ruta del BE
corta el acceso al instante si el ticket cambia de dueño o el adjunto deja de ser público, sin
depender de un TTL).

#### Scenario: Cliente manda una foto del módem
- **WHEN** adjunta una imagen dentro de los límites
- **THEN** el mensaje se crea con su adjunto y el operador lo ve en el ticket

#### Scenario: Tipo no permitido
- **WHEN** intenta subir un tipo fuera de la lista (ej. un ejecutable)
- **THEN** 400 y no se guarda nada en el storage

#### Scenario: Adjunto de un reclamo ajeno
- **WHEN** alguien pide la URL de un adjunto de otro cliente
- **THEN** no la obtiene (la pertenencia se valida al emitir la URL, no al guardarla)

### Requirement: No leídos por lado
El sistema DEBE (MUST) permitir saber cuántos mensajes públicos no leyó cada lado, para el badge
de la app y el indicador del ticket en Prominense.

#### Scenario: Respuesta nueva sin leer
- **WHEN** el operador responde y el cliente todavía no abrió el reclamo
- **THEN** la app muestra el reclamo con 1 no leído; al abrirlo, el contador se limpia
