# Proposal — messaging-inbox-v2 · Grupo B: Contexto rico del cliente (F1.5)

> Alcance de ESTE proposal: **SOLO Grupo B** (contexto rico del cliente cuando el
> teléfono matchea un `Client`). Los Grupos A (media), C (productividad) y D (rich UX)
> son fases aparte y NO se tocan acá.
>
> Principio de arquitectura (fijado por el arquitecto, NO negociable): **el panel de
> contexto es un RESUMEN ACCIONABLE, no un clon de la ficha del cliente.** Muestra lo
> justo para atender el chat (¿debe plata? ¿qué plan? ¿tickets abiertos? ¿estado del
> servicio?) + **links a la ficha completa que YA existe en Prominense**. Traemos
> resúmenes / últimos-N con límites, nunca listas completas.

---

## Why

Hoy, cuando el teléfono de una conversación matchea un cliente, el panel FE
(`ClientContextPanel`) muestra únicamente **nombre + link "Ver perfil →"**. El agente
que atiende el WhatsApp no ve NADA de lo que necesita para resolver el chat sin saltar
de pantalla: si el cliente debe plata, qué plan tiene, si el servicio está cortado, si
ya tiene tickets abiertos. Esto es exactamente lo que Chatwoot **no puede** dar — es un
helpdesk genérico que no conoce PPPoE / Gestión Real / facturación. Es EL diferenciador
de Prominense.

La buena noticia (verificada, ver matriz abajo): el BE ya tiene, probados en prod, TODOS
los use cases para traer deuda, contratos, facturas, tickets, tareas y logs por cliente.
El match por teléfono (`GetClientContextByPhone`, CTX-1) ya resuelve el `clientId`. Lo
único que falta es **un agregador** que junte esos datos en un resumen y un canal para
exponerlo sin penalizar el hot path del inbox.

---

## What changes

### Backend

1. **Nuevo use case `GetInboxClientContext`** en `src/application/use-cases/messaging/`.
   - Entrada: `clientId` (ya resuelto por el match) — opcionalmente scopeado por
     `conversationId` para re-validar el match (ver Decisión 3).
   - Orquesta, en paralelo (`Promise.all`), use cases YA existentes:
     - `GetClientDetail` → identidad + `balanceDue` / `balanceCurrency` / `balanceStale`.
     - `GetClientContracts` → plan / estado / tecnología por contrato.
     - `GetClientInvoices` → última factura + próximo vencimiento (resumen, no la lista).
     - `ListTickets({ customerId })` → tickets abiertos (count + últimos N).
     - `ListTasks({ customerId })` → últimas N tareas / OS.
     - `GetClientLogs({ clientId })` → últimos N logs (primera página).
     - `ListPppoeByContract(contractId)` por cada contrato → estado del servicio
       (`pppoeDisplayStatus`), CHEAP (solo mirror).
   - Mapea TODO a un DTO agregado con límites (`take N`), nunca entidades crudas.
   - Depende SOLO de ports / use cases (hexagonal estricto). Password de PPPoE se
     descarta al mapear (nunca sale del DTO).

2. **Nuevo DTO `InboxClientContextDto`** (+ sub-DTOs) en `src/application/dto/messaging.ts`.

3. **Nuevo endpoint LAZY** (NO se infla el detail):
   `GET /api/messaging/conversations/:id/client-context`
   gated por `messaging:read`, `next(err)` en todo handler async (ROB-1 / lección 504).

4. **Wiring** en `src/infrastructure/http/app.ts`: instanciar `GetInboxClientContext`
   con los adapters ya existentes (`customerAdapter`, `ticketAdapter`, `schedulingRepo`,
   `pppoeRepo`, `getDetail`/`balanceRefresh`) y pasarlo al router de messaging.

5. **Sin cambios de schema Prisma. Sin cambios en el pipeline de webhook / fetch-on-open.**
   No se toca `GetConversation`, `ReceiveChatwootWebhook`, ni el mirror. Cero riesgo de
   regresión sobre lo que ya está en prod de F1.

### Frontend (solo se describe — el diseño es otra fase, `sdd-design`)

Rediseño de `ClientContextPanel.tsx`: de 3 estados chicos (avatar + nombre + link) a un
panel con secciones — **Identidad**, **Financiero** (deuda + última factura + próximo
vencimiento), **Servicio** (plan + estado PPPoE), **Interacciones** (tickets abiertos,
tareas, logs) — cada una con su link a la ficha completa. Preserva `matched` / `ambiguous`
/ `unknown`; en `ambiguous` muestra el selector de candidatos ANTES de pedir el detalle.
Puede clonar visualmente `CustomerCard.tsx` (patrón "ContactRow" + loading states).

