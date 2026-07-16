# Design — internal-news

Toda cita `file:line` verificada contra el código real (worktree BE `feat/internal-news` sincronizado
con main `28c6d0a5`; FE `main` `eed027b0`; branch B `feat/sidebar-comunicaciones`).

## 1. Cómo funciona HOY Notificaciones (page + campanita) — y por qué el swap no rompe nada

### 1.1 Anatomía actual

| Pieza | Dónde | Qué hace |
|---|---|---|
| Modelo | `prisma/schema.prisma:335-345` | `Notification` **GLOBAL** — sin `userId`. `read` es un booleano único compartido por todos. |
| Router BE | `src/infrastructure/http/routes/notifications.routes.ts` | GET `/` (`?unread=true`), PUT `/read-all`, PUT `/:id/read`, DELETE `/:id`. **SIN auth middleware y SIN requirePerm** en el router. |
| Mount | `src/infrastructure/http/app.ts:1952` | `app.use('/api/notifications', ...)` — sin guards. |
| API FE | `src/api/notifications.api.ts` | 4 funciones sobre `/notifications`. |
| Hooks FE | `src/hooks/useNotifications.ts` | react-query, `staleTime: 30_000`, **sin polling**. |
| Campanita | `src/components/organisms/Navbar/Navbar.tsx:103-272` | Usa `useNotifications()` (:106), calcula `unreadCount` client-side (:110), footer "Ver todas las notificaciones" → `navigate('/admin/notifications')` (:265). |
| Page | `src/pages/notifications/NotificationsPage.tsx` | Mismos hooks + delete; `Can notifications.write` para mutaciones. |
| Ruta FE | `src/App.tsx:400` | `<Route path="notifications">` gated `RequirePermission notifications.read`. |
| Sidebar | `src/components/organisms/Sidebar/Sidebar.tsx:562-569` | NavLink "Notificaciones" en `navTop`, **sin gate de permiso**. |

### 1.2 Conclusión del análisis (decisión de reemplazo)

Page y campanita **comparten hooks/endpoints pero son componentes independientes**. El único
acople page↔campanita es el footer de la campanita que navega a `/admin/notifications`
(`Navbar.tsx:265`).

**Decisión**: se elimina SOLO el NavLink del sidebar (`Sidebar.tsx:562-569`) y se agrega
"Noticias" → `/admin/news`. La ruta `/admin/notifications` + `NotificationsPage` **quedan
intactas** (target del footer de la campanita — quien quiera la lista completa sigue llegando por
ahí). Sin redirect, sin rename: cero cambios en Navbar, hooks, api o BE de notificaciones. La
campanita no puede romperse porque no se toca ninguno de sus archivos.

### 1.3 Legacy `/admin/support/news` (stub Splynx) y Change B

HOY existe otro "Noticias": `Sidebar.tsx:99` (`/admin/support/news`, grupo Mensajes) →
`pages/support/NewsPage.tsx`, cuyo `api/news.api.ts` devuelve un **array mock hardcodeado** (sin
llamada al BE — verificado: `getNews()` retorna literales). En el BE no existe NINGÚN código de
news → **`/api/news` está libre**.

`feat/sidebar-comunicaciones` (Change B) **elimina** ese stub completo: `pages/support/*`,
`hooks/useNews.ts`, `api/news.api.ts`, `types/news.ts`, el grupo "Mensajes" del sidebar, y
renombra WhatsApp→Comunicaciones (verificado con `git diff main...feat/sidebar-comunicaciones`).
Este change REUTILIZA los nombres liberados (`useNews.ts`, `news.api.ts`, `types/news.ts`) con
contenido real → **el apply FE corre después del merge de B** (proposal §5).

## 2. Modelo de datos (aditivo puro)

