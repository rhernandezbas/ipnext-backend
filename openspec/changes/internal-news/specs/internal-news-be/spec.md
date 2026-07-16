# Spec — internal-news BE (delta)

RFC-2119. Cada scenario debe quedar cubierto por al menos un test verde (sdd-verify).

**Decisiones LOCKED del proposal/design (no se reabren):**
- Módulo RBAC `news` con base actions `read`/`manage`. Guards BE en TODAS las rutas (auth +
  requirePerm) — a diferencia de `/api/notifications`, que no se toca.
- `body` = texto plano multiline v1. `categoryId` requerido (`Restrict`). Autor = FK `SetNull` +
  `authorName` snapshot. Read receipts con `@@unique([newsPostId, userId])`.
- Migración aditiva única con seed idempotente (categorías + RBAC) `ON CONFLICT DO NOTHING`.
- `/api/notifications`, `Notification`, campanita: CERO cambios.

---

## Capability: persistencia (schema/migración/seed)

### Requirement: NEWS-MIG-1 — migración aditiva con seed idempotente
La migración `20260911000000_internal_news` MUST crear las tablas `NewsCategory` (name UNIQUE),
`NewsPost` (FKs: category `ON DELETE RESTRICT`, author `ON DELETE SET NULL`; índices por
`categoryId`, `archivedAt`, `[pinned, publishedAt]`) y `NewsReadReceipt` (UNIQUE
`[newsPostId, userId]`, FKs `ON DELETE CASCADE`). MUST NO contener DROP ni backfill. MUST incluir
el seed idempotente: 4 categorías (Red/Infraestructura, Campañas, Comercial, General) con
`ON CONFLICT ("name") DO NOTHING`, módulo RBAC `news` (label `Noticias`), permisos `news.read` /
`news.manage`, grants `news.read` → los 6 roles de sistema y `news.manage` → `super_admin` +
`administrador`, todo `ON CONFLICT DO NOTHING`.

#### Scenario: SQL solo aditivo
- Given el archivo `migration.sql`
- When se revisa su contenido
- Then contiene los 3 `CREATE TABLE`, los índices, el UNIQUE compuesto y las FKs con las
  semánticas `RESTRICT`/`SET NULL`/`CASCADE` especificadas, y NO contiene `DROP`

#### Scenario: seed re-ejecutable
- Given una DB donde el seed ya corrió
- When las sentencias de seed se ejecutan de nuevo
- Then no fallan ni duplican filas (todas llevan `ON CONFLICT ... DO NOTHING`)

### Requirement: NEWS-RBAC-1 — módulo `news` en el dominio
`RBAC_MODULES` en `src/domain/entities/rbac.ts` MUST incluir `'news'`. MUST NO agregarse ningún
action code nuevo (`read`/`manage` ya existen como base actions).

#### Scenario: módulo tipado
- Given el type `RbacModuleCode`
- When se usa `requirePerm('news', 'read')` / `requirePerm('news', 'manage')`
- Then compila sin cast y el guard resuelve contra los permisos seedeados

---

## Capability: ports y adapters

### Requirement: NEWS-PORT-1 — `NewsPostRepository` con read-state por usuario
El port MUST exponer `create`, `update`, `findById(id, userId)`, `list(filters, userId)`,
`setArchived(id, archived)`, `markRead(postId, userId)` y `countUnread(userId)`. `list` MUST
devolver `NewsPostWithReadState` (entity + `read: boolean` según exista receipt del user) ordenado
`pinned DESC, publishedAt DESC`, MUST excluir archivadas por default y MUST filtrar por
`categoryId` y `archived: true` (solo archivadas) cuando se pide. Ambos adapters
(`InMemoryNewsPostRepository`, `PrismaNewsPostRepository`) MUST cumplir el mismo contrato.

#### Scenario: orden del tablón
- Given posts A (pinned, publishedAt viejo), B (no pinned, publishedAt nuevo), C (pinned,
  publishedAt nuevo)
- When `list({}, userId)`
- Then el orden es C, A, B

