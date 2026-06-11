# Ticket Detail UI Specification

## Purpose

Rediseño de `/admin/tickets/:id` al patrón del hermano mayor `SchedulingTaskDetailPage` (#41). Agrega tabs, description prominente, sidebar mejorada, y un composer con paste/upload de imágenes (base64). No existe spec previa de tickets UI.

---

## Requirements

### Requirement: Layout con Header sticky + Tabs + Sidebar

El sistema DEBE renderizar `TicketDetailPage` con:
- `TicketHeader` sticky: breadcrumb con `#sequenceNumber`, título, StatusSelect, kebab
- Grid `8fr / 4fr`: columna principal con `Tabs molecule`, sidebar sticky derecha
- Tabs: **Conversación** | **Datos** | **Relacionado** (naming espejo de `SchedulingTaskDetailPage`)

**Wire contract — ticket shape (FE types):**
```ts
interface Ticket {
  id: string          // FIX: era number; ahora string (UUID)
  sequenceNumber: number
  subject: string
  description: string
  statusId: string
  priority: string
  customerId: string
  assigneeId: string | null
  tasks: RelatedTask[]
  createdAt: string
  updatedAt: string
}
```

#### Scenario: Renderizado inicial con tabs

- GIVEN usuario navega a `/admin/tickets/:id`
- WHEN la página carga
- THEN el header sticky muestra `#sequenceNumber · subject`
- AND las 3 tabs están visibles: Conversación (activa por defecto), Datos, Relacionado

#### Scenario: Fix type — ticket.id como string

- GIVEN ticket con id UUID `"abc-123"`
- WHEN el FE lee `ticket.id`
- THEN el valor es `string`, no `number`
- AND los hooks y rutas funcionan sin conversión manual

---

### Requirement: Tab Datos — Description prominente

La tab **Datos** DEBE renderizar `ticket.description` de forma prominente. Si la description está vacía, DEBE mostrar un placeholder `"Sin descripción"`.

#### Scenario: Description con contenido

- GIVEN ticket con `description: "El cliente no tiene internet"`
- WHEN se activa la tab Datos
- THEN el texto se renderiza con `white-space: pre-wrap`

#### Scenario: Description vacía — placeholder

- GIVEN ticket con `description: ""` o `null`
- WHEN se activa la tab Datos
- THEN se muestra el placeholder `"Sin descripción"` en estilo muted

---

### Requirement: Tab Relacionado — Tasks vinculadas

La tab **Relacionado** DEBE listar las `ScheduledTask`s creadas desde el ticket (`ticket.tasks`).

#### Scenario: Sin tareas relacionadas

- GIVEN ticket sin tasks vinculadas
- WHEN se activa la tab Relacionado
- THEN copy accionable: `"No hay tareas vinculadas a este ticket"`

#### Scenario: Con tareas relacionadas

- GIVEN ticket con 2 tasks
- WHEN se activa la tab Relacionado
- THEN se listan ambas tasks con link a su detalle

---

### Requirement: TicketCommentsTimeline con paste/upload

El sistema DEBE incluir `TicketCommentsTimeline` (fork de `TaskCommentsTimeline`) en la tab **Conversación** con:
- Timeline de comentarios: avatar por iniciales + hash de color, `authorName`, `body`, thumbnails de imágenes, `createdAt` relativo
- Lightbox al hacer click en thumbnail (reusar componente de tareas si existe)
- Composer: textarea (body), previews de imágenes pendientes con botón "×" para quitar, botón "📎 Adjuntar imagen" (`<input type="file" accept="image/*" multiple>`), submit

**Paste de clipboard:** onPaste en el área del composer — si el clipboard contiene imágenes, DEBE agregarlas a la lista de previews. Si no contiene imágenes, ignorar silenciosamente.

#### Scenario: Paste de imagen desde clipboard

- GIVEN usuario tiene imagen en clipboard
- WHEN hace paste (Ctrl+V) en el área del composer
- THEN la imagen aparece como preview con botón "×"
- AND se puede enviar junto con o sin body

#### Scenario: Paste de texto/no-imagen desde clipboard

- GIVEN usuario tiene texto o PDF en clipboard
- WHEN hace paste en el área del composer
- THEN el evento es ignorado; no aparece preview ni error

#### Scenario: Upload de imagen vía input file

- GIVEN usuario hace click en "📎 Adjuntar imagen"
- WHEN selecciona archivos de imagen válidos
- THEN aparecen como previews; se pueden quitar antes de enviar

#### Scenario: Quitar imagen antes de enviar

- GIVEN 2 imágenes en previews
- WHEN usuario hace click en "×" de una
- THEN esa imagen se elimina del preview; la otra permanece

#### Scenario: Timeline muestra thumbnails con lightbox

- GIVEN comentario con 1 attachment
- WHEN se renderiza en el timeline
- THEN se muestra thumbnail
- AND al hacer click se abre lightbox con imagen completa

#### Scenario: isImageUrl debe matchear data-URIs (amended per design D8)

- GIVEN un attachment con `url: "data:image/png;base64,iVBOR..."` (data-URI, no URL de extensión)
- WHEN `TicketCommentsTimeline` evalúa si debe renderizar como imagen
- THEN `isImageUrl(url)` retorna `true`
- AND el thumbnail y el lightbox se muestran correctamente
- NOTE: el fork de `TaskCommentsTimeline` DEBE reemplazar la regex de extensión (`isImageUrl` línea 18 del original) por `url.startsWith('data:image/')` para cubrir data-URIs

---

### Requirement: Validación client-side de imágenes

El composer DEBE validar localmente antes de agregar al preview o al submit:

| Regla | Código de error UI |
|-------|--------------------|
| Tipo ≠ `image/*` | `"Solo se aceptan imágenes"` |
| Tamaño > 2MB | `"La imagen supera el límite de 2MB"` |
| > 3 imágenes en total | `"Máximo 3 imágenes por comentario"` |

La validación DEBE ocurrir al pegar, al seleccionar por file input, y antes del submit.

#### Scenario: Imagen inválida por tipo

- GIVEN usuario adjunta un PDF
- WHEN intenta agregarlo (paste o file input)
- THEN se muestra mensaje `"Solo se aceptan imágenes"`; no aparece preview

#### Scenario: Imagen >2MB rechazada client-side

- GIVEN usuario adjunta imagen de 3MB
- WHEN intenta agregarla
- THEN mensaje `"La imagen supera el límite de 2MB"`; no se agrega al preview

#### Scenario: 4ta imagen rechazada

- GIVEN el composer ya tiene 3 previews
- WHEN usuario intenta agregar una 4ta imagen
- THEN mensaje `"Máximo 3 imágenes por comentario"`; la 4ta no se agrega

#### Scenario: Submit deshabilitado sin body ni imágenes

- GIVEN composer con body vacío y sin imágenes
- WHEN el usuario no ha escrito nada
- THEN el botón submit está deshabilitado (`disabled`)

---

### Requirement: Permisos en el composer

Sin permiso `tickets.write`, el composer DEBE estar oculto o en modo read-only. El timeline SIEMPRE es visible con `tickets.read`.

#### Scenario: Usuario sin tickets.write

- GIVEN usuario autenticado sin `tickets.write`
- WHEN accede al detalle de un ticket
- THEN la tab Conversación muestra el timeline pero el composer está oculto

#### Scenario: Usuario con tickets.write

- GIVEN usuario con `tickets.write`
- WHEN accede al detalle de un ticket
- THEN el composer es visible y usable

---

### Requirement: Estados de carga y vacío

#### Scenario: Loading inicial

- GIVEN la página carga datos por primera vez
- WHEN la petición está en vuelo
- THEN se muestra skeleton o spinner; no se muestra contenido parcial

#### Scenario: Error de red

- GIVEN la petición de comentarios falla
- WHEN el error se resuelve
- THEN se muestra mensaje de error con botón "Reintentar"

#### Scenario: Sin comentarios — copy accionable

- GIVEN ticket sin comentarios y usuario con `tickets.write`
- WHEN se activa la tab Conversación
- THEN copy `"Sé el primero en comentar"` con foco visual en el composer
