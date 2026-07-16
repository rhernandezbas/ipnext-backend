# Proposal — internal-news (Noticias internas: tablón del equipo)

## 1. Why / Intent

Hoy el sidebar tiene un ítem top-level "Notificaciones" (`/admin/notifications`) que duplica
funcionalmente a la campanita del header: misma data (GET `/api/notifications`, tabla `Notification`
GLOBAL, sin `userId`), mismos hooks (`useNotifications.ts`). Dos entradas para lo mismo, y ninguna
resuelve la necesidad real del equipo: **un tablón interno donde las áreas publican novedades y
cambios con documentación** ("toqué el router X, hice el cambio Y — acá el detalle") para que TODO
el equipo las tenga presentes.

**internal-news** convierte ese slot del sidebar en **"Noticias"**: un tablón con categorías
(catálogo propio editable), posts pinneables, tracking de lectura por usuario (badge de no-leídas
en el sidebar + destacado hasta abrir), creación desde un modal, y permisos granulares
(`news.read` / `news.manage`) con guards en AMBAS capas.

Las notificaciones PERSONALES (campanita del header) **siguen intactas** — ver design §1: la page
y la campanita comparten hooks pero son componentes independientes, y la ruta
`/admin/notifications` sobrevive porque el footer de la campanita navega ahí.

## 2. Decisiones LOCKED (AskUserQuestion 2026-07-16 — no se reabren)

- **(a)** Reemplaza la page "Notificaciones" del SIDEBAR → ítem "Noticias". La campanita del header
  no se toca. La ruta vieja `/admin/notifications` se CONSERVA (target del footer de la campanita).
- **(b)** Categorías = catálogo PROPIO editable (calco del patrón `TicketAreaCatalog`). Seed
  idempotente: Red/Infraestructura, Campañas, Comercial, General.
- **(c)** Tracking de lectura por usuario: badge de no-leídas en el ítem del sidebar + noticia
  destacada hasta abrirla (marcar leída al abrir el detalle). Tabla `NewsReadReceipt` liviana.
- **(d)** Permisos: `news.read` (seed a los 6 roles de sistema) + `news.manage` (crear/editar/
  archivar/categorías: `administrador` + `super_admin`). Guards en BE (auth + requirePerm) y FE
  (RequirePermission + Can + sidebar gating).

## 3. Scope IN

1. **BE** — modelos Prisma ADITIVOS (`NewsPost`, `NewsCategory`, `NewsReadReceipt`), migración con
   `prisma migrate diff` + seed idempotente (categorías + módulo/permisos/grants RBAC, todo
   `ON CONFLICT DO NOTHING`), ports + use cases + adapters Prisma/in-memory, DTOs curados,
   `news.routes.ts` con guards granulares, wiring en `app.ts` + composition-root pin (anti-W6),
   endpoint barato `GET /api/news/unread-count` para el badge.
2. **FE** (spec/diseño acá; el apply FE es un change coordinado POSTERIOR — ver §5) — swap del
   ítem sidebar Notificaciones→Noticias con badge, page tablón (cards, categorías con color,
   pinned arriba, no-leídas destacadas, detalle drawer, filtros, 4 ramas de estado), modal de
   creación con doble validación, sub-page de categorías (calco `TicketAreasBody`).
3. **Testing (Strict TDD)** — matriz completa: unit de use cases con in-memory, rutas con
   supertest (401/403 incluidos), composition-root pin, y escenarios FE clave (badge, marcar
   leída, gates de permiso, regresión de la campanita).

## 4. Scope OUT (explícito — anti scope-creep)

- **Markdown/adjuntos en el body** — v1 es texto plano multiline (design §3). El upgrade a
  markdown liviano es aditivo y no destruye datos.
- **Notificaciones push/email de noticias nuevas** — el badge + destacado ES el mecanismo v1.
- **Tocar la campanita o la tabla `Notification`** — cero cambios en `Navbar.tsx`,
  `notifications.routes.ts`, `NotificationsPage.tsx` o sus hooks.
- **Comentarios/reacciones en posts** — futuro.
- **Paginación del tablón** — v1 lista completa ordenada (volumen interno bajo); `limit/offset`
  se agrega aditivo si crece.
- **Migrar el stub legacy `/admin/support/news`** — lo elimina el change `sidebar-comunicaciones`
  (Change B); acá no se toca.

## 5. Dependencia dura con Change B (`sidebar-comunicaciones`)

El apply FE de este change corre DESPUÉS de mergear `feat/sidebar-comunicaciones` a main:

1. **Conflicto físico**: ambos editan `Sidebar.tsx` (B borra el grupo "Mensajes" y renombra
   WhatsApp→Comunicaciones; este change reemplaza el link de navTop).
2. **Liberación de nombres**: B ELIMINA el stub Splynx-replica de noticias
   (`pages/support/NewsPage.tsx`, `hooks/useNews.ts`, `api/news.api.ts`, `types/news.ts` — data
   mock hardcodeada, sin BE). Este change REUTILIZA esos nombres de archivo con contenido real.
   Aplicar antes del merge = colisión de nombres + dos ítems "Noticias" simultáneos en el sidebar.

El **BE no depende de nada**: es aditivo y dark (sin FE que lo consuma, `/api/news` no afecta
ningún flujo existente). BE-first, FE después del merge de B.

## 6. Enfoque

BE-first en `feat/internal-news` (este worktree), todo aditivo: tablas nuevas, módulo RBAC nuevo,
router nuevo. Riesgo bajo — ningún camino existente se toca. El FE llega en un apply coordinado
posterior con la UX del tablón (estética la resuelve el apply con ui-ux-pro-max + motion; esta
spec fija estructura/comportamiento/a11y).