#### Scenario: read-state por usuario
- Given un post leído por `u1` y no por `u2`
- When `list({}, 'u1')` y `list({}, 'u2')`
- Then el post viene con `read: true` para u1 y `read: false` para u2

#### Scenario: archivadas excluidas por default
- Given un post archivado y uno activo
- When `list({}, userId)`
- Then solo devuelve el activo; con `list({ archived: true }, userId)` solo el archivado

### Requirement: NEWS-PORT-2 — markRead idempotente y countUnread
`markRead` MUST ser idempotente: dos llamadas con el mismo par (post, user) dejan UNA sola fila.
`countUnread(userId)` MUST contar solo posts NO archivados sin receipt del user.

#### Scenario: doble mark no duplica
- Given un post sin leer
- When `markRead(p, u)` dos veces
- Then hay 1 receipt y `countUnread(u)` baja exactamente 1

#### Scenario: archivar saca del unread
- Given 2 posts sin leer para `u`
- When se archiva uno
- Then `countUnread(u)` = 1

### Requirement: NEWS-PORT-3 — `NewsCategoryRepository` CRUD con countPosts
El port MUST exponer `list`, `findById`, `findByName`, `create`, `update`, `delete`,
`countPosts(id)`. `name` MUST ser único a nivel DB (constraint `NewsCategory_name_key`,
case exacto), trim aplicado en DTO. `findByName` MUST comparar case-insensitive — más
estricto que la letra original de este requirement (review fix L8, aceptado): evita que
`CreateNewsCategory`/`UpdateNewsCategory` dejen crear "General" y "general" como categorías
distintas, aunque el índice UNIQUE de Postgres solo no lo impediría.

#### Scenario: countPosts refleja el uso
- Given una categoría con 2 posts y otra con 0
- When `countPosts` de cada una
- Then devuelve 2 y 0 respectivamente

---

## Capability: use cases

### Requirement: NEWS-UC-1 — CreateNewsPost estampa autor y valida categoría
`CreateNewsPost` MUST validar que `categoryId` exista (si no, `NewsCategoryNotFoundError`), MUST
estampar `authorId` + `authorName` desde el usuario de sesión recibido, MUST setear `publishedAt`
server-side y MUST devolver un DTO curado (nunca la entidad Prisma).

#### Scenario: create feliz
- Given la categoría `General` y el usuario de sesión `{ id: 'u1', name: 'Ana' }`
- When se crea `{ title, body, categoryId, pinned: true }`
- Then el DTO tiene `authorId='u1'`, `authorName='Ana'`, `pinned=true`, `read=false` implícito
  para otros usuarios y `publishedAt` no vacío

#### Scenario: categoría inexistente
- Given un `categoryId` que no existe
- When se ejecuta el use case
- Then lanza `NewsCategoryNotFoundError`

### Requirement: NEWS-UC-2 — ListNewsPosts devuelve items + unreadCount
`ListNewsPosts.execute(filters, userId)` MUST devolver `{ items, unreadCount }` donde
`unreadCount` es el total global de no-leídas NO archivadas del user (independiente del filtro de
categoría aplicado a `items`).

#### Scenario: unreadCount global con filtro activo
- Given 3 no-leídas (2 en cat X, 1 en cat Y)
- When se lista con filtro `categoryId = X`
- Then `items` tiene 2 y `unreadCount` = 3

### Requirement: NEWS-UC-3 — ArchiveNewsPost setea y limpia
`ArchiveNewsPost.execute(id, archived)` MUST setear `archivedAt = now` con `true` y `null` con
`false`; post inexistente MUST lanzar `NewsPostNotFoundError`.

#### Scenario: archivar y desarchivar
- Given un post activo
- When se archiva y luego se desarchiva
- Then `archivedAt` pasa a fecha y vuelve a null

### Requirement: NEWS-UC-4 — DeleteNewsCategory guardeado
`DeleteNewsCategory` MUST lanzar `NewsCategoryInUseError` si `countPosts(id) > 0` y MUST borrar
solo categorías vacías. `CreateNewsCategory`/`UpdateNewsCategory` MUST lanzar
`NewsCategoryNameConflictError` ante nombre duplicado.

