# Tasks — internal-news

**Change**: internal-news · **Phase**: tasks · **Project**: ipnext-backend (+ ipnext-frontend)
**Reads**: `design.md`, `specs/internal-news-be/spec.md`, `specs/internal-news-fe/spec.md`
**Convención TDD**: cada tarea de código lista el TEST primero (red → green). Jest + adapters
in-memory — NUNCA mockear Prisma. Path aliases siempre. NO `npm run build` ni `prisma migrate`
(lo decide el usuario). Tests focalizados con `npx jest <ruta>`.

**Orden**: BE (batches 1-5, este worktree `feat/internal-news`) → FE (batches 6-9).

> ⛔ **GATE FE**: los batches 6-9 corren en `ipnext-frontend` y están BLOQUEADOS hasta que
> **`feat/sidebar-comunicaciones` (Change B) esté MERGEADO a main**. Motivo (design §1.3):
> (1) ambos changes editan `Sidebar.tsx`; (2) B elimina el stub legacy
> (`pages/support/NewsPage.tsx`, `hooks/useNews.ts`, `api/news.api.ts`, `types/news.ts`) cuyos
> NOMBRES este change reutiliza con contenido nuevo. Aplicar FE antes del merge = conflicto +
> dos ítems "Noticias" en el sidebar. El apply FE arranca de main POST-merge.

---

## Batch 1 — BE: RBAC + schema + migración (aditivo)

### T1.1 — módulo `news` en el dominio (NEWS-RBAC-1)
- [x] TEST (RED): scenario de tipado/uso — `requirePerm('news','read'|'manage')` compila y el
  guard resuelve (puede pinnearse dentro del test de rutas del Batch 4; acá basta extender el
  test existente de `rbac.ts` si lo hay, o crear uno mínimo de `RBAC_MODULES` incluye `'news'`).
- [x] CÓDIGO: agregar `'news'` a `RBAC_MODULES` (`src/domain/entities/rbac.ts:98-144`), con
  comentario del change. NO agregar action codes (`read`/`manage` ya existen — `rbac.ts:89-90`).

### T1.2 — `prisma/schema.prisma` (design §2)
- [x] Modelos `NewsCategory`, `NewsPost`, `NewsReadReceipt` EXACTOS al design §2 (FKs
  Restrict/SetNull/Cascade, `@@unique([newsPostId, userId])`, índices `categoryId`/`archivedAt`/
  `[pinned, publishedAt]`) + back-relations en `RbacUser`.
- [x] Editar A MANO sin `prisma format` (lección FIX-5 contract-node-ap-catalog: churn masivo).
- [x] `npx prisma validate` + `npx prisma generate` (el cliente tipa `prisma.newsPost`).
- [x] Verificar churn: `git diff --stat main -- prisma/schema.prisma` ≈ solo las líneas nuevas.

### T1.3 — migración + seed (NEWS-MIG-1)
- [x] Generar DDL con `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script`
  (sin DB local) → `prisma/migrations/20260911000000_internal_news/migration.sql` (posterior a
  `20260910000000_add_accesspoint_and_contract_node_ap`).
- [x] Append del seed idempotente en el MISMO archivo (molde `20260704000000_ticket_area_catalog`
  + `20260904000100_messaging_permissions`): 4 categorías con color (design §8) `ON CONFLICT
  ("name") DO NOTHING`; módulo `news`/permisos/grants (`news.read` → 6 roles de sistema,
  `news.manage` → super_admin + administrador) `ON CONFLICT DO NOTHING`.
- [x] Revisar: solo CREATE TABLE / índices / FKs / INSERTs idempotentes. Sin DROP, sin backfill,
  sin BEGIN/COMMIT.

## Batch 2 — BE: entities, errors, ports, adapters (NEWS-PORT-1/2/3)

### T2.1 — tests port parity (RED)
- [x] `src/__tests__/infrastructure/adapters/in-memory/InMemoryNewsPostRepository.test.ts`:
  create/update, orden pinned+publishedAt, read-state por usuario, filtro categoría, archived
  default-excluida / `archived:true` solo-archivadas, markRead idempotente, countUnread excluye
  archivadas y leídas, setArchived set/clear.
- [x] `.../InMemoryNewsCategoryRepository.test.ts`: CRUD, findByName, countPosts.