```prisma
model NewsCategory {
  id        String     @id @default(uuid())
  name      String     @unique
  color     String
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  posts     NewsPost[]
}

model NewsPost {
  id           String            @id @default(uuid())
  title        String
  body         String            // texto plano multiline (v1 — ver §3)
  categoryId   String
  category     NewsCategory      @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  authorId     String?
  author       RbacUser?         @relation(fields: [authorId], references: [id], onDelete: SetNull)
  authorName   String            // snapshot — sobrevive al borrado del usuario
  pinned       Boolean           @default(false)
  publishedAt  DateTime          @default(now())
  archivedAt   DateTime?
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt
  readReceipts NewsReadReceipt[]

  @@index([categoryId])
  @@index([archivedAt])
  @@index([pinned, publishedAt])
}

model NewsReadReceipt {
  id         String   @id @default(uuid())
  newsPostId String
  newsPost   NewsPost @relation(fields: [newsPostId], references: [id], onDelete: Cascade)
  userId     String
  user       RbacUser @relation(fields: [userId], references: [id], onDelete: Cascade)
  readAt     DateTime @default(now())

  @@unique([newsPostId, userId])
  @@index([userId])
}
```

Back-relations en `RbacUser`: `newsPosts NewsPost[]` + `newsReadReceipts NewsReadReceipt[]`.

**Decisiones y moldes:**
- **`NewsCategory` calca `TicketAreaCatalog`** (`schema.prisma:2289-2299` para el shape
  name-unique+color; el color viene del change `ticket-area-color`). Editable por UI, borrado
  guardeado (§5).
- **Autor**: `authorId` FK física nullable `onDelete: SetNull` + `authorName` snapshot. Es el
  patrón dominante para "quién lo hizo": `Ticket.reporterId` (`schema.prisma:2337-2338`, FK
  SetNull) + `ClientComment.authorName` (`schema.prisma:328`, snapshot). El pedido decía
  "soft-ref", pero en este codebase soft-ref (sin FK física) se reserva para cross-system
  (`RbacUser.iclassTeamLogin`, `schema.prisma:2423`); para refs internas SIEMPRE hay FK física
  con SetNull — se sigue esa convención, el snapshot cubre el caso "usuario borrado".
- **`categoryId` REQUERIDO** (`onDelete: Restrict`): toda noticia tiene categoría ("General"
  existe por seed). Restrict a nivel DB es el backstop del guard de aplicación (§5).
- **`NewsReadReceipt`**: `@@unique([newsPostId, userId])` hace el mark-read idempotente por
  constraint; `Cascade` en ambas FKs (borrar post o usuario limpia receipts — data derivada).
- **`publishedAt`**: estampado server-side al crear (sin scheduling futuro — out of scope).
  Orden del tablón: `pinned DESC, publishedAt DESC` (índice compuesto lo cubre).

## 3. Formato del body: texto plano multiline (v1)

- El FE **no tiene** ninguna lib de markdown (`package.json` verificado: cero matches de
  markdown/marked/remark). Markdown liviano = dependencia nueva + superficie XSS a sanitizar.
- v1: `body` texto plano, render con `white-space: pre-wrap` (respeta saltos de línea/párrafos —
  suficiente para "hice el cambio Y, detalle: ..."). React escapa por defecto → XSS-safe sin
  sanitizador.
- Upgrade futuro a markdown liviano es aditivo (el campo ya es texto; solo cambia el renderer).
- Límites Zod: `title` trim 1..200; `body` trim 1..20000.

## 4. RBAC: módulo `news` + seed idempotente

- **`'news'` se agrega a `RBAC_MODULES`** (`src/domain/entities/rbac.ts:98-144`). Acciones
  `read`/`manage` YA existen como base actions (`rbac.ts:19-24`); precedente exacto: el módulo
  `uisp` usa las base actions sin agregar códigos (`rbac.ts:89-90`).
