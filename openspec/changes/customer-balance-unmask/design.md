# Design — `customer-balance-unmask`

`toCustomer` deja de decidir **qué** saldo se ve según el status; la única decisión que queda es
**cuánto confiamos** en él, y eso lo dice `lastBalanceAt` contra un TTL. Tres superficies consumen
el mismo `Customer`; la asimetría de modo de falla (humano ve el número con su sello / el bot no
habla si no confía) vive en cada consumidor, NO en el mapper.

## Decisión 1 — El mapper es un passthrough; el `null` sale de la columna, no de una derivación

Firma **sin cambios en aridad obligatoria** (aditiva en el 3er parámetro):

```ts
export function toCustomer(
  row: any,
  balanceTtlMinutes = DEFAULT_BALANCE_TTL_MINUTES,
  now: () => Date = () => new Date(),   // NUEVO — inyectable, para tests deterministas
): Customer
```

`balanceDue` queda:

```ts
const balanceDue: number | null =
  row.balanceDue === null || row.balanceDue === undefined
    ? null
    : typeof row.balanceDue === 'object' && 'toNumber' in row.balanceDue
      ? row.balanceDue.toNumber()
      : Number(row.balanceDue);
balanceCurrency: row.balanceCurrency ?? null,
```

- **AUDITADO en el schema** (`prisma/schema.prisma:184-186`): `balanceDue Decimal? @db.Decimal(12,2)`,
  `balanceCurrency String?`, `lastBalanceAt DateTime?` — **ya son nullable**. El `null` de D2 del
  proposal NO requiere migración ni derivación: es la columna que nunca nadie escribió.
- **`toCustomer` NO necesita saber si hay `grClienteId`.** Los únicos que escriben esas tres
  columnas son `updateClientBalance` (fast/slow lane + refresh on-demand), y todos entran por
  `grClienteId`. Cliente sin link GR ⇒ columna virgen ⇒ `null`. Meter `grClienteId` en el mapper
  sería reintroducir una inferencia — el defecto exacto que este change borra.
- Se borra el `isDebtor` del mapper por completo (era su única razón de existir).
- **No se normaliza la moneda** (`normalizeGrCurrency` NO se aplica acá): D6 del proposal. El
  mapper devuelve lo que GR escribió.
- **Efecto lateral esperado**: `create()` (`PrismaCustomerRepository.ts:480`) devuelve un cliente
  nuevo con `balanceDue: null` en vez de `0`. Es correcto (nunca se consultó) y rompe fixtures —
  ver Decisión 8.

## Decisión 2 — `balanceStale` = `isBalanceOlderThanTtl`, status-agnóstico

Se **retira** el privado `isBalanceStale` (`PrismaCustomerRepository.ts:28-37`) y el mapper importa
el helper de application:

```ts
import { isBalanceOlderThanTtl } from '@application/use-cases/RefreshClientBalanceIfStale';
...
const lastBalanceAtIso = lastBalanceAt ? lastBalanceAt.toISOString() : null;
balanceStale: isBalanceOlderThanTtl(lastBalanceAtIso, balanceTtlMinutes, now),
```

- El helper toma `string | null` (ISO) y un `now: () => Date` **requerido** — de ahí el 3er
  parámetro de la Decisión 1. Sin él el mapper tendría que llamar `Date.now()` adentro y los tests
  quedarían atados a fake timers (lección "reloj fijo al gate del journey", `fdd05af0`).
- Dirección `infrastructure → application`: permitida y ya existente (`GetInboxClientContext` lo
  usa en prod, `RefreshClientBalanceIfStale.ts:24`).
- **Un solo criterio de frescura** para ficha, inbox y bot ⇒ el inbox ya no puede discrepar del
  mapper (hoy computa `stale` por su cuenta en `GetInboxClientContext.ts:193` y le da distinto que
  `customer.balanceStale` para todo no-`late`).

### Censo de consumidores de `balanceStale` (post-retiro)

| Consumidor | Hoy | Post-change |
|---|---|---|
| `ClienteSaldoResolver.ts:41,54` | gate del bot; `false` para todo no-`late` ⇒ **abierto** | gate real por antigüedad |
| `GetInboxClientContext.ts:193` | **no lo lee** — recalcula con `isBalanceOlderThanTtl` | idem; ahora coincide con el mapper |
| `InfoTab.tsx` (FE ficha) | **no lo lee** (usa `lastBalanceAt` para "Actualizado hace X") | sin cambio |
| `FinancialSection.tsx` (FE inbox) | recibe `balance.stale` del DTO y **no lo pinta** | sin cambio (change FE) |
| `externalV1.routes.ts:32-33` | excluido del DTO externo por diseño | **sigue excluido** (test pinea) |