### T2.2 — implementación (GREEN)
- [x] `src/domain/entities/news.ts` (`NewsPost`, `NewsCategory`, `NewsPostWithReadState`).
- [x] `src/domain/errors/news.ts` (4 errores tipados, design §5.3 — calco `errors/tickets.ts`).
- [x] `src/domain/ports/NewsPostRepository.ts` + `NewsCategoryRepository.ts` (design §5.1).
- [x] `src/infrastructure/adapters/in-memory/InMemoryNewsPostRepository.ts` +
  `InMemoryNewsCategoryRepository.ts` (naming `InMemory{X}Repository`).
- [x] `src/infrastructure/adapters/prisma/PrismaNewsPostRepository.ts` +
  `PrismaNewsCategoryRepository.ts` (naming `Prisma{X}Repository`; countUnread = COUNT con
  NOT EXISTS receipt; markRead = upsert/`ON CONFLICT DO NOTHING`).

## Batch 3 — BE: use cases (NEWS-UC-1/2/3/4)

### T3.1 — tests unit con in-memory (RED)
- [x] `src/__tests__/application/use-cases/` — un archivo por use case (o agrupados por entidad):
  CreateNewsPost (autor estampado, categoría inexistente → error, publishedAt server-side, DTO
  curado), ListNewsPosts (items + unreadCount GLOBAL con filtro activo), GetNewsPost (404),
  UpdateNewsPost (patch parcial, 422 categoría), ArchiveNewsPost (set/clear, 404), MarkNewsRead
  (idempotente), GetNewsUnreadCount, ListNewsCategories, CreateNewsCategory (conflict),
  UpdateNewsCategory (404/conflict), DeleteNewsCategory (in-use → error).

### T3.2 — implementación (GREEN)
- [x] 11 use cases en `src/application/use-cases/` (verbo+sustantivo, dependen SOLO de ports).
- [x] `src/application/dto/news.dto.ts`: DTOs + Zod schemas (design §5.4; trim ANTES de min —
  molde `tickets.dto.ts:66-74`) + mappers entidad→DTO.

## Batch 4 — BE: rutas HTTP (NEWS-HTTP-1/2)

### T4.1 — test supertest (RED)
- [x] `src/__tests__/infrastructure/news.routes.test.ts` — fixture calco EXACTO de
  `ticketAreas.routes.test.ts:36-100` (EchoAuthProvider + RBAC in-memory, usuarios manage /
  read-only / sin permisos): 401 sin cookie; 403 sin `news.read` en GETs; 403 sin `news.manage`
  en TODAS las mutaciones + `?archived=true`; happy paths de las 11 rutas; 400 Zod; 404s; 409
  name-conflict e in-use; 422 categoría inexistente; POST `/:id/read` 204 idempotente; respuesta
  `{ items, unreadCount }` y `{ count }`; `/unread-count` y `/categories` NO tragados por `/:id`.

### T4.2 — implementación (GREEN)
- [x] `src/infrastructure/http/routes/news.routes.ts` — factory
  `createNewsRouter(authProvider, requirePerm, ...useCases)` (molde `ticketAreas.routes.ts:17-32`),
  rutas estáticas ANTES de `/:id`, mapeo de errores tipados + fallback `next(err)` SIEMPRE.

## Batch 5 — BE: wiring + composición (NEWS-HTTP-3/4)

### T5.1 — test composición (RED)
- [x] `src/__tests__/infrastructure/news-composition.test.ts`: (a) source-scan de `app.ts`
  (`readFileSync` — molde `actions-composition.test.ts:13`): mount `/api/news` con `authAdapter`
  + `requirePerm` + instanciación de ambos repos Prisma; (b) supertest sobre router in-memory:
  happy + 403 real.

### T5.2 — wiring (GREEN)
- [x] `app.ts`: repos Prisma + 11 use cases + `app.use('/api/news', createNewsRouter(...))`.
- [x] Verificar NEWS-HTTP-4: `git diff --stat main` NO toca notifications (routes/use-cases/
  model/mount).

### T5.3 — verificación BE focalizada
- [x] `npx jest src/__tests__/infrastructure/adapters/in-memory/InMemoryNews* src/__tests__/application/use-cases/<news> src/__tests__/infrastructure/news*` verdes.
- [x] `npx tsc --noEmit` — 0 errores.

---

## Review fixes (adversarial review — fix wave BE)

TDD estricto (rojo → verde) por fix. `npx prisma generate` corrido fresco antes del `npx tsc
--noEmit` final (race conocido de tipos entre worktrees).