- **Migración de permisos calca `20260908000100_messaging_bulk_permissions` /
  `20260904000100_messaging_permissions`**: INSERT módulo (`code='news'`, `label='Noticias'`) +
  permisos (`news.read`, `news.manage`) + grants, todo `ON CONFLICT DO NOTHING`.
- **Grants**: `news.read` → los 6 roles de sistema (`rbac.ts:152-159`: `super_admin`,
  `administrador`, `administracion`, `ventas`, `noc`, `tecnico`). `news.manage` → `super_admin` +
  `administrador`. (`requirePermission` ya short-circuitea super_admin —
  `middleware/requirePermission.ts:33-38` — el grant explícito es belt-and-suspenders, igual que
  hizo messaging.)
- **Nota operativa**: roles NO-system creados en runtime no reciben el grant por migración; se
  otorga por la UI de RBAC (comportamiento estándar de todos los módulos).

## 5. Capa de aplicación: ports, use cases, errores, DTOs

### 5.1 Ports (en `src/domain/ports/`)

```ts
// NewsPostRepository — incluye el estado de lectura (read model por usuario)
interface NewsPostListFilters { categoryId?: string; archived?: boolean; } // archived default false
interface NewsPostRepository {
  create(input: CreateNewsPostData): Promise<NewsPost>;
  update(id: string, patch: UpdateNewsPostData): Promise<NewsPost | null>;
  findById(id: string, userId: string): Promise<NewsPostWithReadState | null>;
  list(filters: NewsPostListFilters, userId: string): Promise<NewsPostWithReadState[]>; // pinned DESC, publishedAt DESC
  setArchived(id: string, archived: boolean): Promise<NewsPost | null>;
  markRead(postId: string, userId: string): Promise<void>;   // upsert idempotente
  countUnread(userId: string): Promise<number>;              // no-archivadas sin receipt del user
}

interface NewsCategoryRepository {
  list(): Promise<NewsCategory[]>;
  findById(id: string): Promise<NewsCategory | null>;
  findByName(name: string): Promise<NewsCategory | null>;
  create(input: { name: string; color: string }): Promise<NewsCategory>;
  update(id: string, patch: { name?: string; color?: string }): Promise<NewsCategory | null>;
  delete(id: string): Promise<void>;
  countPosts(id: string): Promise<number>;                   // guard de borrado
}
```

Dos ports, no tres: `NewsReadReceipt` no tiene lifecycle propio (es data derivada del par
post+user) — sus operaciones viven en `NewsPostRepository` (`markRead`/`countUnread`/read-state).
`NewsPostWithReadState = NewsPost & { read: boolean }` es un read model (el `read` es estado
por-usuario, no del entity).

### 5.2 Use cases (uno por archivo, verbo+sustantivo)

`CreateNewsPost` (valida categoría existente → error tipado; estampa `authorId`/`authorName`
desde el usuario de sesión — patrón `req.user.id` de `tickets.routes.ts:507`), `ListNewsPosts`
(devuelve `{ items, unreadCount }`), `GetNewsPost`, `UpdateNewsPost` (title/body/categoryId/
pinned), `ArchiveNewsPost(id, archived: boolean)` (setea/limpia `archivedAt`),
`MarkNewsRead(postId, userId)` (idempotente), `GetNewsUnreadCount(userId)`,
`ListNewsCategories`, `CreateNewsCategory`, `UpdateNewsCategory`, `DeleteNewsCategory`
(guard `countPosts > 0` → `NewsCategoryInUseError`).

### 5.3 Errores de dominio (`src/domain/errors/news.ts`, calco `errors/tickets.ts`)

| Error | code | HTTP |
|---|---|---|
| `NewsPostNotFoundError` | `NEWS_POST_NOT_FOUND` | 404 |
| `NewsCategoryNotFoundError` | `NEWS_CATEGORY_NOT_FOUND` | 404 (CRUD categorías) / **422** (categoryId inexistente en create/update de post — molde de la validación up-front del reporterId, `tickets.routes.ts:460-466`) |
| `NewsCategoryNameConflictError` | `NEWS_CATEGORY_NAME_CONFLICT` | 409 |
| `NewsCategoryInUseError` | `NEWS_CATEGORY_IN_USE` | 409 |

