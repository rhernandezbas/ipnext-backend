# Spec (delta) — messaging-inbox-v2 · Grupo B: contexto rico del cliente (F1.5)

RFC-2119. Mismo estilo que `openspec/specs/messaging-inbox/spec.md` (F1). Cada
scenario cubierto por al menos un test verde (sdd-verify), in-memory ports, sin
mockear Prisma.

> Alcance: SOLO el agregador de contexto rico (`GetInboxClientContext` + endpoint
> `client-context`). No modifica `CTX-1`/`CTX-2` (match liviano por teléfono),
> `GetConversation`, el webhook ni el mirror — son requirements NUEVOS (`ADDED`),
> no hay `MODIFIED`/`REMOVED` sobre el spec F1 existente.

## ADDED Requirements

### Requirement: RICH-1 — endpoint scopeado por conversación, no por clientId pelado
`GET /api/messaging/conversations/:id/client-context` MUST re-resolver el match de
teléfono de esa conversación (misma lógica que CTX-1, normalización + `suffixMatch`
contra `listActiveContacts()`) como fuente de autoridad — MUST NOT aceptar un
`clientId` arbitrario sin conversación como único input.

#### Scenario: matched — un único candidato
- GIVEN una conversación cuyo contacto matchea exactamente un `Client` activo
- WHEN se pide `GET .../:id/client-context`
- THEN responde `{ status: 'matched', client: InboxClientSummaryDto }` con el
  agregado completo de ese cliente

#### Scenario: ambiguous sin `clientId` — no agrega, devuelve candidatos
- GIVEN una conversación cuyo contacto matchea 2+ clientes activos
- WHEN se pide el endpoint sin `?clientId`
- THEN responde `{ status: 'ambiguous', candidates: [{id,name,status}] }`, SIN
  campo `client` (no agrega datos de nadie hasta que el agente elige)

#### Scenario: ambiguous con `clientId` válido — agrega el candidato elegido
- GIVEN una conversación ambigua con candidatos `[A, B]`
- WHEN se pide el endpoint con `?clientId=A`
- THEN el BE valida que `A` esté entre los candidatos y responde
  `{ status: 'matched', client: <agregado de A> }`

#### Scenario: ambiguous con `clientId` ajeno a los candidatos — rechazo, sin fuga
- GIVEN una conversación ambigua con candidatos `[A, B]`
- WHEN se pide el endpoint con `?clientId=Z` (Z no es candidato de esa conversación)
- THEN responde 400 `{ code: 'CLIENT_ID_NOT_A_CANDIDATE' }` sin agregar ni exponer
  datos de `Z` (evita que `messaging:read` se use para leer cualquier cliente por id)

#### Scenario: unknown — sin match
- GIVEN una conversación cuyo contacto no matchea ningún cliente activo
- WHEN se pide el endpoint
- THEN responde 200 `{ status: 'unknown' }`, sin `client` ni `candidates`

#### Scenario: conversación inexistente
- GIVEN un `:id` que no existe en el mirror
- WHEN se pide el endpoint
- THEN responde 404

### Requirement: RICH-2 — fan-out en paralelo hacia use cases existentes
`GetInboxClientContext` MUST orquestar, vía `Promise.all` (nunca en serie), los use
cases ya probados (`GetClientDetail`, `GetClientContracts`, `GetClientInvoices`,
`ListPppoeByContract` por contrato, `ListTickets({customerId})`,
`ListTasks({customerId})`, `GetClientLogs({clientId})`) — MUST depender solo de
ports/use cases (hexagonal estricto), nunca importar Prisma directamente.

#### Scenario: un colaborador lento no serializa a los demás
- GIVEN 6 colaboradores donde uno (balance) tarda ~4s y el resto responde en ms
- WHEN se agrega el contexto de un cliente `matched`
- THEN la latencia total del endpoint es la del colaborador más lento (~4s), no
  la suma de los 6

#### Scenario: un colaborador falla — no tumba todo el panel
- GIVEN `ListPppoeByContract` (o cualquier colaborador no crítico) lanza una excepción
- WHEN se agrega el contexto
- THEN el agregador NO propaga esa excepción como 500 total: la sección afectada
  se sirve vacía/`null` y el resto del DTO se completa igual (falla aislada, no total)

### Requirement: RICH-3 — DTO agregado con límites, sin entidades crudas ni secretos
`InboxClientContextDto` MUST truncar cada sección a un límite fijo — 3 tickets
abiertos, 3 tareas, 5 logs, 1 última factura + 1 próximo vencimiento — con un
contador total aparte donde aplique (`openTicketsCount`). MUST NOT incluir
`password` de PPPoE, ni ninguna entidad Prisma cruda.