---

## Impact

| Área | Cambio | Riesgo de regresión |
|---|---|---|
| `application/use-cases/messaging/GetInboxClientContext.ts` | **NUEVO** | ninguno (código nuevo) |
| `application/dto/messaging.ts` | +`InboxClientContextDto` y sub-DTOs | ninguno (aditivo) |
| `infrastructure/http/routes/messaging.routes.ts` | +1 ruta GET `client-context` | bajo (ruta nueva, no toca las existentes) |
| `infrastructure/http/app.ts` | +wiring | bajo |
| `GetClientContextByPhone` / `GetConversation` | **sin cambios** | — |
| Webhook / mirror / schema Prisma | **sin cambios** | — |
| FE `ClientContextPanel.tsx` | rediseño (otra fase) | contenido en el FE |

Use cases REUTILIZADOS sin modificar: `GetClientDetail`, `GetClientContracts`,
`GetClientInvoices`, `GetClientLogs`, `ListTickets`, `ListTasks`, `ListPppoeByContract`.

---

## Matriz de datos — confirmado-existente vs no-disponible

**CONFIRMADO (existe, con use case + file:line):**

| Dato | Use case | Entidad / campos | Ref |
|---|---|---|---|
| Identidad (nombre, email, teléfono, estado) | `GetClientDetail.execute(id)` → `Customer` | `name`, `email`, `phone`, `status` (`active`\|`late`\|`blocked`\|`inactive`\|`baja`) | `GetClientDetail.ts:11`, `customer.ts:10-37` |
| Deuda / balance | `GetClientDetail` (refresh on-demand vía `RefreshClientBalanceIfStale` si hay `grClienteId`, TTL-gated, nunca tira) | `balanceDue` (number\|null), `balanceCurrency`, `balanceStale`, `lastBalanceAt` | `GetClientDetail.ts:20-30`, `customer.ts:24-32` |
| Facturas (última + estado + vencimiento) | `GetClientInvoices.execute(clientId)` → `Invoice[]` | `number`, `issueDate`, `dueDate`, `amount`, `status` (`pagada`\|`pendiente`\|`vencida`), `balance`, `pdfUrl`, `paymentUrl` | `GetClientInvoices.ts:7`, `billing.ts:10-34` |
| Contratos / plan / servicio | `GetClientContracts.execute(clientId)` → `Contract[]` | `plan`, `status`, `type`, `technology`, `code`, `address`, `services[]` | `GetClientContracts.ts:7`, `customer.ts:55-82` |
| Estado del servicio PPPoE (corte) | `ListPppoeByContract.execute(contractId)` + `pppoeDisplayStatus(status, enforcedState)` | `active`\|`reduced`\|`blocked`\|`baja`\|`inactive` (deriva de mirror, CHEAP, sin RADIUS) | `ListPppoeByContract.ts:8`, `pppoeService.ts:38-44` |
| Tickets abiertos (count + últimos N) | `ListTickets.execute({ customerId, status? })` — filtro `customerId` REAL | `subject`, `status`, `priority`, `sequenceNumber`, `resolvedAt`; count barato vía `countOpenByClientIds` | `ListTickets.ts:8`, `TicketRepository.ts:9,70`, `ticket.ts:10-38` |
| Tareas / OS del cliente (últimas N) | `ListTasks.execute({ customerId })` — filtro `customerId` CONFIRMADO en el schema del filtro | `ScheduledTask[]` | `ListTasks.ts:8`, `scheduling.dto.ts:185` |
| Logs / bitácora (últimos N) | `GetClientLogs.execute({ clientId, page, limit })` → `PaginatedResult<ClientLog>` | `timestamp`, `eventType`, `description` | `GetClientLogs.ts:8`, `customer.ts:84-89` |
| Comentarios (opcional) | `GetClientComments` (existe, no verificado a fondo) | — | — |

**NO DISPONIBLE / fuera de MVP (marcado explícito para no prometer humo):**

| Dato | Por qué no | Decisión |
|---|---|---|
| Última conexión / online en tiempo real (PPPoE) | El único camino es `ListRadiusSessions`, que hace `repo.listSessions()` de TODAS las sesiones (potencialmente miles) y filtra en memoria — NO hay query por cliente. Llamarlo en cada apertura de panel es carísimo. | **Fuera de MVP.** Opcional en una v2 como botón on-demand ("ver conexión") o chip lazy separado. Ref: `ListRadiusSessions.ts:60-70`. El estado de CORTE (active/reduced/blocked) SÍ va, vía `pppoeDisplayStatus` sobre el mirror (barato) — cubre el "¿está cortado?" sin RADIUS. |
| Nodo / sitio nombrado | No hay un campo limpio "nodo". Solo `Contract.address` y `PppoeService.nasId` (FK a router, no un nombre de nodo presentable). | **Parcial.** Mostramos `Contract.address` como ubicación. "Nodo" nombrado queda fuera de MVP. |