### 5.4 DTOs (`src/application/dto/news.dto.ts` — jamás entidad Prisma cruda)

```ts
NewsCategoryDto = { id, name, color }
NewsPostDto = { id, title, body, category: NewsCategoryDto, authorId, authorName,
                pinned, publishedAt, archivedAt, read, createdAt, updatedAt }
ListNewsPostsResultDto = { items: NewsPostDto[], unreadCount: number }
```

Zod (calco `CreateTicketAreaSchema`, `tickets.dto.ts:66-74` — trim ANTES de min):
`CreateNewsPostSchema { title: trim 1..200, body: trim 1..20000, categoryId: min(1),
pinned: boolean optional }`; `UpdateNewsPostSchema = .partial()`;
`CreateNewsCategorySchema { name: trim min 1, color: HexColorSchema }`;
`UpdateNewsCategorySchema = .partial()`; `ArchiveNewsPostSchema { archived: boolean }`.

## 6. HTTP: `news.routes.ts` + wiring

### 6.1 Rutas (mount `/api/news`)

Factory con DI calcada de `createTicketAreasRouter` (`ticketAreas.routes.ts:17-32`): recibe
`authProvider` + `requirePerm` + use cases; `auth` + guard por ruta; errores tipados mapeados +
fallback `next(err)` SIEMPRE (regla Express 4 — comentario `ticketAreas.routes.ts:50`).

| Método y path | Guard | Notas |
|---|---|---|
| GET `/` | `news.read` | `?category=<id>` `?unread=true` `?archived=true`; `archived=true` sin `news.manage` → **403** |
| GET `/unread-count` | `news.read` | `{ count }` — el endpoint barato del badge |
| GET `/categories` | `news.read` | para chips de filtro + Select del modal |
| POST `/categories` | `news.manage` | 400 Zod / 409 conflict |
| PUT `/categories/:id` | `news.manage` | 404 / 409 conflict |
| DELETE `/categories/:id` | `news.manage` | 404 / **409 in-use** — calco `ticketAreas.routes.ts:95-111` |
| POST `/` | `news.manage` | 400 Zod / 422 categoría inexistente; estampa autor de sesión |
| GET `/:id` | `news.read` | detalle con `read`; **NO auto-marca** (el mark es explícito) |
| PUT `/:id` | `news.manage` | 400 / 404 / 422 |
| PUT `/:id/archive` | `news.manage` | body `{ archived: boolean }`; 404 |
| POST `/:id/read` | `news.read` | idempotente → 204; 404 si el post no existe |

**Orden de declaración**: paths estáticos (`/unread-count`, `/categories*`) ANTES de `/:id` para
que el catch-all no los trague — mismo criterio que el mount de statuses/areas antes del router
de tickets (`app.ts:1348-1359`).

**Contraste deliberado con notifications**: `/api/notifications` está montado SIN guards
(`app.ts:1952` + router sin auth). `/api/news` NO copia eso — auth + requirePerm en cada ruta
(regla del workflow: guards en ambas capas). El userId para read-state sale de `req.user.id`
(seteado por `authMiddleware`, `middleware/authMiddleware.ts:27`).

### 6.2 Wiring `app.ts` + pin anti-W6

Composition root: construir `PrismaNewsPostRepository` / `PrismaNewsCategoryRepository`, los 11
use cases, y montar `app.use('/api/news', createNewsRouter(authAdapter, requirePerm, ...))`
(`requirePerm` ya es export nombrado — `app.ts:857-858`). Pin:
`src/__tests__/infrastructure/news-composition.test.ts` con las DOS patas del patrón existente:
1. **Source-scan** de `app.ts` (`readFileSync`, molde `actions-composition.test.ts:13`) — asserts
   de que el mount existe, recibe `authAdapter` y `requirePerm`, y los repos Prisma se instancian.