#### Scenario: más de 3 tickets abiertos — trunca pero cuenta el total
- GIVEN un cliente con 7 tickets abiertos
- WHEN se agrega su contexto
- THEN `recentTickets` trae como máximo 3 y `openTicketsCount` es 7

#### Scenario: más de 5 logs — trunca a 5, primera página
- GIVEN un cliente con 12 logs
- WHEN se agrega su contexto
- THEN `recentLogs` trae exactamente los 5 más recientes (primera página)

#### Scenario: nunca se filtra la password de PPPoE
- GIVEN un cliente con contrato(s) que tienen `PppoeService.password` en el dominio
- WHEN se agrega su contexto
- THEN ningún campo del DTO (`contracts[]` ni ninguna sub-sección) contiene la
  password, aunque el use case subyacente la haya leído internamente

### Requirement: RICH-4 — balance stale-while-revalidate (instantáneo por defecto)
El endpoint, por defecto (SIN `?refresh=true`), MUST devolver el balance leído del
mirror (`Customer.balanceDue`/`balanceCurrency`/`lastBalanceAt`) SIN awaitear
`RefreshClientBalanceIfStale` (SIN llamar a GR) — `balance.stale` se calcula con la
MISMA regla TTL (60 min, o `null` → stale) usada por ese colaborador, pero
evaluada localmente, no invocada. Con `?refresh=true`, el endpoint MUST invocar el
refresh (equivalente a `RefreshClientBalanceIfStale.execute`, hasta ~4s,
TTL-gated) y responder con el resultado post-refresh.

#### Scenario: apertura por defecto — instantáneo, posible stale
- GIVEN un cliente cuyo `lastBalanceAt` es de hace 2 horas (> TTL 60min)
- WHEN se pide el endpoint SIN `?refresh`
- THEN responde en ms (sin llamar a GR — 0 invocaciones al `GestionRealPort`) con
  el balance guardado y `balance.stale: true`

#### Scenario: refresh explícito — trae balance fresco
- GIVEN el mismo cliente stale del scenario anterior
- WHEN el FE dispara `GET .../client-context?refresh=true` en background
- THEN el sistema llama a GR (hasta ~4s), persiste el nuevo balance en el mirror y
  responde con el valor actualizado y `balance.stale: false`

#### Scenario: refresh explícito pero GR falla — no rompe, sigue stale
- GIVEN GR está caído o timeoutea
- WHEN se pide `?refresh=true`
- THEN el error se traga (igual que `RefreshClientBalanceIfStale` hoy), responde
  200 con el balance previo del mirror y `balance.stale: true` (nunca 500)

#### Scenario: balance fresco (dentro de TTL) — stale false sin refrescar
- GIVEN `lastBalanceAt` de hace 10 minutos (< TTL)
- WHEN se pide el endpoint SIN `?refresh`
- THEN responde con `balance.stale: false` sin llamar a GR

### Requirement: RICH-5 — RBAC: `messaging:read` alcanza, sin permisos de otros módulos
El endpoint MUST requerir únicamente `messaging:read` (mismo guard `perms.read` de
INBOX-1/2/3) para servir identidad, deuda, facturas resumidas, contratos, estado de
servicio, tickets/tareas/logs recientes. MUST NOT exigir `billing:read` ni
`tickets:read` adicionales.

#### Scenario: sin `messaging:read` — 403
- GIVEN un usuario autenticado sin `messaging:read`
- WHEN pide `GET .../client-context`
- THEN responde 403 sin efectos

#### Scenario: solo con `messaging:read` — 200 con datos financieros/tickets
- GIVEN un usuario con `messaging:read` pero SIN `billing:read` ni `tickets:read`
- WHEN pide el endpoint sobre un cliente `matched`
- THEN responde 200 con `balance`, `lastInvoice`, `recentTickets`, `recentTasks`
  completos (el permiso de messaging es suficiente; el detalle fino queda para la
  ficha completa, fuera de este endpoint)

### Requirement: RICH-6 — robustez, ninguna ruta cuelga (mismo patrón ROB-1)
El handler async de `client-context` MUST responder con un status inmediato ante
cualquier error no aislado a una sección (repo caído, error de parseo de
`clientId`), vía `next(err)`, nunca dejar el request colgado.

#### Scenario: el repo de clientes lanza al resolver el match
- GIVEN `CustomerRepository.listActiveContacts()` (o `findById`) lanza
- WHEN se ejecuta el handler
- THEN responde con un status de error inmediato (`next(err)`), nunca cuelga

## Contrato — `InboxClientContextDto` (`src/application/dto/messaging.ts`)

