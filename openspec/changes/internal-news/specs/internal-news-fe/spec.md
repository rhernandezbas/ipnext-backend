# Spec — internal-news FE (delta)

RFC-2119. Repo: `ipnext-frontend`. **PRECONDICIÓN de apply: `feat/sidebar-comunicaciones`
(Change B) mergeado a main** — B borra el stub legacy (`pages/support/NewsPage.tsx`,
`hooks/useNews.ts`, `api/news.api.ts`, `types/news.ts`, grupo "Mensajes" del sidebar) y este
change reutiliza esos nombres. Ambos editan `Sidebar.tsx`.

**Decisiones LOCKED:**
- El ítem navTop "Notificaciones" del sidebar se REEMPLAZA por "Noticias" → `/admin/news`.
- La ruta `/admin/notifications` + `NotificationsPage` + campanita (`Navbar.tsx`) quedan
  INTACTAS (el footer de la campanita navega a esa ruta — `Navbar.tsx:265`).
- La estética fina del tablón la resuelve el apply (ui-ux-pro-max + motion); esta spec fija
  estructura, comportamiento y a11y.

---

## Capability: sidebar (swap + badge)

### Requirement: NEWS-FE-SB-1 — ítem Noticias gated con badge de no-leídas
El sidebar MUST renderizar en `navTop` un link "Noticias" → `/admin/news` visible solo con
`news.read` (mientras los permisos cargan MUST mostrarse — convención sin layout shift). MUST NO
renderizar más el link "Notificaciones". El link MUST mostrar un badge con el unread count cuando
`count > 0` (cap visual `99+`, `aria-label` con el número real), y MUST ocultarlo cuando es 0.

#### Scenario: swap del ítem
- Given un usuario con `news.read`
- When se renderiza el sidebar
- Then existe el link "Noticias" a `/admin/news` y NO existe ningún link "Notificaciones"

#### Scenario: gate de permiso
- Given un usuario SIN `news.read` (permisos ya cargados)
- When se renderiza el sidebar
- Then el link "Noticias" no se renderiza

#### Scenario: badge con corte 99+
- Given `unread-count` = 3 (y luego 120)
- When se renderiza el sidebar
- Then el badge muestra "3" (y "99+"), con `aria-label` accesible; con count 0 no hay badge

### Requirement: NEWS-FE-SB-2 — polling barato del contador
`useNewsUnreadCount` MUST consultar `GET /api/news/unread-count` con
`refetchInterval: visible ? 60_000 : false` (gateado por `useDocumentVisible`) y MUST invalidarse
al marcar una noticia como leída (el badge baja sin esperar el próximo tick).

#### Scenario: pausa con pestaña oculta
- Given la pestaña oculta
- When se evalúa el intervalo de la query
- Then es `false` (no se programa refetch)

#### Scenario: badge baja al leer
- Given badge en 2
- When el usuario abre el detalle de una no-leída (mark-read exitoso)
- Then la query del contador se invalida y el badge pasa a 1

---

## Capability: rutas

### Requirement: NEWS-FE-RT-1 — rutas nuevas gateadas, ruta vieja viva
`/admin/news` MUST montarse con `RequirePermission news.read` y `/admin/news/settings` con
`RequirePermission news.manage`. `/admin/notifications` MUST seguir montada exactamente como hoy
(`RequirePermission notifications.read` → `NotificationsPage`).

#### Scenario: gates de rutas nuevas
- Given un usuario sin `news.read` (o sin `news.manage`)
- When navega a `/admin/news` (o `/admin/news/settings`)
- Then ve la pantalla de sin-permiso, no la page

#### Scenario: campanita → page vieja
- Given cualquier usuario con `notifications.read`
- When clickea "Ver todas las notificaciones" en el dropdown de la campanita
- Then aterriza en `/admin/notifications` y la page renderiza como hoy

### Requirement: NEWS-FE-RT-2 — campanita intocada (regresión)
El change MUST NO modificar `Navbar.tsx`, `useNotifications.ts`, `notifications.api.ts` ni
`NotificationsPage.tsx`. Los tests existentes de Navbar/notifications MUST seguir verdes sin
ediciones.

#### Scenario: suite de regresión
- Given la suite FE post-apply
- When corren los tests existentes de layout/Navbar y notifications
- Then pasan sin haber sido modificados

---