⇒ **El campo `balanceStale` NO desaparece ni cambia de tipo. Cambia de semántica**: de
"es deudor y su saldo está viejo" a "su saldo está viejo". Ningún consumidor rompe: el único que
lo lee de verdad es el bot, y para el bot el cambio es endurecimiento.

## Decisión 3 — Un solo TTL (`config.gestionReal.balanceStaleTtlMinutes`), el portal no entra

`BALANCE_STALE_TTL_MINUTES` (default 60, clamp `[1,1440]`, `config.ts:106`) ya alimenta a los tres:
`PrismaCustomerRepository` (`app.ts:1276`), `RefreshClientBalanceIfStale` (`app.ts:1296`) y
`GetInboxClientContext` (`app.ts:3239`). **No se agrega perilla nueva.**

⚠️ **Corrección de premisa (VERIFICADA en el código, no asumida)**: `PORTAL_BALANCE_STALE_TTL_MINUTES`,
`portalBalanceStaleTtlMinutes` y `clampPortalBalanceTtlMinutes` **NO EXISTEN en el repo**.
`rg` sobre `src/` da cero implementaciones y `git log --all -S clampPortalBalanceTtlMinutes` solo
matchea un commit de BACKLOG. Lo que existe es (a) un comentario colgado en `config.ts:27` que
nombra una key inexistente y (b) la Decisión 5 del design archivado de `gr-balance-refresh-lanes`
(refresh on-demand en `ListPortalInvoices`) que **nunca se implementó**: `app.ts:3823` construye
`new ListPortalInvoices(customerAdapter)` con un solo argumento. ⇒ **No hay invariante estructural
TTL ≤ ¼ cadencia que romper**, porque no hay TTL de portal. Este change **no la crea**: si mañana
el portal estrena refresh on-demand, necesita su perilla PROPIA (su cadencia útil es de minutos,
no de la hora del batch) y su propio clamp. Se anota como deuda, fuera de alcance.

## Decisión 4 — Flujo del bot: resolver → refrescar → re-chequear → emitir o derivar

`ClienteSaldoResolver.resolve` ya tiene la secuencia correcta (`ClienteSaldoResolver.ts:39-57`); lo
único que falta es que `this.refreshBalance` **no sea `undefined` en producción** (Decisión 5).

```
findById ──→ ¿balanceDue null? ──sí──→ {disponible:false, motivo:'saldo_nunca_consultado'}
    │                │no
    │         ¿balanceStale?
    │            │no        │sí
    │            │          └─→ ¿grClienteId && refreshBalance?
    │            │                 │no ──────────────────────────┐
    │            │                 │sí                           │
    │            │            refresh.execute (TTL-gated,        │
    │            │            timeout 4s, NUNCA throw)           │
    │            │                 │true → findById otra vez     │
    │            │                 │false ───────────────────────┤
    │            ▼                                               ▼
    └──→ {disponible:true, saldo, moneda, tieneDeuda}   {disponible:false,
                                                         motivo:'saldo_desactualizado'}
                                                         ⇒ handoff a humano
```

**Presupuesto de latencia** (corre dentro del mensaje de WhatsApp):

| Tramo | ms | Fuente |
|---|---:|---|
| refresh GR | ≤ **4.000** | `config.gestionReal.balanceRefreshTimeoutMs` default 4000 (`config.ts:112`) |
| llamada al modelo | ≤ 20.000 | `config.assistant.timeoutMs` default 20000 (`config.ts:192`) |

El refresh es **el 20% del presupuesto que el bot ya gasta** en DeepSeek — no se toca el default.
Lo que SÍ se corrige: el clamp de `balanceRefreshTimeoutMs` tiene techo **60.000 ms**
(`config.ts:115`), y un env de 60 s dentro del flujo de un mensaje es un cuelgue. **Techo a
10.000 ms** (lección de la fix wave del portal: "techo del timeout de refresh 10 s y no 60"). Es un
clamp al lado seguro, aditivo, sin cambiar el default.

**Modo de falla con GR caído**: `RefreshClientBalanceIfStale.execute` se traga el error y devuelve
`false` (`RefreshClientBalanceIfStale.ts:96-99`) ⇒ el saldo sigue stale ⇒ `disponible:false` ⇒
handoff. **Nunca un número viejo, nunca un 0.** El `0` solo se emite cuando viene de una fila
fresca (`balanceDue = 0` con `lastBalanceAt` dentro del TTL) — eso sí es "al día" verificado.