| Campo | Tipo | Notas |
|---|---|---|
| `status` | `'matched' \| 'ambiguous' \| 'unknown'` | — |
| `candidates?` | `{id,name,status}[]` | solo `ambiguous` sin `clientId` elegido |
| `client?` | `InboxClientSummaryDto` | `matched`, o candidato ya elegido |

**`InboxClientSummaryDto`**

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `string` | — |
| `name` | `string` | — |
| `email` | `string \| null` | — |
| `phone` | `string \| null` | — |
| `status` | `CustomerStatus` | `active\|late\|blocked\|inactive\|baja` |
| `fichaClientId` | `string` | el FE arma la ruta a la ficha existente |
| `balance.due` | `number \| null` | del mirror |
| `balance.currency` | `string \| null` | — |
| `balance.isDebtor` | `boolean` | `due != null && due > 0` |
| `balance.stale` | `boolean` | TTL 60min sobre `lastRefreshedAt`, RICH-4 |
| `balance.lastRefreshedAt` | `string \| null` | ISO |
| `lastInvoice` | `InboxInvoiceSummaryDto \| null` | 1 sola, la más reciente |
| `nextDueDate` | `string \| null` | de la próxima factura pendiente |
| `contracts` | `InboxContractSummaryDto[]` | sin límite N (cardinalidad chica, 1-2) |
| `openTicketsCount` | `number` | contador total, vía `countOpenByClientIds` |
| `recentTickets` | `InboxTicketSummaryDto[]` | máx 3, abiertos |
| `recentTasks` | `InboxTaskSummaryDto[]` | máx 3 |
| `recentLogs` | `InboxLogSummaryDto[]` | máx 5, primera página |

**`InboxContractSummaryDto`**: `id, plan, status, technology: string\|null, address: string\|null, serviceStatus: 'active'\|'reduced'\|'blocked'\|'baja'\|'inactive'\|null` (de `pppoeDisplayStatus`, mirror only — sin RADIUS, sin "online ahora").

**`InboxInvoiceSummaryDto`**: `id, number, dueDate, amount, status: 'pagada'\|'pendiente'\|'vencida', balance: number\|null`.

**`InboxTicketSummaryDto`**: `id, sequenceNumber, subject, status, priority`.
**`InboxTaskSummaryDto`**: `id, sequenceNumber, title, status`.
**`InboxLogSummaryDto`**: `id, timestamp, eventType, description`.

**Nunca**: `password` de PPPoE, entidades Prisma crudas, datos de candidatos no elegidos en `ambiguous`.

## Contrato — endpoint

```
GET /api/messaging/conversations/:id/client-context?clientId=<id>&refresh=true
```

- Auth: `auth` + `perms.read` (`messaging:read`) — igual que INBOX-1/2/3.
- `:id`: id de la conversación en el mirror (autoridad del match).
- `?clientId`: opcional, solo usado para desambiguar `ambiguous`; MUST validarse
  contra los candidatos del teléfono antes de agregar.
- `?refresh=true|1`: opcional, dispara el refresh vivo de balance (RICH-4). Sin
  el flag, el balance es del mirror, instantáneo.
- Respuestas: 200 (`matched`/`ambiguous`/`unknown`), 400
  (`CLIENT_ID_NOT_A_CANDIDATE`), 401 (sin sesión), 403 (sin `messaging:read`),
  404 (conversación inexistente).

## Test scenarios (resumen para sdd-tasks/sdd-apply, strict TDD)

1. matched — agrega y devuelve DTO completo.
2. ambiguous sin clientId — candidatos, sin client.
3. ambiguous con clientId válido — agrega ese candidato.
4. ambiguous con clientId ajeno — 400 `CLIENT_ID_NOT_A_CANDIDATE`, sin fuga.
5. unknown — 200 sin client/candidates.
6. conversación inexistente — 404.
7. límites: >3 tickets → trunca + `openTicketsCount` real; >3 tareas → trunca; >5 logs → trunca a 5.
8. balance sin `?refresh`, stale (>60min o null) → `stale:true`, 0 llamadas a GR.
9. balance sin `?refresh`, fresco (<60min) → `stale:false`, 0 llamadas a GR.
10. balance con `?refresh=true` y GR ok → balance actualizado, `stale:false`.
11. balance con `?refresh=true` y GR falla → 200, balance previo, `stale:true` (no 500).
12. fan-out en paralelo — un colaborador lento no serializa (latencia ≈ max, no suma).
13. un colaborador falla (no balance) → sección aislada, resto del DTO completo.
14. RBAC — sin `messaging:read` → 403.
15. RBAC — solo `messaging:read` (sin billing/tickets:read) → 200 con datos completos.
16. no fuga de `password` de PPPoE en ningún sub-DTO.
17. handler no cuelga si el repo de clientes lanza — `next(err)`.