- [x] **M1** — `catch { return null; }` en `PrismaNewsPostRepository.update/setArchived`
  (:71-73,106-108) y `PrismaNewsCategoryRepository.update` (:36-38) mentía 404 ante CUALQUIER
  error (DB caída, P2002/P2003, ...). Fix: solo P2025 → `null`; todo lo demás se re-lanza.
  Tests: `src/__tests__/infrastructure/PrismaNewsPostRepository.test.ts`,
  `PrismaNewsCategoryRepository.test.ts` (mock de Prisma, molde
  `PrismaServiceCatalogRepository.test.ts` FF-2 / `PrismaTaskAttachmentRepository.test.ts`).
- [x] **M2** — `PrismaNewsCategoryRepository.delete` (:41-49) tragaba el P2003 (Restrict) si un
  post nacía entre `countPosts` y el `delete` (TOCTOU) → 204 falso con la categoría VIVA. Fix:
  P2025 → no-op idempotente (molde `PrismaTaskAttachmentRepository`); P2003 →
  `NewsCategoryInUseError` (la ruta ya mapeaba 409); cualquier otro error se re-lanza. Test en
  `PrismaNewsCategoryRepository.test.ts` (describe `.delete`).
- [x] **M3** — `InMemoryNewsCategoryRepository.countPosts` era un seam manual (`postCounts`
  seteado a mano en los tests), sin paridad real con Prisma. Fix: `countPosts` cuenta contra un
  `PostCounter` (interfaz mínima `countByCategoryId`) implementado por
  `InMemoryNewsPostRepository`, wireado post-construcción vía `attachPostRepo` (constructor
  circular — el post repo ya toma el category repo en SU constructor para M4, así que el
  category repo debe existir primero; el link inverso se setea después). Seam `postCounts`
  eliminado del repo y de los 3 tests que lo usaban (`InMemoryNewsCategoryRepository.test.ts`,
  `NewsCategoryUseCases.test.ts`, `news.routes.test.ts`) — ahora crean posts reales.
- [x] **M4** — `InMemoryNewsPostRepository` embebía `category` como snapshot al crear/actualizar;
  Prisma hace `include: { category: true }` en CADA query. Fix: `findById`/`list` resuelven la
  categoría FRESCA contra `categoryRepo` en cada lectura (no confían en el snapshot guardado en
  `items`). Test rojo→verde en `InMemoryNewsPostRepository.test.ts`: crear post → renombrar
  categoría → `findById`/`list` muestran el nombre nuevo.
- [x] **L5** — TOCTOU de `create`/`update` de categoría: un P2002 (UNIQUE name) que pasara la
  validación `findByName` del use case salía como 500 sin mapear. Fix: ambos catchean P2002 →
  `NewsCategoryNameConflictError` (la ruta ya mapeaba 409 vía `instanceof`). Tests en
  `PrismaNewsCategoryRepository.test.ts`.
- [x] **L6** — `CreateNewsCategorySchema.name` sin cota superior. Fix: `.max(60)` (sin valor en
  spec/design — 60 elegido por consistencia con labels cortos tipo chip/settings-list, no texto
  libre como el título de un post). Test 400 en `news.routes.test.ts`.
- [x] **L7** — sin test ejecutable para NEWS-MIG-1. Fix: pin barato
  `src/__tests__/infrastructure/migration.internal_news.test.ts` — escanea
  `20260911000000_internal_news/migration.sql`: sin `DROP` destructivo, `ALTER TABLE` solo
  `ADD CONSTRAINT` (FKs aditivas), y CADA `INSERT` del seed con `ON CONFLICT` en el mismo
  statement. No requirió cambio de código (la migración ya cumplía) — verde inmediato, sirve de
  regresión para sdd-verify.
- [x] **L10** — `InMemoryNewsCategoryRepository.list()` no ordenaba; Prisma usa
  `orderBy: { name: 'asc' }`. Era un one-liner → se fixeó (`.sort` por `name.localeCompare`).
  Test en `InMemoryNewsCategoryRepository.test.ts`.

### Aceptados sin cambio de código (LOWs no accionables en esta wave)
- **L8** — `findByName` es case-insensitive; la letra original de NEWS-PORT-3 decía "case
  exacto". Es MÁS estricto (evita "General"/"general" duplicados) y consistente con el resto del
  código — se aceptó el comportamiento y se actualizó `specs/internal-news-be/spec.md` (NEWS-PORT-3)
  para reflejarlo. Sin cambio de código.