## Capability: tablón (NewsBoardPage)

### Requirement: NEWS-FE-BD-1 — cuatro ramas de estado
La page MUST cubrir loading (skeleton), error (mensaje + retry), empty (estado vacío con CTA
"Nueva noticia" solo si `news.manage`) y data.

#### Scenario: cada rama renderiza
- Given la query en cada uno de los 4 estados
- When se renderiza la page
- Then muestra skeleton / error con retry / empty / cards respectivamente

### Requirement: NEWS-FE-BD-2 — cards: orden, destacado y metadata
El tablón MUST renderizar las noticias con pinned SIEMPRE arriba (indicador visual de pin),
no-leídas destacadas visualmente (acento + dot con `aria-label`), pill de categoría con el color
del catálogo, autor y fecha relativa, título y body recortado.

#### Scenario: pinned arriba y no-leída destacada
- Given una noticia pinned leída y una no-pinned sin leer más nueva
- When se renderiza el tablón
- Then la pinned aparece primero y la no-leída lleva el destacado de sin-leer

### Requirement: NEWS-FE-BD-3 — detalle marca leída (una sola vez)
Al abrir el detalle (drawer/expandible, keyed por `post.id`) de una noticia NO leída, la page
MUST disparar `POST /api/news/:id/read` UNA vez e invalidar `['news']` +
`['news','unread-count']`. Abrir una ya leída MUST NO disparar la mutación. El body MUST
renderizarse como texto plano multiline (`pre-wrap`), sin interpretar HTML.

#### Scenario: mark al abrir no-leída
- Given una noticia sin leer
- When se abre su detalle
- Then la mutación se llama exactamente 1 vez y el destacado desaparece tras la invalidación

#### Scenario: abrir leída no re-marca
- Given una noticia ya leída
- When se abre su detalle
- Then la mutación NO se llama

### Requirement: NEWS-FE-BD-4 — filtros
La page MUST ofrecer chips de categoría (con color, fuente `GET /api/news/categories`), toggle
"Solo no leídas" y toggle "Archivadas" visible SOLO con `news.manage` (dispara `?archived=true`).

#### Scenario: filtro por categoría
- Given noticias en 2 categorías
- When se selecciona un chip
- Then solo se muestran las de esa categoría (server-side param)

#### Scenario: archivadas gated
- Given un usuario con solo `news.read`
- When se renderiza la page
- Then el toggle "Archivadas" no existe

### Requirement: NEWS-FE-BD-5 — creación/edición con doble validación
El modal (crear/editar, `Can news.manage`) MUST tener título, categoría (Select PROPIO —
`components/molecules/Select`), body textarea y pinned checkbox. Submit MUST estar deshabilitado
hasta que título/body/categoría sean válidos (validación FE) y los errores BE (400/409/422) MUST
mapearse a mensajes visibles. A11y: `role="dialog"`, `aria-labelledby`, focus inicial en el
título, cierre por Esc y overlay-click.

#### Scenario: doble validación
- Given el modal abierto con título vacío
- When se intenta guardar
- Then el submit está deshabilitado; y si el BE devolviera 400, el error se muestra en el modal

#### Scenario: crear feliz
- Given campos válidos
- When se guarda
- Then POST `/api/news`, el modal cierra y las queries `['news']` se invalidan

---

## Capability: categorías (NewsSettingsPage)

### Requirement: NEWS-FE-CAT-1 — CRUD calco TicketAreasBody
La sub-page (`/admin/news/settings`, `news.manage`) MUST listar categorías con swatch de color y
nombre, permitir crear/editar vía modal (input color nativo) y borrar con confirmación
(`useConfirm`). Un 409 `NEWS_CATEGORY_NAME_CONFLICT` MUST mostrar "Ya existe una categoría con
ese nombre"; un 409 `NEWS_CATEGORY_IN_USE` MUST mostrar que la categoría tiene noticias asociadas
y no puede borrarse.

#### Scenario: borrar en uso
- Given una categoría con noticias
- When se confirma el borrado y el BE responde 409 `NEWS_CATEGORY_IN_USE`
- Then se muestra el mensaje de en-uso y la categoría sigue listada

#### Scenario: conflicto de nombre
- Given una categoría "Comercial" existente
- When se crea otra "Comercial"
- Then el modal muestra el error de nombre duplicado y no cierra