2. **Supertest** del router armado con in-memory (molde `app-composition.iclassStatuses.test.ts`)
   — happy path + 403 real.

## 7. Unread-count: mecanismo del badge (el más barato)

**Cómo trae contadores el FE hoy** (evidencia):
- Campanita: `useNotifications` trae la LISTA completa y filtra client-side (`Navbar.tsx:110`),
  `staleTime 30s`, sin polling → badge stale hasta remount.
- Inbox WhatsApp: polling `refetchInterval` 15s **gateado por visibilidad de pestaña**
  (`hooks/useDocumentVisible.ts` + `useWhatsapp.ts` — el intervalo pasa a `false` con la pestaña
  oculta).

**Decisión**: endpoint dedicado `GET /api/news/unread-count` → `{ count }`, resuelto con UN
`COUNT` (`NewsPost` no-archivadas sin `NewsReadReceipt` del user — `NOT EXISTS`, cubierto por
`@@unique([newsPostId, userId])` + `@@index([archivedAt])`). FE: hook `useNewsUnreadCount` con
`refetchInterval: visible ? 60_000 : false` (patrón useDocumentVisible) + `staleTime 30_000`, e
invalidación inmediata al `MarkNewsRead` (el badge baja al toque al leer, sin esperar el tick).
Un COUNT por usuario por minuto con pestaña visible: más barato que traer la lista, y el sidebar
no depende de que el tablón esté montado. Piggyback sobre `/api/notifications` descartado
(endpoint sin guards, data global, y acopla noticias a la campanita que NO tocamos).

## 8. Migración + seed

- **Un solo archivo** `prisma/migrations/20260911000000_internal_news/migration.sql` (posterior a
  `20260910000000_add_accesspoint_and_contract_node_ap`, la última). Generación:
  `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script` (sin DB local, molde
  design de contract-node-ap-catalog §5). Contenido: 3 `CREATE TABLE` + índices + FKs
  (`Restrict`/`SetNull`/`Cascade` según §2) — **cero DROP, cero backfill** — seguido del seed
  idempotente en el MISMO archivo (molde `20260704000000_ticket_area_catalog` que combina DDL +
  seed):
  - 4 categorías: Red/Infraestructura `#6366f1`, Campañas `#f59e0b`, Comercial `#10b981`,
    General `#64748b` — `ON CONFLICT ("name") DO NOTHING`.
  - Módulo `news` + permisos + grants (§4) — `ON CONFLICT DO NOTHING`.
- **Higiene**: NO correr `prisma format` (lección FIX-5 de contract-node-ap-catalog: re-alinea
  TODO el schema → churn de cientos de líneas). Editar `schema.prisma` a mano + `npx prisma
  validate` + `npx prisma generate`.
- Sin `BEGIN/COMMIT` (Prisma envuelve cada migración en su transacción).

## 9. FE — diseño (spec en `specs/internal-news-fe/spec.md`; apply POST-merge de B)

### 9.1 Sidebar (swap + badge)

- `navTop` (`Sidebar.tsx:545-570`): se quita el NavLink "Notificaciones" y se agrega **"Noticias"**
  → `/admin/news`. A diferencia de los navTop actuales (sin gate), este se gatea con
  `can('news.read')` respetando la convención "mientras carga → mostrar, sin layout shift"
  (`Sidebar.tsx:452-457`).
- **Badge**: burbuja con `unreadCount` (cap `99+`, molde `Navbar.tsx:222-226`), oculta cuando 0,
  `aria-label="N noticias sin leer"`. Data: `useNewsUnreadCount` (§7). Primer badge del sidebar —
  no existe mecanismo previo (verificado: `Sidebar.tsx` no renderiza contadores).