## Decisión 5 — Cableado en `app.ts` + pin que discrimina de verdad

Una línea en `app.ts:3267-3277`: agregar `refreshBalance: balanceRefresh,` al objeto de
`composeAssistantEngine({...})` (`balanceRefresh` ya está en scope: se usa 30 líneas arriba, en
`app.ts:3235`). `ComposeAssistantEngineDeps.refreshBalance` ya existe
(`composeAssistantEngine.ts:41`) y ya se pasa al resolver (`:64`).

**El pin NO puede ser texto.** `assistant-composition.test.ts` es 100% `toMatch` sobre el fuente:
un `if (false)`, un comentario o un `refreshBalance` mencionado en prosa lo satisfacen. Tres capas,
la primera de comportamiento real:

| # | Test | Qué discrimina |
|---|---|---|
| **P1** | **Boot REAL de `createApp()`** con `jest.doMock('./composeAssistantEngine')` capturando el objeto `deps`; env GR seteado (`GR_SYNC_ENABLED=true`, `GR_CUIT`, `GR_SECRET`) ⇒ `expect(deps.refreshBalance).toBeInstanceOf(RefreshClientBalanceIfStale)` | Comentarios, `if (false)`, wiring inline disfrazado, `undefined` por env faltante. Molde ya probado en este repo: `messaging-composition.test.ts:298-372` (boot real, sin Postgres viva — Prisma/pg conectan lazy) |
| **P2** | `composeAssistantEngine` con `jest.mock` del módulo `ClienteSaldoResolver` ⇒ el constructor recibe `deps.refreshBalance` como 2º arg | Que el engine reciba la dep y la tire |
| **P3** | **Comportamiento del bot**: `new ClienteSaldoResolver(fakeRepo, fakeRefresh)` con `balanceStale:true` + `grClienteId` ⇒ `fakeRefresh.execute` **FUE llamado** y el segundo `findById` alimenta la respuesta | Que el resolver ignore la dep (ya cubierto parcialmente por `ClienteSaldoResolver.test.ts:83-95`; se le agrega el assert de invocación, hoy ausente) |

**Control obligatorio en P1**: sin las env de GR, `deps.refreshBalance` debe ser `undefined` — si el
assert de presencia pasa en los dos mundos, el test no está midiendo nada (lección
"probe-de-ausencia-no-discrimina", en espejo).

## Decisión 6 — La ficha no necesita DTO nuevo

`GET /api/clients/:id` devuelve el `Customer` **entero** (`clients.routes.ts:172-173`: `res.json(customer)`),
así que `lastBalanceAt` y `balanceStale` **ya viajan hoy**. `InfoTab.tsx:249,256-258` ya lee
`lastBalanceAt` y pinta "Actualizado hace X". ⇒ **Cero trabajo de DTO en este change.** El único
gap es del FE (`hasDebt = typeof balanceDue === 'number' && balanceDue > 0` ⇒ `null` cae en
"Sin deuda ✓", `InfoTab.tsx:250,263`) y va en el change coordinado.

### Contrato BE→FE, campo por campo (lo que el FE debe asumir tras este merge)

| Campo | Antes (no-`late`) | Después | Acción FE |
|---|---|---|---|
| `balanceDue` | `0` siempre | número real \| `null` | **3 estados** en `BalanceCard`: `null`⇒"Saldo no disponible", `0`⇒"Sin deuda ✓", `>0`⇒deuda |
| `balanceCurrency` | `null` siempre | la de la fila (o `null`) | dejar de hardcodear `formatARS` |
| `lastBalanceAt` | ya real | sin cambio | ya lo usa |
| `balanceStale` | `false` siempre | por antigüedad | pintar marca de desactualizado (ficha + inbox) |
| `balance.*` (inbox DTO) | ya honesto | sin cambio de shape | pintar `stale` (hoy lo ignora) |

## Decisión 7 — Fixtures: builder que pasa por el mapper real

Los tests que fakean `CustomerRepository` arman `Customer` a mano con estados que `toCustomer`
jamás produjo (`{status:'active', balanceDue:45000, balanceStale:false}`). Se agrega **un solo**
helper compartido en `src/__tests__/helpers/customerFixture.ts`:

```ts
export function customerFrom(row: Partial<PrismaClientRow>, opts?: { ttlMinutes?: number; now?: () => Date }): Customer
// → toCustomer({...BASE_ROW, ...row}, opts?.ttlMinutes ?? 60, opts?.now ?? (() => FIXED_NOW))
```

