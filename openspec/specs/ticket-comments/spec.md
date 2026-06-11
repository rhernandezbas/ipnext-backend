# Ticket Comments Specification

## Purpose

Conversación persistida de un ticket con adjuntos de imagen inline (base64 data-URI). Espejo del patrón `TaskComment`/`TaskCommentAttachment` (commit `536707dc`).

---

## Requirements

### Requirement: Data Model — TicketComment + TicketCommentAttachment

(amended per design D1)

El sistema DEBE persistir comentarios de tickets en DB con la siguiente forma (espejo EXACTO de `TaskComment`/`TaskCommentAttachment`, `schema.prisma:1332-1343`):

```
TicketComment      { id: UUID, ticketId FK→Ticket cascade, authorName: String, body: String, createdAt: DateTime }
TicketCommentAttachment { id: UUID, commentId FK→TicketComment cascade, url: String, filename: String, mimeType: String?, sizeBytes: Int? }
```

**SIN `authorId` FK** — el nombre del autor se graba como string denormalizado al momento de escribir (resuelto en el FE desde `displayName→username→email`, con fallback BE `req.user.username`). No existe FK a `RbacUser` ni `onDelete: SetNull`. La migración DEBE ser aditiva (sin `BEGIN`/`COMMIT` manuales).

#### Scenario: Migración aditiva no rompe datos existentes

- GIVEN la base de datos en producción sin `TicketComment`
- WHEN se aplica la migración
- THEN las tablas `TicketComment` y `TicketCommentAttachment` existen
- AND el resto del schema permanece intacto

#### Scenario: Autor borrado — nombre persiste sin fallback dinámico (amended per design D1)

- GIVEN un comentario creado con `authorName: "Juan Pérez"`
- WHEN ese usuario es eliminado de la DB
- THEN el comentario persiste con `authorName: "Juan Pérez"` inalterado
- AND NO existe `authorId` que pueda quedar null ni lógica de fallback dinámica

---

### Requirement: GET /api/tickets/:id/comments

El sistema DEBE exponer `GET /api/tickets/:id/comments` con permiso `tickets.read`. Devuelve comentarios en orden `createdAt ASC` con `attachments` embebidos.

**Wire contract — response item (amended per design D1):**
```json
{
  "id": "uuid",
  "ticketId": "uuid",
  "authorName": "string",
  "body": "string",
  "attachments": [
    { "id": "uuid", "commentId": "uuid", "url": "data:image/png;base64,...", "filename": "string", "mimeType": "string", "sizeBytes": 123456 }
  ],
  "createdAt": "ISO8601"
}
```

Sin campo `authorId`. El `authorName` es el valor tal como fue guardado al crear el comentario; no existe lógica de fallback ni join a `RbacUser`.

#### Scenario: Lista vacía para ticket sin comentarios

- GIVEN un ticket existente sin comentarios
- WHEN `GET /api/tickets/:id/comments` con `tickets.read`
- THEN respuesta `200` con array vacío `[]`

#### Scenario: Lista con comentarios en orden cronológico

- GIVEN un ticket con 3 comentarios creados en momentos distintos
- WHEN `GET /api/tickets/:id/comments`
- THEN los 3 comentarios aparecen en orden `createdAt ASC`
- AND cada item incluye `attachments` embebidos

#### Scenario: 404 para ticket inexistente

- GIVEN un ticketId que no existe en DB
- WHEN `GET /api/tickets/:id/comments`
- THEN respuesta `404 NOT_FOUND`

---

### Requirement: POST /api/tickets/:id/comments

(amended per design D1/D2/D3)

El sistema DEBE exponer `POST /api/tickets/:id/comments` con permiso `tickets.write`.

**Parser 8mb path-scoped**: `app.use('/api/tickets/:ticketId/comments', express.json({ limit: '8mb' }))` DEBE registrarse en `app.ts` INMEDIATAMENTE ANTES de `app.use(express.json())` (parser global 100kb). NO dentro del router — el parser global corre antes que todos los routers y rechazaría con 413 bodies >100kb antes de que el router reciba el request. El orden correcto es scoped-first, global-second. Un test de composición estático DEBE verificar `indexOf('8mb') < indexOf('app.use(express.json())')` sobre el source de `app.ts`.

El errorHandler DEBE manejar `entity.too.large` (tipo del error que lanza body-parser cuando supera el límite) con `413 PAYLOAD_TOO_LARGE`, antes del check de `DomainError`. Sin esta rama, el error caería al handler genérico y devolvería `500`.

**Wire contract — request body:**
```json
{
  "body": "string (opcional si hay attachments)",
  "authorName": "string (opcional; FE manda displayName→username→email; BE fallback req.user.username)",
  "attachments": [
    { "url": "data:image/...;base64,...", "filename": "string", "mimeType": "image/...", "sizeBytes": 123456 }
  ]
}
```

Validación Zod (servidor):
- `body` o `attachments` requerido (al menos uno; comentario solo-imagen válido)
- `attachments`: máx 3 items
- `mimeType`: DEBE coincidir con whitelist `image/*`
- `sizeBytes`: DEBE ser ≤ 2 097 152 (2MB) Y consistente con el tamaño real del data-URI
- `url`: DEBE ser data-URI válido con prefijo `data:image/`

**Wire contract — response:** el comentario creado con shape idéntico al GET.