---

## Decisiones tomadas + justificación

### Decisión 1 — Agregador único, SÍ; pero como endpoint LAZY separado, NO inline en el detail

**Recomendación: agregador único (`GetInboxClientContext`) expuesto en un endpoint
nuevo y lazy — NO extender `ConversationDetailDto.clientContext` con el detalle rico.**

Justificación (hay un costo REAL medido en el código, no es preferencia estética):

- `GetConversation` (el detail) ya hace **fetch-on-open**: sincroniza contra Chatwoot en
  CADA apertura (`GetConversation.ts:36`). Es el hot path del inbox.
- `GetClientDetail` con `balanceRefresh` **AWAITEA una llamada viva a Gestión Real de
  hasta 4s** (timeoutMs default) cuando el balance está stale (`GetClientDetail.ts:20-30`).
- Inlinear el agregador en el detail sumaría 6 queries de cliente + hasta 4s de GR a CADA
  apertura de conversación — incluso a las `unknown`/`ambiguous` donde no hay nada que
  agregar. El propio código de F1 ya se blinda contra esto (comentario "never per row",
  guard anti-N+1 en `GetConversation.ts:29`). Inlinear rompería esa garantía.
- El panel rico solo se necesita cuando hay **match**, y aun así el agente puede no
  necesitarlo de inmediato. Un segundo request lazy lo trae solo cuando corresponde.

Por eso: **`GetClientContextByPhone` se queda LIVIANO** (solo el match, tal cual hoy) e
inline en el detail — el panel sabe `matched`/`ambiguous`/`unknown` + `clientId` al toque
y barato. El **detalle rico** se pide en un segundo request contra el nuevo endpoint.

Acotamiento de costo (si algún día pesa): límites `take N` en cada sección (facturas,
tickets, tareas, logs); `Promise.all` para que la latencia total sea la del más lento (el
balance de 4s) y no la suma; y la opción de v2 lazy-por-sección si el balance-refresh
molesta (ver Decisión 2).

### Decisión 2 — El agregador reutiliza `GetClientDetail` CON balance-refresh (deuda precisa)

Al ser lazy y on-demand (el agente abrió el panel del cliente porque quiere saber si
debe), vale la pena la deuda PRECISA. Reusamos `GetClientDetail` con `RefreshClientBalanceIfStale`:
es TTL-gated (solo la primera apertura por ventana paga los ~4s), y los errores/timeouts
se tragan (nunca rompe el panel). **Decisión abierta menor** (ver abajo): si el arquitecto
prefiere latencia sobre precisión, se lee el mirror sin refresh (instantáneo, posible
stale con badge "desactualizado").

### Decisión 3 — Endpoint scopeado por conversación, con `clientId` opcional para desambiguar

`GET /api/messaging/conversations/:id/client-context`:
- **matched** → el BE re-resuelve el único match desde el teléfono de la conversación y
  agrega. La autoridad del match queda en el BE (el FE no puede pedir un `clientId`
  arbitrario y sacar datos financieros de cualquiera vía permiso de messaging).
- **ambiguous** → acepta `?clientId=<candidato>`; el BE valida que ese id esté entre los
  candidatos del teléfono ANTES de agregar. Sin `clientId` → devuelve la lista de
  candidatos para que el FE muestre el selector (no agrega todavía).
- **unknown** → 200 con `{ status: 'unknown' }`.

Se prefiere sobre un `GET /api/messaging/client-context/:clientId` "pelado" porque
mantiene el acceso **dentro del dominio RBAC de messaging** y con el match como fuente de
verdad, evitando que `messaging:read` se convierta en un lector universal de fichas de
clientes por id arbitrario.

### Decisión 4 — Un solo request al expandir (no 6 desde el FE)

El FE dispara UN request al endpoint lazy; el BE hace el fan-out interno con `Promise.all`.
Evita 6 round-trips + 6 spinners en el panel y centraliza los límites/mapeos en el BE.

---

## Contrato propuesto — `InboxClientContextDto`

En `src/application/dto/messaging.ts` (application PUEDE importar tipos de domain; nunca
Prisma crudo). Bosquejo (el spec afinará campos y límites):