### 9.2 Rutas

- `/admin/news` → `NewsBoardPage`, `RequirePermission news.read` (molde `App.tsx:400`).
- `/admin/news/settings` → `NewsSettingsPage` (categorías), `RequirePermission news.manage` —
  equivalente del patrón `/admin/tickets/settings` gated `tickets.manage` (`Sidebar.tsx:88`).
- `/admin/notifications` **queda como está** (`App.tsx:400`) — target del footer de la campanita.

### 9.3 NewsBoardPage (estructura/comportamiento/a11y — la estética la resuelve el apply)

- Header: título + botón "Nueva noticia" (`Can news.manage`) + acceso a categorías
  (`Can news.manage`, link a `/admin/news/settings`).
- Filtros: chips de categoría con su color (fuente GET `/categories`), toggle "Solo no leídas",
  toggle "Archivadas" (solo con `news.manage`; dispara `?archived=true`).
- Tablón de cards: pinned SIEMPRE arriba (con indicador visual), no-leídas destacadas (acento +
  dot, molde `notifItemUnread`), pill de categoría con color, autor + fecha relativa, título +
  body clamped.
- Detalle: drawer/expandible al click, **keyed por `post.id`** (lección inbox: estado local sin
  key contamina entre ítems), body completo `pre-wrap` + metadata. Al abrir: si `!read` →
  `POST /:id/read` UNA vez + invalidar `['news']` y `['news','unread-count']`.
- 4 ramas de estado: loading (skeleton), error (mensaje + retry), empty (CTA "Nueva noticia" si
  manage), data.
- Modal de creación/edición: título, categoría (Select PROPIO —
  `components/molecules/Select/Select.tsx`), body textarea, pinned checkbox. Doble validación
  (submit deshabilitado hasta válido en FE + Zod en BE); mapeo de errores 400/409/422. a11y:
  `role="dialog"`, `aria-labelledby`, focus inicial, cierre Esc/overlay — molde `TicketAreaModal`
  (`TicketAreasBody.tsx:23-79`).

### 9.4 NewsSettingsPage (categorías)

Calco 1:1 de `TicketAreasBody.tsx`: lista con swatch de color + nombre + acciones, modal
create/edit (input color nativo), delete con `useConfirm` y manejo de `NEWS_CATEGORY_IN_USE`
(409) con mensaje claro ("tiene noticias asociadas").

### 9.5 Capa de datos FE

`types/news.ts` (NewsPost/NewsCategory), `api/news.api.ts` (axios, respuestas RAW sin envelope —
mismo estilo que `notifications.api.ts`; verificar shape real en el E2E vivo: lección
"E2E vs mocks"), `hooks/useNews.ts` (queries `['news', filters]` / `['news','unread-count']` /
`['news','categories']` + mutations con invalidación).

## 10. Testing (Strict TDD — matriz en las specs)

- **BE unit**: port parity in-memory (calco `InMemoryAccessPointRepository.test.ts`), use cases
  con in-memory (NUNCA mockear Prisma).
- **BE rutas**: supertest con fixture EchoAuthProvider + RBAC in-memory (calco EXACTO de
  `ticketAreas.routes.test.ts:36-100`): 401 sin cookie, 403 sin `news.read`, 403 sin
  `news.manage` en TODAS las mutaciones, 403 `archived=true` sin manage, happy paths, 400/404/
  409/422, mark-read idempotente.
- **BE composición**: `news-composition.test.ts` (§6.2).
- **FE**: sidebar (item gated + badge + ausencia de "Notificaciones"), routing (gates de ambas
  rutas nuevas + `/admin/notifications` sigue vivo), board (4 ramas, orden pinned, mark-read al
  abrir una sola vez), modal (validación doble), categorías (CRUD + 409), y regresión: los tests
  existentes de `Navbar` (campanita) DEBEN seguir verdes sin modificarse.
