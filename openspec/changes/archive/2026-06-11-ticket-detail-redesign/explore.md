# Exploration: ticket-detail-redesign (#44)

## Current State

### TicketDetailPage (FE)
`src/pages/tickets/TicketDetailPage.tsx` — página de 249 líneas. Layout: `TicketHeader` sticky + grid 8fr/4fr.
- **Columna main**: sección "Conversación" (lista de `replies`) + form "Responder" (textarea simple, sin adjuntos).
- **Sidebar**: card con detalles (cliente, reporter, asignado, prioridad, fechas). El "asignado" es un `<select>` crudo inline.
- **PROBLEMA CRÍTICO**: `description` del ticket **nunca se renderiza** en la página. Solo se usa como valor inicial en `CreateTaskModal`. El operador abre el ticket y no ve el cuerpo del problema.
- **Replies = efímeras**: `ticketRepliesStore` in-memory en `tickets.routes.ts:66-85`. Toda conversación se pierde al reiniciar el container. AD-6 del diseño original.
- **No hay TicketComment en DB**: el schema Prisma no tiene modelo `TicketComment`. Solo existe `TaskComment`/`TaskCommentAttachment` para tareas.
- **Sin adjuntos**: el formulario de respuesta es textarea plano, sin soporte de archivos ni paste.
- **Sin tabs**: todo inline, una sola vista sin estructura.

### TicketHeader (FE)
`src/pages/tickets/TicketDetailPage/components/TicketHeader.tsx` — sticky header con breadcrumb, título inline-editable, `<select>` de status, kebab (cerrar / crear tarea / eliminar). CSS con variables idénticas al hermano mayor (`--color-primary`, `#0F172A`, `#64748B`, `#E2E8F0`).

### Hermano mayor: SchedulingTaskDetailPage (#41)
`src/pages/scheduling/SchedulingTaskDetailPage.tsx` — arquitectura moderna con:
- `TaskHeader` sticky (breadcrumb / título editable / StageSelect / PrioritySelect / kebab)
- `TaskTabs` con Tabs molecule: `detalles`, `comentarios`, `auditoria-ia`, `relacionado`, `inventory`, `registro-trabajo`, `actividad`
- `CustomerSidebar` sticky a la derecha
- `TaskCommentsTimeline` — componente completo con: avatares por iniciales + color hash, lightbox, adjuntos por URL, Composer (textarea + chip list + botón "📎 Adjuntar URL" + hint "Aún no soportamos subida de archivos")

### TaskCommentsTimeline — Precedente de adjuntos
`src/pages/scheduling/SchedulingTaskDetailPage/components/TaskCommentsTimeline.tsx` — **adjuntos por URL solamente**. La línea 313 dice: `"Los adjuntos se agregan por URL. Aún no soportamos subida de archivos."` — este es el patrón existente. **NO hay file upload real en ningún lugar del FE.**

### BE — Modelo Ticket
`prisma/schema.prisma` — `model Ticket` tiene: `id`, `sequenceNumber`, `subject`, `description`, `statusId → TicketStatusCatalog`, `priority`, `customerId`, `assigneeId`, `grCasoId`, `tasks ScheduledTask[]`. **Sin `TicketComment` ni `TicketReply` en DB.**

### BE — TaskComment (precedente para TicketComment)
Commit `536707dc` — `TaskComment` + `TaskCommentAttachment` en schema:
- `TaskComment`: id, taskId, authorName, body, createdAt, `attachments TaskCommentAttachment[]`
- `TaskCommentAttachment`: id, commentId, url, filename, mimeType?, sizeBytes?
- Ruta: `POST /api/scheduling/:taskId/comments` con `{ body, authorName, attachments: [{url, filename, mimeType?, sizeBytes?}] }`
- **Adjuntos son URLs** — no hay upload binario. El FE envía la URL ya resuelta.

### BE — ¿Existe storage de archivos?
**NO hay storage.** Verificado:
- `package.json`: sin `multer`, `sharp`, `aws-sdk`, `s3`, `minio`, ni nada relacionado con file upload.
- `app.ts`: sin `express.static` ni `uploads/` servidos.
- `deploy.yml`: **`docker run` sin ningún flag `-v` / `--mount`** → el filesystem del container es efímero. Cada deploy recrea el container desde cero. Cualquier archivo guardado en disco se pierde.