Todo `Customer` de fixture **nace del mapper real**, con reloj fijo. Un estado imposible deja de
ser expresable.

| Test | Estado imposible que lockea hoy | Post-saneo |
|---|---|---|
| `ClienteSaldoResolver.test.ts:15-30` | `active` + `balanceDue:45000` + `balanceStale:false` | `customerFrom({status:'active', balanceDue:dec(45000), lastBalanceAt: FRESH})` — el mismo caso, ahora **producible** |
| `GetInboxClientContext.test.ts` | `Customer` a mano con `balanceDue`/`lastBalanceAt` desalineados | `customerFrom(...)`; el `stale` del DTO y `customer.balanceStale` deben COINCIDIR |
| `GetClientDetail.test.ts:6-17` | `Customer` sin campos de balance (`undefined`) | `customerFrom({status:'inactive'})` ⇒ `balanceDue:null`, `balanceStale:true` |
| `CustomerBalanceMapper.test.ts:53-58` | `"balanceStale=false and balanceDue=0 for a non-debtor"` — **el candado del bug** | se reescribe: `active` + columna `null` ⇒ `balanceDue:null`, `balanceStale:true` |
| `PrismaCustomerRepository.mappers.test.ts:41-45` | `toEqual({... balanceDue:0, balanceStale:false})` para `active` | `balanceDue:null`, `balanceStale:true` |

Para **cada** test reescrito se exige la prueba del revert: revertir el fix del mapper debe ponerlo
en rojo (R7 del proposal).

## Decisión 8 — El portal queda INTACTO, y se pinea

`GetPortalMe.execute` **sí llama** `customers.findById` (`GetPortalMe.ts:35`) — o sea `toCustomer`
corre — pero de ese `Customer` solo lee `name` y `status` (`:38-39`). Los campos de plata del
`PortalMeDto` (`balances`, `lastBalanceAt`) salen **exclusivamente** de
`getPortalBalanceSummary` (`:36,44-45`), que agrega `Invoice` en la DB
(`PrismaCustomerRepository.ts:540-554`) y **no toca `toCustomer`**. `ListPortalInvoices` tampoco.

⇒ **Scenario que lo pinea**: `GetPortalMe` con un repo donde `findById` devuelve un `Customer`
`active` con `balanceDue: 99999` (imposible hoy, producible mañana) y `getPortalBalanceSummary`
devuelve `null` ⇒ el DTO debe seguir dando `balances: null`. Si el 99999 se filtra al portal, el
test cae.

## Decisión 9 — Revert-probes (mutantes) planificados

| Mutante | Se inyecta | Test que DEBE ponerse rojo |
|---|---|---|
| **M-A "volver a enmascarar"** (el bug original) | `if (status !== 'late') return 0;` en `toCustomer` | mapper: `active` + columna con deuda ⇒ número real |
| **M-B "el bot emite stale"** | quitar el `if (customer.balanceStale) return {disponible:false}` | `ClienteSaldoResolver`: stale + refresh fallido ⇒ `motivo:'saldo_desactualizado'` |
| **M-C "refreshBalance descableado"** | borrar `refreshBalance: balanceRefresh` de `app.ts` | **P1** (boot real). Si P1 sigue verde, el pin es de texto y no sirve |
| **M-D "null⇒0"** | `balanceDue: row.balanceDue ?? 0` | mapper: sin `grClienteId` ⇒ `null`; + `GetPortalMe`/inbox: `due == null` ⇒ "no disponible" |

Cada mutante se corre **antes** de dar el change por terminado, y se documenta cuál test cayó.

## Flujo de datos

```
GR ──fast-lane 1h / slow-lane 1d / refresh on-demand──→ Client.balanceDue|Currency|lastBalanceAt
                                                              │ (columna, nullable)
                                                    toCustomer(row, ttl, now)   ← passthrough + isBalanceOlderThanTtl
                                                              │
                    ┌─────────────────────────┬───────────────┴───────────────┐
              GetClientDetail           GetInboxClientContext          ClienteSaldoResolver
              (+refresh on-open)        (+refresh on-demand)           (+refresh AHORA cableado)
                    │                         │                               │
              número + sello            número + badge + stale        emite SOLO si fresco
                                                                       si no → handoff

  Portal:  GetPortalMe ─→ getPortalBalanceSummary (Invoice groupBy) ── NO pasa por toCustomer
```

## Cambios de archivos