#### Scenario: Comentario solo texto

- GIVEN ticket existente, usuario con `tickets.write`
- WHEN POST con `{ body: "Revisado", attachments: [] }`
- THEN `201` con comentario creado; `attachments: []`
- AND el campo `authorName` en la respuesta refleja el nombre resuelto (amended per design D1)

#### Scenario: Comentario solo imagen (sin body)

- GIVEN ticket existente, usuario con `tickets.write`
- WHEN POST con `{ attachments: [{ url: "data:image/png;base64,...", filename: "screen.png", mimeType: "image/png", sizeBytes: 102400 }] }`
- THEN `201` con comentario creado; `body: ""`

#### Scenario: Comentario con texto e imagen

- GIVEN ticket existente, usuario con `tickets.write`
- WHEN POST con body y 1 attachment válido
- THEN `201`; comentario tiene body y 1 adjunto embebido

#### Scenario: Rechazo — 4 adjuntos

- GIVEN usuario con `tickets.write`
- WHEN POST con 4 attachments
- THEN `422 VALIDATION_ERROR`

#### Scenario: Rechazo — mimeType no-imagen

- GIVEN usuario con `tickets.write`
- WHEN POST con attachment `mimeType: "application/pdf"`
- THEN `422 VALIDATION_ERROR`

#### Scenario: Rechazo — imagen >2MB

- GIVEN usuario con `tickets.write`
- WHEN POST con attachment de `sizeBytes: 3145728`
- THEN `422 VALIDATION_ERROR` (client-side validará antes de enviar; servidor rechaza igual)

#### Scenario: Rechazo — data-URI malformado

- GIVEN usuario con `tickets.write`
- WHEN POST con `url: "notadatauri"`
- THEN `422 VALIDATION_ERROR`

#### Scenario: 404 para ticket inexistente

- GIVEN ticketId inexistente
- WHEN POST con body válido
- THEN `404 NOT_FOUND`

#### Scenario: Body parser scoped — POST grande no rompe otras rutas (amended per design D3)

- GIVEN `app.use('/api/tickets/:ticketId/comments', express.json({ limit: '8mb' }))` registrado ANTES de `app.use(express.json())` en `app.ts`
- WHEN POST a `/api/tickets` (otra ruta) con body >100kb
- THEN esa ruta responde `413`; el endpoint de comments acepta hasta 8mb
- AND un assertion estático de composición verifica que el índice del parser scoped `'8mb'` es menor al índice del parser global en el source de `app.ts`

#### Scenario: Body JSON > 8mb → 413 limpio (amended per design D3)

- GIVEN el parser path-scoped con `limit: '8mb'` y la rama `entity.too.large` en el errorHandler
- WHEN POST a `/api/tickets/:id/comments` con body JSON > 8mb
- THEN respuesta `413` con `{ error: "Payload too large", code: "PAYLOAD_TOO_LARGE" }`
- AND NO responde `500` (la rama errorHandler captura el error antes del handler genérico)

---

### Requirement: GET /api/tickets/:id enriquecido con tasks[] (amended per design D7)

El sistema DEBE enriquecer la respuesta de `GET /api/tickets/:id` (endpoint existente) con el campo `tasks[]` (relación ya presente en el schema Prisma `Ticket.tasks ScheduledTask[]`). No existe filtro `?ticketId` en `ListTasks`/`SchedulingRepository` (verificado) — la única vía correcta es el include aditivo en `PrismaTicketRepository.getById`.

**Campo adicional en la respuesta:**
```json
{
  "tasks": [
    { "id": "uuid", "sequenceNumber": 1, "title": "Revisión de señal" }
  ]
}
```

El campo DEBE ser opcional (`tasks?: RelatedTask[]`) en la entidad de dominio para no romper fixtures ni tests existentes.

#### Scenario: Ticket sin tasks vinculadas

- GIVEN ticket que no tiene `ScheduledTask`s relacionadas
- WHEN `GET /api/tickets/:id`
- THEN la respuesta incluye `tasks: []`

#### Scenario: Ticket con tasks vinculadas

- GIVEN ticket con 2 `ScheduledTask`s que referencian ese `ticketId`
- WHEN `GET /api/tickets/:id`
- THEN la respuesta incluye `tasks` con los 2 items: `id`, `sequenceNumber`, `title`
- AND los datos de tasks se obtienen del include Prisma, sin consulta separada

---

### Requirement: Ruta /replies eliminada

El sistema MUST NOT exponer `/api/tickets/:id/replies`. El `ticketRepliesStore` in-memory DEBE eliminarse del código.

#### Scenario: Ruta /replies devuelve 404

- GIVEN cualquier método HTTP sobre `/api/tickets/:id/replies`
- WHEN la solicitud llega al servidor
- THEN respuesta `404` (ruta no registrada)

---

### Requirement: Permisos y autenticación

`GET` requiere `tickets.read`. `POST` requiere `tickets.write`. Sin permiso → `403 FORBIDDEN`.

#### Scenario: Sin tickets.read no puede listar

- GIVEN usuario sin `tickets.read`
- WHEN `GET /api/tickets/:id/comments`
- THEN `403`

#### Scenario: Sin tickets.write no puede comentar

- GIVEN usuario sin `tickets.write`
- WHEN `POST /api/tickets/:id/comments`
- THEN `403`