### BE — Permisos de tickets
`src/domain/entities/rbac.ts` — módulo `tickets` con sub-acciones `close` y `reopen`. FE usa `tickets.read`, `tickets.write`, `tickets.close`, `tickets.reopen`, `tickets.delete` (verificado en `TicketHeader.tsx:80-85`).

### BE — Permisos de comentarios de tarea
`taskComments.routes.ts` — usa `scheduling.read`, `scheduling.write`, `scheduling.delete`.

---

## Affected Areas

### FE
- `src/pages/tickets/TicketDetailPage.tsx` — refactor completo: agregar tabs, descripción, mover sidebar, integrar TicketCommentsTimeline
- `src/pages/tickets/TicketDetailPage.module.css` — rewrite de estilos (gran parte obsoleta post-tabs)
- `src/pages/tickets/TicketDetailPage/components/TicketHeader.tsx` — agregar sequenceNumber `#N` al breadcrumb (field existe, no se usa)
- `src/pages/tickets/TicketDetailPage/components/TicketHeader.module.css` — pequeños ajustes
- `src/hooks/useTickets.ts` — nuevas mutations: `useAddTicketComment`, `useDeleteTicketComment`; eliminar `useAddTicketReply` (in-memory)
- `src/types/ticket.ts` — agregar `TicketComment`, `TicketCommentAttachment`, eliminar `TicketReply`

### BE
- `prisma/schema.prisma` — nuevo `model TicketComment` + `TicketCommentAttachment` (espejo de TaskComment)
- `prisma/migrations/` — nueva migration
- `src/domain/entities/ticketComment.ts` — nueva entidad
- `src/domain/ports/TicketCommentRepository.ts` — nuevo port
- `src/application/use-cases/AddTicketComment.ts`, `DeleteTicketComment.ts`, `ListTicketComments.ts`
- `src/infrastructure/adapters/prisma/PrismaTicketCommentRepository.ts`
- `src/infrastructure/adapters/in-memory/InMemoryTicketCommentRepository.ts`
- `src/infrastructure/http/routes/ticketComments.routes.ts`
- `src/infrastructure/http/routes/tickets.routes.ts` — eliminar `ticketRepliesStore` (in-memory)
- `src/__tests__/application/TicketComments.test.ts`
- `src/__tests__/infrastructure/ticketComments.routes.test.ts`

---

## DECISIÓN CRÍTICA: Storage para imágenes pegadas/subidas

### El problema
El usuario quiere **pegar imágenes del clipboard** y **subir fotos** en comentarios de tickets.
Para mostrar la imagen en el FE se necesita una URL permanente.

### Análisis del deploy (EVIDENCIA)
`deploy.yml` → el `docker run` en el paso "Deploy container" **no tiene ningún `-v` ni `--mount`**. El container es efímero: cada deploy hace `docker rm -f` y levanta uno nuevo. **Cualquier archivo en `/uploads` o similar se pierde en cada deploy.**

### Opciones

| Opción | Pros | Contras | Esfuerzo |
|--------|------|---------|----------|
| **A. Base64 en DB** (texto en `TicketCommentAttachment.url`) | Cero infra nueva, no hay pérdida en deploy, transaccional | Max ~2MB por imagen razonable, hincha la DB, lento para muchas fotos | Bajo |
| **B. Volumen Docker nuevo** (agregar `-v prominense-uploads:/app/uploads` al deploy.yml + `express.static`) | Archivos reales, URLs limpias | Requiere tocar deploy.yml + verificar que el host tenga el volumen configurado; si el deploy falla queda inconsistente | Medio |
| **C. Servicio externo** (Cloudinary free tier, R2, S3) | Escalable, URLs públicas permanentes | Dependencia externa, config de secrets nuevos, credenciales | Alto |

### Recomendación: **Opción A (Base64 en DB) para la primera iteración**

**Evidencia directa**: No hay volumen montado. No hay storage service. El campo `url` en `TaskCommentAttachment` ya es `String` — se puede usar para base64 data URI (`data:image/png;base64,...`).

**Límites razonables**: imágenes de clipboard típicamente son screenshots de 100–500KB. Con base64 eso es ~130–670KB por imagen. Límite sugerido: **2MB por archivo, máximo 3 archivos por comentario**.

**Alternativa futura**: cuando el volumen se agregue al deploy (trivial — una línea en deploy.yml + `express.static`), se migra `url` a path real sin cambiar el schema — las URLs base64 existentes siguen funcionando como fallback.

**Para el paste de clipboard**: el FE lee `ClipboardEvent.clipboardData.files[0]`, convierte a base64 con `FileReader`, y lo envía como attachment con `url: "data:image/jpeg;base64,..."`.

