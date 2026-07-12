# Tasks — messaging-inbox-v2 · Grupo B: contexto rico del cliente (F1.5)

> Fase `sdd-tasks`. Fuente: `spec.md` (6 requirements RICH-1..6, 17 test scenarios
> numerados), `design.md` (árbol FE, hook, animaciones), `proposal.md` (use cases
> existentes con file:line). Verificado contra el código REAL de ambos repos
> (no contra los bocetos) antes de escribir este desglose — ver notas de
> implementación inline donde el código real difiere o desambigua algo que
> spec/design dejaban abierto.
>
> Convención de checkbox: cada bloque va en orden TDD estricto — primero el/los
> test(s) marcados **[RED]**, después la implementación **[GREEN]**, y donde
> aplica un paso **[REFACTOR]**. `(#N)` referencia el scenario numerado de
> `spec.md` §"Test scenarios (resumen)".

---

## Backend (`ipnext-backend`)

### B0 — Error nuevo: `CLIENT_ID_NOT_A_CANDIDATE` (RICH-1, scenario #4)

No existe hoy (`errorHandler.ts` statusMap no tiene esta key; `domain/errors/messaging.ts`
solo tiene `ConversationNotFoundError` / `MessagingWindowExpiredError` / `ChatwootUnavailableError`).

