# Ticket Messaging Specification

## Purpose

Convertir el reclamo en una conversación cliente↔staff dentro del ticket, con adjuntos, sin que
una sola nota interna se le escape al cliente.

**Invariante central**: un comentario con `visibility = internal` NO SALE JAMÁS por
`/api/portal/*`. Se filtra en la **query del repositorio**, no en el mapper — un filtro en el
mapper puede olvidarse en un endpoint nuevo; uno en el repo es el default.

**Fuera de alcance:** push (v2.C), Chatwoot/WhatsApp, chat fuera de un ticket, editar/borrar.

> **Nota de reconciliación (fix wave FINAL, G2):** esta versión del spec vive en la rama
> `feat/portal-ticket-messaging` — la que se commiteó en `main` (`a2359aea`) NO es ancestro de
> esta rama, así que nunca viajó acá con un merge, y el texto había quedado desincronizado de la
> implementación real en varios códigos de error. Esta versión reconcilia el texto contra el
> código, con el PORQUÉ de cada código documentado abajo (no son 400 "por default" — cada uno es
> una decisión deliberada, ver `src/domain/errors/ticketMessage.ts` y
> `src/infrastructure/http/middleware/errorHandler.ts`).

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

> **Nota operativa — DROP DEFAULT pendiente para el PRÓXIMO deploy (corrección de orden de
> deploy, revierte G5):** la migración `20261029000000_ticket_messaging` agrega `authorKind`/
> `visibility` con `DEFAULT 'staff'`/`DEFAULT 'internal'` para proteger la ventana de deploy —
> entre que `prisma migrate deploy` corre y el swap del container termina, el código VIEJO (que
> no conoce estas columnas) puede seguir insertando `TicketComment` sin especificarlas; sin
> DEFAULT esa ventana revienta con NOT NULL violation (500 en `POST /api/tickets/:id/comments`).
> `schema.prisma` espeja ese DEFAULT con `@default(staff)`/`@default(internal)` a propósito —
> **no** es drift.
>
> G5 había intentado sacar el DEFAULT en el MISMO release (schema sin `@default` + migración de
> seguimiento `20261029000100_ticket_comment_drop_defaults` con `DROP DEFAULT`), pero
> `prisma migrate deploy` aplica TODAS las migraciones pendientes de una sola pasada, ANTES del
> swap — con las dos migraciones en la misma branch, el DEFAULT se agregaba y se borraba en el
> MISMO deploy, reabriendo la ventana que estaba destinado a proteger. Se revirtió: la migración
> de seguimiento se sacó de esta branch.
>
> **Una vez que el código de ESTE release esté corriendo en TODAS las instancias** (el que
> SIEMPRE estampa `authorKind`/`visibility` explícitamente — `AddTicketComment`,
> `SendStaffTicketReply`, `SendPortalTicketMessage`), un deploy FUTURO debe:
> 1. sacar `@default(staff)`/`@default(internal)` de `authorKind`/`visibility` en `schema.prisma`, y
> 2. crear una migración nueva (release aparte, nunca el mismo) con
>    `ALTER COLUMN "authorKind" DROP DEFAULT, ALTER COLUMN "visibility" DROP DEFAULT;`
>
> El DEFAULT permanente es un peligro de tipos: con `@default`, un `create` futuro que se olvide
> de pasar `authorKind` compila igual y estampa `'staff'` en silencio — puede esconder un mensaje
> del CLIENTE mal-etiquetado como staff (no cuenta en `countUnread`, se muestra como si lo hubiera
> escrito soporte). Ver `ticket-messaging-migration.test.ts` y el docstring de `TicketComment` en
> `prisma/schema.prisma`.

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
- **WHEN** el body no tiene contenido ni adjuntos, o excede el largo máximo (`MAX_MESSAGE_BODY_LEN`)
- **THEN** 400 `TICKET_MESSAGE_VALIDATION` con el detalle, sin crear nada — validado en el USE
  CASE (`createTicketMessageWithAttachments`), no en el schema de zod: la ruta solo valida FORMA,
  el use case valida CONTENIDO (mismo criterio que `CreatePortalTicket`, una sola fuente de
  verdad para reglas de negocio)

### Requirement: La visibilidad la determina la RUTA, no el payload
**Decisión del usuario (revisión durante implementación):** en vez de un único endpoint admin con
un campo `visibility` obligatorio, existen **dos rutas admin separadas** — una que SIEMPRE crea el
mensaje **público** (la respuesta al cliente) y otra que SIEMPRE crea la **nota interna**. Ninguna
de las dos acepta `visibility` como parámetro del body: el estado ilegal ("nota interna" publicada
por accidente, o viceversa) queda **irrepresentable** — no hay campo que alguien pueda setear mal,
ni default que alguien cambie sin entender. Lo mismo aplica del lado del portal: el mensaje del
cliente es público por definición de su propia ruta, sin campo `visibility` en el request.

Si el body de cualquiera de estas rutas (admin público, admin interno, o portal) trae un campo
`visibility` de todos modos, la operación se **rechaza** — nunca se ignora en silencio ni cambia
el resultado. Un intento ruidoso es preferible a una ambigüedad silenciosa. **El código de
rechazo NO es uniforme entre las tres rutas** (reconciliado en G2, fix wave FINAL — la redacción
original decía "400" para las tres; la implementación real, deliberadamente, no lo hace):

- `POST /api/tickets/:ticketId/comments` (nota interna, `AddTicketCommentSchema.strict()`) →
  **422** `VALIDATION_ERROR`. Esta ruta es la de las notas internas de siempre
  (`ticketComments.routes.ts`) y **toda** su validación —de antes de este change y de este
  change— ya respondía 422; `visibility` es un campo más rechazado por `.strict()`, no una regla
  nueva con un código propio. Cambiarlo a 400 solo para este campo rompería la consistencia
  interna de la ruta.