#### Scenario: borrar categoría en uso
- Given una categoría con 1 post
- When se intenta borrar
- Then lanza `NewsCategoryInUseError` y la categoría sigue existiendo

---

## Capability: HTTP /api/news (guards en capa BE)

### Requirement: NEWS-HTTP-1 — autenticación y permisos en TODAS las rutas
Toda ruta de `/api/news` MUST exigir cookie de sesión válida (401 sin ella) y el permiso
correspondiente: `news.read` para GET `/`, `/unread-count`, `/categories`, `/:id` y POST
`/:id/read`; `news.manage` para POST `/`, PUT `/:id`, PUT `/:id/archive` y el CRUD de categorías.
Sin permiso MUST responder 403 `PERMISSION_DENIED`. `GET /?archived=true` sin `news.manage` MUST
responder 403.

#### Scenario: 401 sin cookie
- Given una request sin `auth_token`
- When GET `/api/news`
- Then 401

#### Scenario: 403 lectura sin news.read
- Given un usuario autenticado sin `news.read`
- When GET `/api/news`
- Then 403 con `code: 'PERMISSION_DENIED'`

#### Scenario: 403 mutación con solo news.read
- Given un usuario con `news.read` pero sin `news.manage`
- When POST `/api/news`, PUT `/api/news/:id`, PUT `/api/news/:id/archive`, POST/PUT/DELETE de
  `/api/news/categories*`, o GET `/api/news?archived=true`
- Then 403 en TODOS los casos

#### Scenario: lector marca leída
- Given un usuario con SOLO `news.read` y un post existente
- When POST `/api/news/:id/read`
- Then 204, y repetir la llamada devuelve 204 de nuevo (idempotente)

### Requirement: NEWS-HTTP-2 — contratos de respuesta y errores
GET `/` MUST devolver `{ items: NewsPostDto[], unreadCount }`; GET `/unread-count` MUST devolver
`{ count }`; los DTOs MUST NO exponer campos Prisma crudos fuera del contrato del design §5.4.
Bodies inválidos MUST dar 400 `VALIDATION_ERROR` (Zod `safeParse`); `categoryId` inexistente en
POST/PUT de post MUST dar 422; ids inexistentes MUST dar 404 con el code tipado; conflictos de
categoría MUST dar 409 (`NEWS_CATEGORY_NAME_CONFLICT` / `NEWS_CATEGORY_IN_USE`). Todo handler
MUST terminar en `next(err)` como fallback (Express 4: un throw async cuelga la request).

#### Scenario: validación de create
- Given un body `{ title: '   ', body: 'x', categoryId: 'c1' }`
- When POST `/api/news`
- Then 400 `VALIDATION_ERROR` (el trim vacía el title)

#### Scenario: unread-count barato
- Given un usuario con 2 no-leídas activas y 1 archivada sin leer
- When GET `/api/news/unread-count`
- Then `{ count: 2 }`

#### Scenario: rutas estáticas no tragadas por :id
- Given el router montado
- When GET `/api/news/unread-count` y GET `/api/news/categories`
- Then responden sus handlers propios (no el 404 de `GET /:id`)

### Requirement: NEWS-HTTP-3 — composition root pin (anti-W6)
`app.ts` MUST instanciar los adapters Prisma de news y montar `/api/news` pasando `authAdapter` y
`requirePerm`. Un test de composición MUST pinnear ese wiring por source-scan (mount + guards +
repos Prisma) y MUST ejercitar un 403 real vía supertest sobre el router armado.

#### Scenario: pin del mount
- Given el source de `app.ts`
- When se busca el mount de `/api/news`
- Then existe, recibe `authAdapter` y `requirePerm`, e instancia `PrismaNewsPostRepository` y
  `PrismaNewsCategoryRepository`

### Requirement: NEWS-HTTP-4 — notifications intocado
El change MUST NO modificar `notifications.routes.ts`, el modelo `Notification`, sus use cases,
ni el mount de `/api/notifications`.

#### Scenario: diff limpio
- Given el diff del change en BE
- When se revisan los archivos tocados
- Then ningún archivo de notifications aparece modificado