- [ ] **[RED]** `src/__tests__/domain/errors/messaging.test.ts` — nuevo `describe('ClientIdNotACandidateError')`:
  el error expone `code: 'CLIENT_ID_NOT_A_CANDIDATE'` y extiende `DomainError`. (#4)
- [ ] **[GREEN]** `src/domain/errors/messaging.ts` — clase `ClientIdNotACandidateError extends DomainError`,
  mensaje tipo `Client "${clientId}" is not a candidate for conversation "${conversationId}"`.
- [ ] **[GREEN]** `src/infrastructure/http/middleware/errorHandler.ts` — agregar
  `CLIENT_ID_NOT_A_CANDIDATE: 400` al `statusMap` (mismo bloque que `CONVERSATION_NOT_FOUND`
  y afines de messaging-inbox).

### B1 — DTOs `InboxClientContextDto` + sub-DTOs (RICH-3)

Sin test unitario propio (el mapeo se cubre por los tests del use case en B2 — mismo
criterio que el resto de `application/dto/messaging.ts`, que hoy no tiene test dedicado).

- [ ] **[GREEN]** `src/application/dto/messaging.ts` — agregar, siguiendo el contrato
  campo-a-campo de `spec.md` §"Contrato — InboxClientContextDto":
  `InboxClientContextDto`, `InboxClientSummaryDto` (con `balance: {due, currency,
  isDebtor, stale, lastRefreshedAt}`), `InboxContractSummaryDto`,
  `InboxInvoiceSummaryDto`, `InboxTicketSummaryDto`, `InboxTaskSummaryDto`,
  `InboxLogSummaryDto`. Reusar `ClientContextClientDto` ya existente (línea 25) para
  `candidates`. **Nunca** incluir `password` en `InboxContractSummaryDto` (RICH-3 #16).

### B2 — Colaborador compartido: extraer TTL de staleness (evita drift RICH-4)

`RefreshClientBalanceIfStale.isStale()` es un método PRIVADO (60min TTL hardcodeado
como default). RICH-4 exige que el endpoint, en el path SIN `?refresh`, calcule
`balance.stale` con la **misma** regla TTL pero **sin invocar** el refresh — si se
duplica el cálculo a mano en el nuevo use case, la regla puede driftear (ej. alguien
cambia el TTL en un lugar y no en el otro). Recomendación (no estaba en spec/design,
lo agrego para blindar la regla): extraer un helper puro y exportado, reusado por
ambos.

- [ ] **[RED]** `src/__tests__/application/RefreshClientBalanceIfStale.test.ts` (si no
  existe, crear) o extender el existente — test de `isBalanceStale(lastBalanceAt,
  ttlMinutes, now)`: `null` → stale; `now - lastBalanceAt > ttlMinutes` → stale;
  dentro de ventana → no stale.
- [ ] **[GREEN]** `src/application/use-cases/RefreshClientBalanceIfStale.ts` — extraer
  la lógica de `private isStale()` a una función pura exportada `isBalanceStale(
  lastBalanceAt: string | null | undefined, ttlMinutes: number, now: () => Date):
  boolean`, y que el método de instancia la delegue (sin cambiar comportamiento ni
  el default de 60min).

### B3 — Use case `GetInboxClientContext` (RICH-1, RICH-2, RICH-3, RICH-4)

Carpeta: `src/application/use-cases/messaging/GetInboxClientContext.ts`.
Test: `src/__tests__/application/messaging/GetInboxClientContext.test.ts` (mismo
directorio que `GetConversation.test.ts` / `GetClientContextByPhone.test.ts`).

**Nota de wiring de dependencias (no estaba explícito en proposal/design — decisión
de diseño de esta fase de tasks):** `GetInboxClientContext` NO debe reusar
`GetClientDetail` tal cual está wireado en `app.ts` hoy (ese `GetClientDetail` ya
tiene un `RefreshClientBalanceIfStale` opcional inyectado en el constructor que se
dispara SIEMPRE que hay `grClienteId` + stale, sin gate por request — eso es
exactamente lo que RICH-4 prohíbe para el path default). En cambio:
- Identidad + balance del mirror: `customerRepo.findById(clientId)` directo (o un
  `GetClientDetail` construido SIN el 2do argumento — sin balanceRefresh — para no
  duplicar la lectura). `balance.stale` se computa con `isBalanceStale` (B2).
- Refresh vivo (`?refresh=true`): invocar `refreshClientBalanceIfStale.execute({
  grClienteId, lastBalanceAt})` (colaborador inyectado, mismo TTL/timeout/swallow de
  siempre) y RE-leer `customerRepo.findById` después si devolvió `true`.
- El match de teléfono (RICH-1) se resuelve reinyectando `GetClientContextByPhone`
  como colaborador (mismo patrón que `GetConversation` ya usa) — NO reimplementar
  `normalizePhone`/`suffixMatch`. Para esto el use case necesita el `contactPhone`
  de la conversación: inyectar `ConversationRepository` y hacer
  `conversationRepo.findById(conversationId)` primero — si es `null`, lanzar
  `ConversationNotFoundError` (ya existe, #6).

Firma propuesta (ajustable en implementación si aparece una razón concreta):
```ts
constructor(
  conversationRepo: ConversationRepository,
  getClientContextByPhone: GetClientContextByPhone,
  customerRepo: CustomerRepository,
  getContracts: GetClientContracts,
  getInvoices: GetClientInvoices,
  getLogs: GetClientLogs,
  listTickets: ListTickets,
  listTasks: ListTasks,
  listPppoeByContract: ListPppoeByContract,
  refreshBalance?: RefreshClientBalanceIfStale,
)
execute(conversationId: string, opts?: { clientId?: string; refresh?: boolean }): Promise<InboxClientContextDto>
```

**Patrón de test (obligatorio, ya establecido por `GetClientDetail.test.ts` /
`GetConversation.test.ts`):** NO existe `InMemoryCustomerRepository` en el repo (el
port `CustomerRepository` no tiene adapter in-memory formal) — el propio código
del repo resuelve esto con un fake hecho a mano que implementa el port completo vía
`jest.fn()` (`makeRepo`/`makeCustomerRepo` helpers). Seguir ESE patrón para
`customerRepo` (no crear un `InMemoryCustomerRepository` nuevo, fuera de alcance de
esta fase). Para `ConversationRepository` SÍ usar `InMemoryConversationRepository`
(existe y ya lo usa `GetConversation.test.ts`). Para tickets/tareas/pppoe SÍ usan
in-memory reales: `InMemoryTicketRepository`, `InMemorySchedulingRepository`,
`InMemoryPppoeServiceRepository` (los tres existen). Ninguno de estos casos
mockea Prisma directamente.

- [ ] **[RED]** test #1 — matched: conversación con match único → `{status:'matched',
  client: <DTO completo>}`.
- [ ] **[RED]** test #2 — ambiguous sin `clientId` → `{status:'ambiguous', candidates}`,
  sin `client`, SIN llamar a ningún colaborador de agregación (no debe fugar datos de
  nadie).
- [ ] **[RED]** test #3 — ambiguous con `clientId` válido (uno de los candidatos) →
  agrega ESE cliente, `status:'matched'`.
- [ ] **[RED]** test #4 — ambiguous con `clientId` ajeno a los candidatos → lanza
  `ClientIdNotACandidateError` (B0), sin invocar ningún colaborador de agregación.
- [ ] **[RED]** test #5 — unknown (sin match) → `{status:'unknown'}`, sin `client`/
  `candidates`.
- [ ] **[RED]** test #6 — `conversationRepo.findById` devuelve `null` → lanza
  `ConversationNotFoundError`.
- [ ] **[RED]** test #7a — 7 tickets abiertos → `recentTickets.length === 3`,
  `openTicketsCount === 7` (vía `countOpenByClientIds`, no vía `.length` del array
  truncado). Nota de implementación: `ListTickets.execute({customerId})` NO filtra
  por "abierto" con un booleano — el catálogo de status es dinámico (string libre).
  Filtrar client-side por el MISMO criterio que `countOpenByClientIds`
  (`resolvedAt == null && archivedAt == null`) antes de `.slice(0,3)`.
- [ ] **[RED]** test #7b — 5 tareas → `recentTasks.length === 3` (`ListTasks` no
  soporta `limit` en su filtro — truncar client-side).
- [ ] **[RED]** test #7c — 12 logs → `recentLogs.length === 5`, primera página.
  `GetClientLogs.execute({clientId, page:1, limit:5})` YA soporta `limit` nativo —
  usar el parámetro, no slicear a mano.
- [ ] **[RED]** test #8 — sin `?refresh`, `lastBalanceAt` de hace 2h (>TTL 60min) →
  `balance.stale === true`, **cero** invocaciones a `refreshBalance.execute` (spy).
- [ ] **[RED]** test #9 — sin `?refresh`, `lastBalanceAt` de hace 10min (<TTL) →
  `balance.stale === false`, cero invocaciones a `refreshBalance.execute`.
- [ ] **[RED]** test #10 — `refresh:true`, `refreshBalance.execute` resuelve `true`
  (GR ok) → re-lee el customer, `balance.stale === false`, valor actualizado.
- [ ] **[RED]** test #11 — `refresh:true`, `refreshBalance.execute` resuelve `false`
  (GR falló/timeout, ya se traga el error puertas adentro) → responde con el balance
  previo, `balance.stale === true`, el use case NUNCA lanza.
- [ ] **[RED]** test #12 — fan-out: un colaborador (ej. `getInvoices`) tarda ~200ms
  (fake con `setTimeout`/jest fake timers) y el resto resuelve sync/rápido → la
  latencia total del `execute()` es ~200ms, NO la suma — assert vía
  `Promise.all`/timing, o vía spy de orden de invocación (todos los `.execute`
  llamados ANTES de que el lento resuelva).
- [ ] **[RED]** test #13 — `listPppoeByContract.execute` (o cualquier colaborador no
  crítico) rechaza para un contrato → esa sección sale `null`/vacía en el DTO
  (`contracts[i].serviceStatus: null` o el contrato se omite — decisión de
  implementación, documentar cuál se eligió), el resto del DTO se completa
  igual, el use case NO relanza.
- [ ] **[RED]** test #16 — cliente con `PppoeService.password` seteado en el fixture →
  `JSON.stringify(result)` NO contiene el valor de esa password en ningún punto del
  árbol (contracts[], ni ningún sub-campo).
- [ ] **[GREEN]** implementar `GetInboxClientContext.ts` completo (fan-out
  `Promise.all` sobre `getContracts`/`getInvoices`/`getLogs`/`listTickets`/
  `listTasks`, y un `Promise.all` interno por contrato para
  `listPppoeByContract`; cada colaborador envuelto en su propio `try/catch` para
  aislar fallas — RICH-2). Mapeo a DTO vía B1.
- [ ] **[GREEN]** resolver ambigüedad de cardinalidad **Contract : PppoeService (1:N)**
  para `InboxContractSummaryDto.serviceStatus` (el DTO pide UN status por contrato,
  pero `ListPppoeByContract` puede devolver varios PPPoE por contrato). No hay regla
  en spec/design. Default recomendado: tomar el PRIMER `PppoeService` devuelto por
  `findByContract` (orden del repo) y mapear con `pppoeDisplayStatus`; si el array
  viene vacío, `serviceStatus: null`. **Marcar explícitamente en el código el
  supuesto** (comentario) para que quede visible si en producción resulta ser el
  criterio equivocado (ej. debería ser "el más severo" en vez de "el primero").
- [ ] **[REFACTOR]** revisar que ningún import de `GetInboxClientContext.ts` venga de
  `infrastructure/` (DIP estricto, CLAUDE.md) — solo domain/application.

### B4 — Endpoint `GET /conversations/:id/client-context` (RICH-1, RICH-5, RICH-6)

`src/infrastructure/http/routes/messaging.routes.ts` — nueva ruta, gated
`perms.read` (`messaging:read`, RICH-5), `next(err)` en el catch (RICH-6, patrón
ROB-1 ya usado por las 4 rutas existentes del mismo router).

**Cambio de firma:** `createMessagingRouter(...)` gana un parámetro nuevo
(`getInboxClientContext: GetInboxClientContext`) — actualizar los 3 call sites:
`app.ts` (B6), `messaging.routes.test.ts` (este bloque) y verificar que
`messaging-composition.test.ts` (que solo lee el código fuente por regex, B6) siga
pasando o extenderlo si hace falta.

- [ ] **[RED]** extender `src/__tests__/infrastructure/messaging.routes.test.ts`:
  - test #6 — `:id` inexistente en el mirror → 404 (`CONVERSATION_NOT_FOUND`).
  - test #14 — sin `messaging:read` (perm denegado) → 403, el use case NUNCA se
    invoca (spy).
  - test #15 — con `messaging:read` (sin ningún otro permiso simulado) → 200 con
    `client.balance`/`client.lastInvoice`/`client.recentTickets`/`client.recentTasks`
    completos.
  - test #17 — `conversationRepo.findById` (o `customerRepo.listActiveContacts`)
    lanza una excepción sincrónica/asíncrona → la respuesta llega con un status de
    error (500 vía `errorHandler` genérico) INMEDIATO, nunca cuelga (assert con
    timeout corto de supertest).
  - test #4 (integración) — `?clientId=<ajeno>` sobre conversación ambigua → 400
    `{code:'CLIENT_ID_NOT_A_CANDIDATE'}`.
  - tests #1/#2/#3/#5 (integración, seam completo con in-memory) — smoke de punta a
    punta de los 3 status.
- [ ] **[GREEN]** actualizar `MessagingRoutePerms`/firma de `createMessagingRouter` +
  implementar la ruta:
  ```ts
  router.get('/conversations/:id/client-context', auth, perms.read,
    async (req, res, next) => {
      try {
        const { clientId, refresh } = req.query as Record<string, string | undefined>;
        const result = await getInboxClientContext.execute(req.params['id'] as string, {
          clientId,
          refresh: refresh === 'true' || refresh === '1',
        });
        res.json(result);
      } catch (err) { next(err); }
    });
  ```
- [ ] **[GREEN]** actualizar `src/__tests__/infrastructure/messaging.routes.test.ts`
  `buildApp()` para instanciar y pasar `GetInboxClientContext` con sus colaboradores
  in-memory (mismo patrón que ya arma `getClientContext`).

### B5 — Composición estática (anti-"wiring roto en silencio", patrón B6 de F1)

- [ ] **[RED]** extender `src/__tests__/infrastructure/messaging-composition.test.ts`:
  nuevas asserts — `GetInboxClientContext` importado, la ruta
  `client-context` está montada dentro de la MISMA llamada a
  `createMessagingRouter(`, y sigue habiendo exactamente un `requirePerm('messaging',
  'read')` cubriendo esa ruta (no uno nuevo de otro módulo — RICH-5, "MUST NOT exigir
  billing:read ni tickets:read").
- [ ] **[GREEN]** `src/infrastructure/http/app.ts`, dentro del bloque `// ─── messaging-inbox (F1) ───` (línea ~2477):
  - instanciar `new GetInboxClientContext(conversationRepo, getClientContextByPhone,
    customerAdapter, getContracts, getInvoices, getLogs, listTickets, listTasks,
    <pppoeRepoLocal>, balanceRefresh)` y pasarlo a `createMessagingRouter(...)`.
  - **Gotcha de scope real (verificado en el código):** `pppoeRepo` (el
    `PrismaPppoeServiceRepository` ya instanciado) vive DENTRO de su propio bloque
    `{ }` (línea 2242, sección "PPPoE management") que se CIERRA antes de llegar al
    bloque de messaging (línea 2477) — no está en scope ahí. Seguir el mismo patrón
    que ya usa `pppoeRepoForInspect` (línea 2396, bloque "airOS inspect"):
    instanciar un **nuevo** `const pppoeRepoForInboxContext = new
    PrismaPppoeServiceRepository();` local al bloque de messaging. `customerAdapter`,
    `getContracts`, `getInvoices`, `getLogs`, `listTickets`, `listTasks`,
    `balanceRefresh` SÍ están en scope (declarados más arriba en el mismo `configure`,
    fuera de cualquier bloque `{}` que los oculte).

---

## Frontend (`ipnext-frontend`)

> Verificado contra el código real de `ipnext-frontend` (branch/worktree
> `feat/messaging-inbox-v2-fe`, hoy al mismo commit que `main` — sin trabajo previo
> de esta fase). `ClientContextPanel` existe HOY en
> `src/pages/whatsapp/WhatsappInboxPage/components/ClientContextPanel.tsx` — es
> presentacional puro, 3 estados (`matched`/`unknown`/`ambiguous`) + 1 neutro sin
> `clientContext`, con 6 tests repartidos en 4 `describe` (`ClientContextPanel.test.tsx`).
> Confirma el punto de partida que asume `design.md`.

### F0 — Tipos DTO (espejo del contrato BE) — bloqueado por B1

- [ ] **[GREEN]** `src/types/whatsapp.ts` — agregar `WhatsappInboxClientContext`,
  `WhatsappInboxClientSummary` (con `balance: {due, currency, isDebtor, stale,
  lastRefreshedAt}`), `WhatsappInboxContract`, `WhatsappInboxInvoice`,
  `WhatsappInboxTicket`, `WhatsappInboxTask`, `WhatsappInboxLog`. Reusar
  `WhatsappClientContextClient` (ya existe, línea 21) para `candidates`. Espejar
  NOMBRES reales del DTO del BE una vez cerrado B1/B3 (no el boceto de `design.md`
  §2) — mismo protocolo que ya siguió F1 (comentario en el propio archivo, línea 1-9).

### F1 — API client (`getInboxClientContext`)

- [ ] **[RED]** extender `src/__tests__/api/whatsapp.api.test.ts` — nuevo caso:
  `getInboxClientContext(conversationId, clientId?, opts?)` hace `GET
  /messaging/conversations/:id/client-context` con `params` armados condicionalmente
  (`clientId` solo si viene, `refresh=1` solo si `opts.refreshBalance`), y
  desenvuelve `r.data` (sin envelope, igual que `getWhatsappConversation`).
- [ ] **[GREEN]** `src/api/whatsapp.api.ts` — agregar `getInboxClientContext`
  (firma tal cual `design.md` §3.3).

### F2 — Hook `useInboxClientContext` (TanStack, SWR 2 fases)

`src/hooks/useWhatsapp.ts` (mismo archivo, convención "4 hooks en un solo archivo"
ya declarada en el header del file).

- [ ] **[RED]** extender `src/__tests__/hooks/useWhatsapp.test.ts`:
  - query primaria: `enabled` solo con `conversationId` truthy; `queryKey` incluye
    `conversationId` + `clientId` (o `'_'` si null); `refetchInterval: false`
    (a diferencia de los otros 3 hooks — el panel NO pollea).
  - query de refresh de balance: `enabled` solo cuando la primaria trajo
    `client.balance.stale === true`; en éxito, PARCHEA solo `balance` en el cache de
    la query primaria (`qc.setQueryData`) sin tocar el resto de `client`.
  - `isRefreshingBalance` refleja `balanceQuery.isFetching`.
- [ ] **[GREEN]** implementar `useInboxClientContext` + la query de background
  (`whatsappClientContextKey` factory + patrón §3.1/§3.2 de `design.md`).

### F3 — Tokens: verde "al día" + fix de contraste en links

`src/tokens/variables.css` — verificado: `--color-primary-hover: #0b5ed7` YA EXISTE
(línea 120) — el fix de contraste de links es solo cambiar el VALOR usado en el CSS
module (F5), no crear un token nuevo. `--badge-paid-*` NO existe — sí hay que
agregarlo.

- [ ] **[GREEN]** agregar al bloque de badges (junto a `--badge-baja-*`, línea ~141):
  `--badge-paid-bg: #dcfce7; --badge-paid-fg: #166534;`.
- [ ] **Ambigüedad a resolver antes de F6 (no la resuelve `design.md`):** el átomo
  compartido `src/components/atoms/StatusBadge/StatusBadge.tsx` tiene un union
  CERRADO de 5 status (`active|late|blocked|inactive|baja`, sin variante verde) — no
  soporta "al día" hoy. Decisión pendiente: (a) agregar una 6ta variante `paid` al
  átomo compartido (afecta a todo consumidor de `StatusBadge`, blast radius mayor), o
  (b) renderizar un pill LOCAL en `FinancialSection` con los tokens nuevos, sin tocar
  el átomo compartido (contenido, blast radius menor). **Recomendado: (b)** — el
  balance "al día" es un concepto específico de este panel, no un `CustomerStatus`
  reusable; agregarlo al átomo compartido infla su superficie para un solo consumidor.

### F4 — Rediseño `ClientContextPanel` → container fino + presentacionales

Carpeta nueva: `src/pages/whatsapp/WhatsappInboxPage/components/clientContext/`.
Preservar el contrato de los 6 `it` actuales en `ClientContextPanel.test.tsx`
(matched/unknown/ambiguous/ausente×3) — **[RED] primero extenderlos**, no borrarlos.

- [ ] **[RED]** extender `ClientContextPanel.test.tsx` (o separar en
  `ClientContextPanel.container.test.tsx` si el archivo crece demasiado — decisión
  de implementación) con los 6 casos EXISTENTES intactos + nuevos:
  - `ambiguous` sin elección → renderiza `CandidatePicker`, NO dispara
    `useInboxClientContext` (mock del hook, assert `enabled`/no-llamada).
  - elegir un candidato (`onChoose`) → dispara el hook con ese `clientId`.
  - `matched` con `useInboxClientContext` en `isLoading` → `ContextSkeleton`.
  - `matched` con `data` → `MatchedClientView` con las 4 secciones.
  - `isError` sin cache → `ContextError` + botón "Reintentar" invoca `refetch`.
  - `isError` CON cache previa → mantiene contenido + chip "no se pudo actualizar".
- [ ] **[RED]** tests unitarios por presentacional (RTL, un test file por componente,
  patrón del repo) en `clientContext/`: `IdentityHeader`, `FinancialSection`
  (incluye el caso `isDebtor`/`al día`/`due==null` de §5.2, más un
  `.contrast.test.tsx` para el rojo `--badge-late-fg` y el verde nuevo
  `--badge-paid-fg`, mismo patrón que `MessageBubble.contrast.test.tsx`),
  `ServiceSection`, `InteractionsSection`, `CandidatePicker`, `ContextSkeleton`,
  `ContextNeutral`, `ContextError`.
- [ ] **[GREEN]** implementar los 9 presentacionales en `clientContext/` (§1/§5 de
  `design.md`).
- [ ] **[GREEN]** reescribir `ClientContextPanel.tsx` como container fino: recibe
  `conversationId` + `lightContext` (2 props, ver F6), estado local `chosenId`,
  llama `useInboxClientContext`, switch de estados → delega en los presentacionales.
- [ ] **[GREEN]** reescribir `ClientContextPanel.module.css` con prefijos por sección
  (`id-`/`fin-`/`svc-`/`int-`/`cand-`/`sk-`/`st-` — gotcha `classNameStrategy:
  'non-scoped'` de Vitest, verificado en `vite.config.ts:22`), aplicar el fix de
  contraste de links (usar `--color-primary-hover` en vez de `--color-primary`) y
  las animaciones §8 de `design.md` (incl. bloque `prefers-reduced-motion`).

### F5 — Wiring en `WhatsappInboxPage.tsx`

- [ ] **[RED]** extender `src/__tests__/whatsapp/WhatsappInboxPage.test.tsx` — el
  panel recibe `conversationId={selectedId}` y `lightContext={detail?.clientContext}`
  (mock de `useWhatsappConversation`).
- [ ] **[GREEN]** pasar las 2 props nuevas desde `WhatsappInboxPage.tsx` al
  `ClientContextPanel`.

---

## Dependencias entre tracks

- **BE y FE pueden avanzar en paralelo** contra el contrato ya congelado en
  `spec.md` (DTO + endpoint) — no hace falta esperar a que termine el otro para
  arrancar tests/skeletons.
- **F0 (tipos FE) depende del contrato final de B1/B3** — si `sdd-apply` del BE
  renombra o ajusta un campo del DTO real (siempre puede pasar, ya ocurrió en F1 con
  `clients` vs `candidates`), F0 se alinea DESPUÉS, no antes.
- **F2 (hook)** depende de F1 (API client) y del comportamiento real de
  `?refresh=true` del BE (B4) — si el BE NO expone el modo 2-fases tal cual, F2 cae
  al fallback de 1 query que ya prevé `design.md` §3.2.
- **B5 (wiring app.ts)** depende de B3+B4 completos (necesita la clase
  `GetInboxClientContext` y la firma final de `createMessagingRouter`).
- Dentro de BE: **B0 y B1 no tienen dependencias entre sí** (pueden ir en cualquier
  orden o en paralelo) — ambos son prerequisito de B3. **B2** (extracción del TTL
  helper) es prerequisito de B3 pero independiente de B0/B1.
- Dentro de FE: **F3 (tokens) no depende de nada** — puede ir primero. **F4** depende
  de F0 (tipos) y F2 (hook, aunque sea mockeado en los tests del container). **F5**
  depende de F4.