```ts
export interface InboxClientContextDto {
  status: 'matched' | 'ambiguous' | 'unknown';
  candidates?: ClientContextClientDto[];   // solo ambiguous sin clientId elegido
  client?: InboxClientSummaryDto;          // matched, o candidato elegido
}

export interface InboxClientSummaryDto {
  // Identidad
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: CustomerStatus;                  // active|late|blocked|inactive|baja
  fichaClientId: string;                   // el FE arma la ruta a la ficha existente
  // Financiero (resumen accionable)
  balance: {
    due: number | null;
    currency: string | null;
    isDebtor: boolean;                     // due != null && due > 0
    stale: boolean;
    lastRefreshedAt: string | null;
  };
  lastInvoice: InboxInvoiceSummaryDto | null;
  nextDueDate: string | null;              // de la próxima factura pendiente
  // Servicio
  contracts: InboxContractSummaryDto[];    // resumen: plan/status/technology/address + serviceStatus PPPoE
  // Interacciones (contadores + últimos N)
  openTicketsCount: number;
  recentTickets: InboxTicketSummaryDto[];  // últimos ~3 abiertos + link
  recentTasks: InboxTaskSummaryDto[];      // últimas ~3 tareas/OS + link
  recentLogs: InboxLogSummaryDto[];        // últimos ~5 logs
}

export interface InboxContractSummaryDto {
  id: string;
  plan: string;
  status: string;
  technology: string | null;
  address: string | null;
  serviceStatus: 'active' | 'reduced' | 'blocked' | 'baja' | 'inactive' | null; // PPPoE display, CHEAP
}

export interface InboxInvoiceSummaryDto {
  id: string; number: string; dueDate: string; amount: number;
  status: 'pagada' | 'pendiente' | 'vencida'; balance: number | null;
}
export interface InboxTicketSummaryDto {
  id: string; sequenceNumber: number; subject: string; status: string; priority: string;
}
export interface InboxTaskSummaryDto { id: string; sequenceNumber: number; title: string; status: string; }
export interface InboxLogSummaryDto { id: string; timestamp: string; eventType: string; description: string; }
```

Los `id` en cada sub-DTO alimentan los links a la ficha existente (Decisión de diseño:
el FE construye las rutas). Nunca se devuelve `password` de PPPoE ni entidades Prisma.

---

## Riesgos

- **Latencia del balance-refresh (≤4s, TTL-gated).** Mitigado: lazy (fuera del hot path),
  `Promise.all`, errores tragados. Si molesta → Decisión abierta A (sin refresh).
- **Fan-out de queries por cliente.** 1 cliente ≈ 1-2 contratos; el PPPoE por contrato es
  N chico. Con `Promise.all` la latencia es la del más lento, no la suma. Límites `take N`
  acotan tickets/tareas/logs/facturas. Sin N+1 sobre la lista (es un solo cliente por
  request lazy).
- **RBAC — ¿messaging:read debe ver datos financieros/tickets?** Es intencional (el agente
  del inbox necesita ver la deuda para atender), pero conviene confirmarlo con el arquitecto
  (Decisión abierta B) — quizá el endpoint deba requerir también los permisos de lectura
  de los módulos respectivos.
- **`ambiguous` con datos.** No se agrega hasta que el agente elige un candidato — evita
  filtrar datos de varios clientes a la vez y respeta CTX-1.

---

## Fuera de scope (otras fases / v2)

- **Media** (adjuntar/recibir fotos, comprobantes) → Grupo A.
- **Notas privadas, agrupar por fecha, emoji, avatares** → Grupo D.
- **Canned responses, resolver/reabrir, filtros/asignación** → Grupo C.
- **Última conexión / online PPPoE en tiempo real** → v2 opcional (botón on-demand);
  requiere `ListRadiusSessions` (fetch global caro). El estado de CORTE sí está en MVP.
- **Nodo/sitio nombrado** → fuera de MVP (solo `address` disponible).
- **Escribir / mutar** cualquier dato del cliente desde el panel → el panel es READ-ONLY;
  el detalle editable vive en la ficha existente de Prominense (link).

---

## Decisiones abiertas — necesitan OK del arquitecto antes del spec

- **A. Balance:** ¿reusar `GetClientDetail` CON refresh (deuda precisa, hasta ~4s la
  primera vez por TTL) — recomendado — o leer el mirror SIN refresh (instantáneo, posible
  stale con badge)?
- **B. RBAC:** ¿`messaging:read` alcanza para servir deuda/facturas/tickets del cliente, o
  el endpoint debe requerir además los permisos de lectura de esos módulos?
- **C. Endpoint:** ¿confirmás el scopeado por conversación
  (`/conversations/:id/client-context` con `?clientId` para desambiguar) — recomendado —
  frente al pelado por `clientId`?
- **D. Límites N:** ¿cuántos "últimos" mostramos? Propuesta: 3 tickets, 3 tareas, 5 logs,
  1 última factura + 1 próximo vencimiento.