- **L9** — pin textual de mensajes de error: nivel de garantía coherente con el molde de la casa
  (`errors/tickets.ts` et al.) — aceptado sin cambios.


- [ ] `git log origin/main --oneline | rg "sidebar-comunicaciones"` (o PR mergeado) en
  `ipnext-frontend`. Si NO está mergeado → STOP, los batches 6-9 no arrancan.

## Batch 6 — FE: capa de datos (post-merge B)

### T6.1 — tests hooks (RED)
- [ ] `src/__tests__/hooks/useNews.test.ts`: query keys, `useNewsUnreadCount` con
  `refetchInterval` visible?60000:false (molde `useWhatsapp.test.ts`), invalidación de
  `['news']` + `['news','unread-count']` al markRead / crear / editar / archivar.

### T6.2 — implementación (GREEN)
- [ ] `src/types/news.ts` (nuevo contenido — el viejo lo borró B), `src/api/news.api.ts` (axios
  contra `/news`, respuestas raw como `notifications.api.ts`), `src/hooks/useNews.ts` (queries +
  mutations + `useDocumentVisible` para el polling del contador).

## Batch 7 — FE: sidebar + rutas (NEWS-FE-SB-1/2, NEWS-FE-RT-1/2)

### T7.1 — tests (RED)
- [ ] `src/__tests__/layout/Sidebar.test.tsx` (extender): "Noticias" presente con `news.read`,
  ausente sin permiso, "Notificaciones" AUSENTE, badge 3/99+/oculto-en-0.
- [ ] `src/__tests__/routing/App.routing.test.tsx` (extender): `/admin/news` gated `news.read`,
  `/admin/news/settings` gated `news.manage`, `/admin/notifications` sigue montada.

### T7.2 — implementación (GREEN)
- [ ] `Sidebar.tsx`: quitar NavLink Notificaciones (navTop), agregar "Noticias" con gate
  `can('news.read')` (convención isLoading→show) + badge de `useNewsUnreadCount`.
- [ ] `App.tsx`: lazy pages + rutas nuevas con `RequirePermission`.
- [ ] REGRESIÓN: tests existentes de Navbar/notifications verdes SIN modificar (NEWS-FE-RT-2).

## Batch 8 — FE: NewsBoardPage + detalle + modal (NEWS-FE-BD-1..5)

### T8.1 — tests page (RED)
- [ ] `src/__tests__/news/NewsBoardPage.test.tsx`: 4 ramas; orden pinned; destacado no-leída;
  mark-read al abrir UNA vez / no re-marca leída; chips de categoría; toggle archivadas gated
  manage; botón "Nueva noticia" gated manage; body `pre-wrap` sin HTML.
- [ ] `src/__tests__/news/NewsCreateModal.test.tsx`: submit deshabilitado inválido, Select de
  categoría, mapeo 400/409/422, a11y (dialog, Esc, focus), crear feliz + invalidaciones.

### T8.2 — implementación (GREEN)
- [ ] `src/pages/news/NewsBoardPage.tsx` (+ module.css) — estructura del design §9.3; detalle
  drawer keyed por `post.id`; estética la resuelve el apply con ui-ux-pro-max + motion (Emil).
- [ ] Modal crear/editar con Select PROPIO (`components/molecules/Select`) + doble validación.

## Batch 9 — FE: categorías (NEWS-FE-CAT-1)

### T9.1 — tests (RED)
- [ ] `src/__tests__/news/NewsCategoriesBody.test.tsx`: lista con swatch, crear/editar modal,
  409 name-conflict no cierra, delete confirm + 409 in-use muestra mensaje.

### T9.2 — implementación (GREEN)
- [ ] `src/pages/news/settings/NewsCategoriesBody.tsx` + `NewsSettingsPage.tsx` (calco 1:1 de
  `pages/tickets/settings/TicketAreasBody.tsx` + `useConfirm`).

## Batch 10 — verificación final
- [ ] BE: suite completa + `npx tsc --noEmit`.
- [ ] FE: suite completa (incl. regresión Navbar) + typecheck.
- [ ] **E2E en vivo innegociable** (lección e2e-envelope-mock-mismatch): crear noticia real,
  verla en el tablón con otro usuario, badge del sidebar, marcar leída (badge baja), archivar,
  CRUD de categoría, 403 con usuario sin permisos, campanita del header intacta (dropdown +
  "Ver todas" → `/admin/notifications`).
- [ ] sdd-verify contra ambas specs.