| Archivo | Acción | Qué |
|---|---|---|
| `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts` | Modify | borrar `isBalanceStale` (28-37); `toCustomer` passthrough + `now` inyectable + `isBalanceOlderThanTtl` |
| `src/infrastructure/http/app.ts` | Modify | `refreshBalance: balanceRefresh` en `composeAssistantEngine({...})` (~3267) |
| `src/infrastructure/config.ts` | Modify | techo de `balanceRefreshTimeoutMs` 60.000 → 10.000; borrar el comentario colgado (`:27`) que nombra `portalBalanceStaleTtlMinutes` (inexistente) |
| `src/domain/entities/customer.ts` | Modify | docstrings `:25,31` — sacar "(ARS)" y "and client is a debtor" |
| `src/infrastructure/adapters/assistant/ClienteSaldoResolver.ts` | Modify | header: el gate ya no depende del status |
| `src/__tests__/helpers/customerFixture.ts` | Create | `customerFrom()` — fixtures por el mapper real, reloj fijo |
| `src/__tests__/application/CustomerBalanceMapper.test.ts` | Modify | reescribir el caso que lockea el masking |
| `src/__tests__/infrastructure/PrismaCustomerRepository.mappers.test.ts` | Modify | `toEqual` del `active`: `null`/`true` |
| `src/__tests__/infrastructure/adapters/assistant/ClienteSaldoResolver.test.ts` | Modify | fixtures por builder + assert de **invocación** del refresh (P3) |
| `src/__tests__/application/messaging/GetInboxClientContext.test.ts` | Modify | fixtures por builder; `stale` del DTO == `balanceStale` |
| `src/__tests__/application/GetClientDetail.test.ts` | Modify | fixtures por builder |
| `src/__tests__/infrastructure/assistant-composition.test.ts` | Modify | agregar P1 (boot real + captura de deps) y P2 |
| `src/__tests__/application/portal/GetPortalMe.test.ts` | Modify | scenario "el balance del mapper NO se filtra al portal" |

## Estrategia de tests

| Capa | Qué | Cómo |
|---|---|---|
| Unit (mapper) | `null`/número/moneda/stale por antigüedad, todos los `CustomerStatus` | `toCustomer` real, `now` fijo, sin fake timers |
| Unit (bot) | gate estricto + invocación del refresh + GR caído ⇒ handoff | fakes de `CustomerRepository`/`RefreshClientBalanceIfStale`, fixtures del builder |
| Use case | ficha e inbox muestran número + sello para no-`late` | in-memory port, fixtures del builder |
| Composición | P1 boot real de `createApp()` + P2 | `jest.doMock` + captura de deps; control con env GR ausente |
| Contrato | portal y API externa v1 sin cambios | `GetPortalMe` scenario + `externalV1.routes.test.ts` (ya existe) |
| Mutación | M-A..M-D | manual, documentando qué test cayó |

## Rollout

**Sin migración de base de datos** (las tres columnas ya son nullable). Sin feature flag: el cambio
es una corrección de verdad, y un flag dejaría el camino viejo (mentiroso) vivo.

Pre-deploy: **spot-check contra GR** de N clientes no-`late` con `balanceDue > 0` (el único ASUMIDO
del proposal) y **aviso a operaciones** (R3: de 73 deudores visibles a ~3.286).

Post-deploy, verificación **de otro change** (R6/M4, `buildSegmentWhere` piso 0,
`PrismaCustomerRepository.ts:351-379`): con `balanceMin ≤ 0` el `OR [{range},{null}]` incluye a los
`balanceDue: null`. Ese universo **ya está cambiando** desde el fast-lane (2026-08-04) y **no lo
mueve este change** (esos consumidores nunca pasaron por `toCustomer`) — pero como este deploy es
el momento en que todos vamos a mirar la columna, se aprovecha para que producto revise la
elegibilidad de campañas/promos activas. Si sube el conteo de destinatarios, la causa es el
fast-lane, no el unmask.

## Preguntas abiertas

- [ ] ¿Bajar el techo de `BALANCE_REFRESH_TIMEOUT_MS` a 10 s (Decisión 4) entra en este change o se
      separa? Recomendación: entra — es una línea, y el bot es el primer consumidor que corre ese
      timeout dentro de un mensaje de usuario.
- [ ] El comentario colgado de `config.ts:27` y la Decisión 5 nunca implementada de
      `gr-balance-refresh-lanes` (refresh del portal): ¿se borra el comentario acá y se abre change
      para el refresh del portal, o se deja tal cual? Recomendación: borrar el comentario (miente),
      abrir la deuda aparte.