- `POST /api/tickets/:ticketId/messages` (respuesta pública del staff,
  `SendStaffTicketReplySchema.strict()`) → **400** `VALIDATION_ERROR`
  (`ticketMessages.routes.ts`, ruta nueva de este change).
- `POST /api/portal/tickets/:number/messages` (mensaje del cliente,
  `SendPortalTicketMessageSchema.strict()`) → **400** `VALIDATION_ERROR` (`portal.routes.ts`,
  ruta nueva de este change).

Las dos rutas NUEVAS de este change acordaron 400 entre sí; la ruta VIEJA de notas internas
conserva el 422 que ya tenía para todo lo demás — priorizar la consistencia LOCAL de cada ruta
sobre una uniformidad global que ninguna ruta pedía.

#### Scenario: Respuesta pública al cliente
- **WHEN** el operador usa la ruta de respuesta pública
- **THEN** el mensaje se crea `visibility: public` y aparece en la app del cliente

#### Scenario: Nota interna
- **WHEN** el operador usa la ruta de nota interna
- **THEN** el mensaje se crea `visibility: internal` y jamás sale por el portal

#### Scenario: Visibility en el body de una nota interna no cambia nada
- **WHEN** `POST /api/tickets/:ticketId/comments` trae un campo `visibility` en el body
- **THEN** 422 `VALIDATION_ERROR` — el campo se rechaza, nunca determina el resultado (la ruta ya
  lo fijó en `internal`)

#### Scenario: Visibility en el body de una respuesta pública (staff o portal) no cambia nada
- **WHEN** el request a `POST /api/tickets/:ticketId/messages` o
  `POST /api/portal/tickets/:number/messages` trae un campo `visibility` en el body
- **THEN** 400 `VALIDATION_ERROR` — el campo se rechaza, nunca determina el resultado (la ruta ya
  la fijó en `public`)

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

**Códigos de error de adjuntos (reconciliado en G2, fix wave FINAL — ver
`src/domain/errors/ticketMessage.ts` y el `statusMap` de `errorHandler.ts`; la redacción original
decía "400" genérico para todo lo de esta sección):**

| Situación | Código de dominio | HTTP |
|---|---|---|
| Tipo fuera de la allowlist, o magic bytes no matchean el mimeType declarado | `UNSUPPORTED_TICKET_MESSAGE_ATTACHMENT_TYPE` | **415** |
| Archivo de 0 bytes | `UNSUPPORTED_TICKET_MESSAGE_ATTACHMENT_TYPE` (mismo código — 0 bytes no es un tamaño válido de ningún formato permitido) | **415** |
| Un adjunto excede el tope de su categoría (imagen 8MB / audio 15MB / video 40MB) | `TICKET_MESSAGE_ATTACHMENT_TOO_LARGE` | **413** |
| El batch combinado excede `MAX_TOTAL_BATCH_BYTES` (60MB), detectado por `Content-Length` o por la suma real de multer | `BATCH_TOO_LARGE` (nivel middleware, no domain error) | **413** |
| Más de `MAX_ATTACHMENTS_PER_MESSAGE` (5) adjuntos, detectado por la validación de negocio | `TOO_MANY_TICKET_MESSAGE_ATTACHMENTS` | **422** |
| Más de 5 adjuntos, detectado por el límite `files` de multer ANTES de llegar al use case (mismo tope, capa distinta) | `TOO_MANY_FILES` (nivel middleware) | **400** |

La fila de 400 (`TOO_MANY_FILES`) es una nota de implementación, no una regla de negocio nueva:
multer y la validación de negocio comparten el MISMO número (`MAX_ATTACHMENTS_PER_MESSAGE`), así
que en la práctica multer corta primero y el 422 de negocio queda como la autoridad de la regla
sin ser, hoy, el código que efectivamente responde en ese caso límite exacto.

#### Scenario: Cliente manda una foto del módem
- **WHEN** adjunta una imagen dentro de los límites
- **THEN** el mensaje se crea con su adjunto y el operador lo ve en el ticket

#### Scenario: Tipo no permitido
- **WHEN** intenta subir un tipo fuera de la lista (ej. un ejecutable, o un `.jpg` cuyo contenido
  real no son bytes de JPEG)
- **THEN** 415 `UNSUPPORTED_TICKET_MESSAGE_ATTACHMENT_TYPE` y no se guarda nada en el storage

#### Scenario: Adjunto demasiado grande
- **WHEN** un archivo individual excede el tope de su categoría, o el batch combinado excede
  `MAX_TOTAL_BATCH_BYTES`
- **THEN** 413 y no se guarda nada en el storage (ni el archivo que excedió, ni los que venían
  antes en el mismo batch — todo o nada)

#### Scenario: Cupo de adjuntos superado
- **WHEN** el mensaje trae más de `MAX_ATTACHMENTS_PER_MESSAGE` (5) archivos
- **THEN** 422 (validación de negocio) o 400 (si multer corta primero por su propio límite de
  campo) — ver tabla arriba; en ningún caso se guarda nada

#### Scenario: Adjunto de un reclamo ajeno
- **WHEN** alguien pide la URL de un adjunto de otro cliente
- **THEN** no la obtiene (la pertenencia se valida al emitir la URL, no al guardarla)

### Requirement: No leídos por lado
El sistema DEBE (MUST) permitir saber cuántos mensajes públicos no leyó cada lado, para el badge
de la app y el indicador del ticket en Prominense.

#### Scenario: Respuesta nueva sin leer
- **WHEN** el operador responde y el cliente todavía no abrió el reclamo
- **THEN** la app muestra el reclamo con 1 no leído; al abrirlo, el contador se limpia