**Para upload de archivo**: `<input type="file" accept="image/*">` → FileReader → mismo flujo base64.

---

## Approaches

### Approach 1: Tabs + TicketComments persistidos (recomendado)

Rediseñar `TicketDetailPage` al estilo del hermano mayor (SchedulingTaskDetailPage):
- **Header sticky**: igual que hoy pero con `#sequenceNumber` en breadcrumb
- **Tabs** (Tabs molecule existente): `Descripción`, `Conversación`, `Relacionado` (tasks creadas desde el ticket)
- **Sidebar sticky**: mejorada — cliente con link, asignado con select, prioridad con badge de color, estado con badge, fechas relativas
- **BE**: migrar replies in-memory → `TicketComment` + `TicketCommentAttachment` en DB (espejo exacto de TaskComment)
- **Paste/Upload**: base64 data URI en `TicketCommentAttachment.url`
- Pros: consistente con el design system establecido, persistencia real, reutiliza TaskCommentsTimeline pattern
- Contras: BE work (migration + 3 use cases + adapters)
- Esfuerzo: **Medio** (2-3 días)

### Approach 2: Solo FE, mantener replies in-memory + extensión ad-hoc

Rediseñar solo el FE, sin tocar el BE. Agregar tabs/descripción/mejorar sidebar. Para imágenes: guardar base64 en reply "message" (hack).
- Pros: FE-only, más rápido
- Contras: data se pierde en cada restart, hack fragante, deuda técnica
- Esfuerzo: **Bajo** (1 día)

### Approach 3: Volumen Docker + file upload real

Agregar `-v prominense-uploads:/app/uploads` al deploy.yml, servir con express.static, subir archivos reales.
- Pros: URLs limpias, no hincha la DB
- Contras: requiere coordinar deploy.yml + infra del host, más complejo para implementar
- Esfuerzo: **Alto** (involucra infra + multer + serving)

---

## Recommendation

**Approach 1** — BE migration + FE redesign con el patrón del hermano mayor.

**Razón**: Los replies in-memory son una deuda documentada (AD-6 en el código). El rediseño impeccable es la oportunidad perfecta para saldarla. El esfuerzo extra del BE es bajo porque ya existe el patrón `TaskComment`/`TaskCommentAttachment` para copiar casi verbatim. El storage base64 evita tocar infra.

**Layout propuesto** (inspirado en SchedulingTaskDetailPage):
```
[TicketHeader sticky — #N · Asunto · StatusSelect · kebab]
[grid 8fr / 4fr]
  main:
    [Tabs: Descripción | Conversación | Relacionado]
      tab Descripción: renderizar ticket.description (plain text → whitespace-pre-wrap)
      tab Conversación: TicketCommentsTimeline (nuevo componente, fork de TaskCommentsTimeline)
        + paste image desde clipboard
        + file input image/*
      tab Relacionado: lista de tasks creadas desde este ticket (ticket.tasks)
  sidebar (sticky):
    badge Status con color (como TaskHeader priority badge)
    badge Priority con color
    Cliente → Link
    Asignado → Select
    Creado / Actualizado (relativos: "hace 3 días")
    Reporter
```

---

## Risks

- **Deuda de replies**: reemplazar `ticketRepliesStore` in-memory por `TicketComment` es breaking — los replies existentes (en producción) se pierden. Mitigación: no hay replies persistidos (in-memory se resetea en cada deploy), así que la pérdida es cero.
- **Base64 en DB**: fotos grandes hinchan la DB. Mitigación: validar tamaño en FE (≤2MB) antes de enviar.
- **`ticket.id` es UUID string en BE pero `number` en `src/types/ticket.ts`**: type lie pre-existente (misma situación que contracts #42 encontró). Los hooks ya funcionan con string; el type debería corregirse en paralelo.
- **`description` no renderizada hoy**: al agregar la tab Descripción podría sorprender si hay tickets con description vacía. Mitigación: mostrar placeholder "Sin descripción".

---

## Ready for Proposal

Yes — exploración completa. El cambio tiene dos capas:
1. **BE**: `TicketComment` + `TicketCommentAttachment` (migration + 3 use-cases + 2 adapters + route)
2. **FE**: rediseño impeccable de `TicketDetailPage` con tabs + sidebar mejorada + `TicketCommentsTimeline` con paste/upload de imágenes (base64)

Storage decision: base64 en DB, límite 2MB/imagen, 3 imágenes/comentario.
