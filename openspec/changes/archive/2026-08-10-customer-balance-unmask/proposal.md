# Proposal — `customer-balance-unmask`

## Intención

Que el saldo que Prominense muestra sea **el que está en la fila**, para todos los clientes y no
solo para los que Gestión Real marca `Deudor` — y que cuando no se confíe en ese número, se diga
**por su fecha de refresco**, no por el estado del cliente.

## Problema

`toCustomer` (`src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts:39-77`) tira el saldo
a 0 para todo cliente que no sea `late`:

```ts
const isDebtor = status === 'late';
if (!isDebtor) return 0;                                  // balanceDue
balanceCurrency: isDebtor ? (row.balanceCurrency ?? null) : null;
balanceStale: isBalanceStale(status, ...)                 // línea 32-33: if (status !== 'late') return false
```

**Cuando se escribió (`617049ab`, 2026-05-27) era correcto**: el sync de balances (`d6ef3745`) tocaba
SOLO a los deudores, así que devolver la columna para el resto habría sido servir basura. No hay
ninguna intención de negocio detrás — es un artefacto de qué datos existían ese día.

**La premisa murió el 2026-08-04** (`db403f59`, change `gr-balance-refresh-lanes`):

- `FAST_LANE` (`RefreshDebtorBalances.ts:41-45`): estados GR `1,2,3,4` **cada hora**, sella
  `balanceDue`/`balanceCurrency`/`lastBalanceAt` vía `updateClientBalance`.
- `SLOW_LANE`: estado `6` (bajas), 1×/día.
- `mapStatus` cubre **todos** los `CustomerStatus` del dominio entre los dos carriles. Único hueco:
  clientes **sin `grClienteId`**.
- `GetClientDetail.execute` (`GetClientDetail.ts:20-29`) además dispara `RefreshClientBalanceIfStale`
  **on-open para cualquier cliente con link GR**, no solo deudores.

⇒ Hoy, abrir la ficha de un cliente activo **escribe el saldo real en la fila** y, en el mismo
request, `toCustomer` lo pisa con 0 antes de responder. **La data fresca está y se descarta.**

### Radio de impacto

| Población | Clientes | Qué ve hoy |
|---|---:|---|
| `late` (GR 2 · Deudor) | **73** | saldo real |
| `active` (GR 1) | **5.323** | **0 — siempre** |
| no-`late` con `balanceDue > 0` real en la columna | **3.213** | **0 — mentira sobre plata** |

MEDIDO (prod, 2026-08-10 — provisto en el brief; consistente con lo medido el 2026-08-04 por
`gr-balance-refresh-lanes`: 5.325 activos / 69 deudores / 188 inactivos / 9.082 bajas).

⇒ El masking le miente sobre **~3.213 clientes con deuda real**, y solo acierta sobre 73.

### Las tres superficies afectadas (censo verificado)

| Superficie | Camino | Hoy (no-`late`) | Riesgo |
|---|---|---|---|
| **Ficha del panel** — `GET /api/clients/:id` (`clients.routes.ts:165-181`, devuelve el `Customer` entero) → FE `InfoTab.tsx` `BalanceCard` | `findById` → `toCustomer` | "Sin deuda ✓" siempre | el operador cobra/no cobra con un dato falso |
| **Inbox humano** — `GetInboxClientContext.buildClientSummary:177-231` → FE `clientContext/FinancialSection.tsx` | mismo `customerRepo.findById` | `due=0` → badge **"Al día"** | el agente le dice al cliente que está al día |
| **Bot de IA** — `ClienteSaldoResolver.resolve:39` (`cliente.saldo`) | mismo `customerRepo.findById` | `{disponible:true, saldo:0, tieneDeuda:false}` | **responde solo, por WhatsApp, sin humano en el medio** |

⚠️ **La card del BACKLOG que dice que el bot "ya se cerró con FIX-6" está STALE.** FIX-6 se RETIRÓ
del change anterior por decisión del usuario. Verificado en el código: `ClienteSaldoResolver:39` llama
`this.customers.findById(...)`, **no** `getPortalBalanceSummary` (grep exhaustivo: ese método lo
consume únicamente `GetPortalMe.ts:36`). El bot sigue con el mismo masking.

### Quiénes NO están afectados (ya ven el número real)

Leen la columna **cruda**, sin pasar por `toCustomer`: cartera/KPI
(`PrismaPortfolioReadRepository:45-46,97-98`), campañas y segmentos (`buildSegmentWhere`,
`SendCampaign`, `PreviewCampaignSegment`), promos del portal (`portalPromoEligibility`). El portal
self-service (`GetPortalMe` → `getPortalBalanceSummary`) deriva de facturas y es su propia fuente
honesta. La API externa v1 excluye los campos de balance por DTO (`externalV1.routes.ts:32-33`).
**Ninguno cambia con este change.**

### Por qué los tests no lo cazaron

- Solo DOS tests ejercitan el mapper real, y **lockean el bug**:
  `PrismaCustomerRepository.mappers.test.ts:13-51` y `CustomerBalanceMapper.test.ts:53-57`
  (`"balanceStale=false and balanceDue=0 for a non-debtor (active)"`).
- El resto (`ClienteSaldoResolver.test.ts:29`, `GetInboxClientContext.test.ts`,
  `GetClientDetail.test.ts`) fakea `CustomerRepository` con `Customer` armados a mano tipo
  `{status:'active', balanceDue:45000}` — **un estado que `toCustomer` JAMÁS produce**. Cobertura
  verde sobre un mundo que no existe: el patrón "la función que decide no es la que se testea".

## Alcance

### Dentro (backend, este change)

1. **`toCustomer` deja de enmascarar**: `balanceDue` y `balanceCurrency` se mapean desde la columna
   para **todo** `CustomerStatus`. `null` sigue siendo `null` ("no sabemos"), nunca 0.
2. **`balanceStale` pasa a ser status-agnóstico**: se retira el privado `isBalanceStale`
   (`PrismaCustomerRepository.ts:32-37`) y se deriva de `isBalanceOlderThanTtl(lastBalanceAt, ttl)`
   (`@application/use-cases/RefreshClientBalanceIfStale`) — el helper **que ya se usa en producción**
   para el inbox (`GetInboxClientContext.ts:193`) y dentro del refresh on-demand. Un solo criterio de
   frescura para las tres superficies. (Infra→application es la dirección permitida por la
   arquitectura; el helper ya se exporta.)
3. **Cablear el refresh del bot**: `composeAssistantEngine.ts:64` construye
   `new ClienteSaldoResolver(deps.customerRepo, deps.refreshBalance)`, pero `app.ts:3267-3277`
   **NO pasa `refreshBalance`** — la rama de refresco del bot es **código muerto en prod**, aunque
   `balanceRefresh` está en scope tres líneas más arriba. Se cablea y se pinea en el
   composition-root test (precedente del bug W6: rutas cableadas, hook nunca inyectado, CI verde,
   feature muerta).
4. **Saneamiento de fixtures**: los dos tests que lockean el masking se reescriben contra la nueva
   verdad; los que fakean `CustomerRepository` pasan a construir el `Customer` **con el mapper real**
   (`toCustomer(row, ttl)`) o con estados producibles, para que no vuelvan a certificar un mundo
   imposible.
5. **Docstrings mentirosos**: `customer.ts:25,31` ("(ARS)", "and client is a debtor"), header de
   `ClienteSaldoResolver`, y el comentario de `isBalanceStale`.

### Fuera

- **Opción B — derivar el saldo de las facturas** (`getPortalBalanceSummary` como fuente general).
  **Rechazada con evidencia**: **11.352 de 14.668 clientes (77%) no tienen facturas espejadas** y
  ese método devuelve `null` para ellos. Migrar la ficha/inbox/bot a esa fuente dejaría MUDA a la
  mayoría de la base. Es la fuente correcta para el PORTAL (deuda derivada de facturas propias del
  cliente), no un sustituto de `Client.balanceDue` (lo que GR reporta como saldo).
- **La moneda hardcodeada del parser GR**: `GestionRealClient.ts:501` hace
  `currency: amount > 0 ? 'ARS' : null`. Deuda **preexistente**, ver R4.
- **Cartera, campañas, promos, portal, API externa** — ya ven el número real.
- **Elegibilidad de campañas / `buildSegmentWhere`** (ver R6) — ya cambió de facto con el fast-lane,
  es independiente de este change.
- **El cambio de frontend** — change coordinado posterior, ver "FE".

## Enfoque

`toCustomer` sirve el número real; **la confianza en ese número la decide `lastBalanceAt`, no el
status**. Modo de falla por superficie:

| Estado del dato | Ficha del panel | Inbox humano | Bot de IA |
|---|---|---|---|
| **fresco** (`lastBalanceAt` dentro del TTL) | número + "Actualizado hace X" | número + badge Debe/Al día | emite `{saldo, moneda, tieneDeuda}` |
| **stale** (sello viejo) | número + sello + marca de desactualizado | ídem + badge "desactualizado" | intenta refresh contra GR; si sigue stale ⇒ `disponible:false, motivo:'saldo_desactualizado'` ⇒ **handoff a humano** |
| **desconocido** (`null`: nunca refrescado, sin `grClienteId`) | **"Saldo no disponible"** (hoy dice "Sin deuda ✓" — requiere FE) | "Saldo no disponible" (ya lo hace bien) | `disponible:false, motivo:'saldo_nunca_consultado'` |

**El bot conserva el gate MÁS estricto**, que es el que ya tiene por diseño: la ficha y el inbox
muestran el número con su sello y un humano interpreta; el bot **no habla si no confía**, porque
responde solo por WhatsApp. Esa asimetría es deliberada y se mantiene.

### Por qué esto NO repite el FIX-6

FIX-6 se retiró porque **invertía el modo de falla**: cortocircuitaba el guard para que el bot
hablara con menos garantías que antes. Acá pasa lo contrario, en cuatro puntos:

1. **El guard se vuelve más ESTRICTO, no más laxo.** Hoy `balanceStale` es `false` para todo
   no-`late`, *sin importar cuán viejo sea el sello* — o sea, para 5.323 clientes el guard está
   **cortocircuitado en abierto ahora mismo**. Pasar a `isBalanceOlderThanTtl` hace que esos
   clientes puedan marcarse stale por primera vez.
2. **La garantía pasa a ser POSITIVA y medible** (`lastBalanceAt`, un timestamp real escrito por el
   refresco) en vez de una **inferencia sobre el status** que nunca dijo nada sobre frescura.
3. **Existe un carril de refresco vivo** que no existía cuando se escribió el masking: fast-lane
   horario (desde 2026-08-04) + refresh on-open de la ficha + refresh on-demand del inbox.
4. **El número ya está en la fila**: no se está inventando un dato nuevo, se está dejando de
   descartar uno que el propio request acaba de escribir.

### Ventana de exposición (cuantificada)

- TTL: **60 min** (`BALANCE_STALE_TTL_MINUTES`, default 60 — `config.ts:106`; el mismo valor lo
  consumen `PrismaCustomerRepository`, `RefreshClientBalanceIfStale` y `GetInboxClientContext`).
- Fast-lane: **5.582 llamadas ≈ 43 min** a 0,459 s/llamada (MEDIDO en `gr-balance-refresh-lanes`),
  cada hora.
- Peor caso realista de desfasaje: **≈ 2 h** (una ventana de tick + el barrido). Antes del fast-lane
  el desfasaje de un activo era **infinito** (nunca se lo refrescaba).
- Encima de eso, **abrir la ficha refresca** (`GetClientDetail`) y el inbox refresca a pedido.

⇒ El riesgo residual del "número stale positivo" es una deuda de **hasta ~2 h**, mostrada **con su
fecha al lado**, contra el daño actual de decirle "no debés nada" a 3.213 clientes que sí deben.

⚠️ **Consecuencia honesta y ASUMIDA**: con TTL=60 min y un barrido de ~43 min, una fracción de la
base va a estar `stale` justo antes de que le toque el turno. `balanceStale=true` **no va a ser
raro**. Para la ficha y el inbox eso es cosmético (muestran el número con el sello); **para el bot
significa negarse a hablar más seguido que hoy** — modo de falla seguro, pero degradado. Por eso el
punto 3 del alcance (cablear `refreshBalance`, ~0,46 s por consulta) no es opcional: sin él, el bot
pasa de "miente" a "casi siempre deriva a un humano".

### FE (change coordinado, BE primero)

Verificado en `ipnext-frontend`:

- **Ficha** (`src/pages/customers/tabs/InfoTab.tsx:249-290`): ya renderiza `balanceDue` con
  `lastBalanceAt` ("Actualizado hace X"). **Con el BE arreglado muestra bien el caso principal sin
  tocar una línea.** Dos gaps: (a) `hasDebt = typeof balanceDue === 'number' && balanceDue > 0`
  ⇒ **`null` cae en "Sin deuda ✓"** (conflaciona *desconocido* con *al día*); (b) formatea con
  `formatARS(...)` fijo, ignorando `balanceCurrency`.
- **Inbox** (`clientContext/FinancialSection.tsx:54-77`): distingue `due == null` → "Saldo no
  disponible" ✅ y usa `formatMoney(due, currency)` ✅, pero **ignora `balance.stale` por completo**
  — el campo llega y no se pinta.

⇒ **El BE puede mergear solo, sin regresión**: hoy un cliente sin `grClienteId` ya ve "Sin deuda", y
post-unmask verá lo mismo. El FE va después con dos ajustes chicos: 3 estados en `BalanceCard`
(desconocido / al día / deudor) y un indicador de frescura en ambas superficies. Precedente:
`portal-payments` ("BE primero, contrato cerrado y verificado en vivo, después la pantalla").

## Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | **Número stale positivo**: reclamarle plata a alguien que ya pagó. Es el modo de falla que el masking evitaba (a costa de mentirle a 3.213). | Sello `lastBalanceAt` visible + fast-lane horario + refresh on-open + el bot no habla si stale. Exposición acotada a ~2 h (arriba). |
| **R2** | El bot deriva a humano mucho más seguido si no se cablea `refreshBalance`. | Punto 3 del alcance (una línea + composition-root test). Sin eso, **este change no debería mergear**. |
| **R3** | **Shock operativo**: la ficha y el inbox pasan de mostrar 73 deudores a ~3.286. Los agentes van a ver deuda donde ayer leían "Al día". | Es la verdad, pero hay que avisarle a operaciones antes del deploy. Comunicación, no código. |
| **R4** | **Moneda**: el parser GR hardcodea `'ARS'` cuando hay deuda (`GestionRealClient.ts:501`), y en prod hay **43 facturas `DOL`** (MEDIDO, `normalizeGrCurrency`). Una deuda en dólares se mostraría en pesos. | **Preexistente** — hoy afecta a 73 clientes, post-unmask afecta a los ~3.286 con deuda. **Regla de la casa: no sumar monedas y no asumir ARS.** `Client.balanceDue` es UN monto con UNA moneda tal como GR lo reporta; ninguna superficie agrega monedas. Se documenta y se abre change aparte. |
| **R5** | El FE del inbox ignora `stale`: el operador ve el número sin marca de frescura. | Change FE coordinado (arriba). Mientras tanto el `lastRefreshedAt` ya se muestra. |
| **R6** | **M4 — `buildSegmentWhere` piso 0** (`PrismaCustomerRepository.ts:351-379`): con `balanceMin ≤ 0` agrega `OR [{balanceDue: range}, {balanceDue: null}]`. Con el fast-lane llenando la columna, el universo de campañas/promos **ya está cambiando de facto**. | **Independiente de este change** (esos consumidores nunca pasaron por `toCustomer`). Se documenta para que producto revise la elegibilidad de campañas/promos activas. |
| **R7** | Tocar los fixtures mal y perder señal. | Los fixtures pasan por el mapper real; y para cada test reescrito se exige la prueba del revert (¿falla si revierto el fix?). |

## Decisiones abiertas para el usuario

| # | Decisión | Recomendación |
|---|---|---|
| **D1** | ¿`balanceStale` pasa a `isBalanceOlderThanTtl(lastBalanceAt, ttl)` (status-agnóstico) y se retira el `isBalanceStale` status-aware? | **SÍ.** El helper ya existe, ya está en prod en el inbox, y el guard queda más estricto que hoy, no más laxo. |
| **D2** | Clientes **sin `grClienteId`** (nunca los toca ningún carril): ¿`balanceDue: null` ("no sabemos") o 0 ("al día")? | **`null`.** 0 es una afirmación sobre la plata de alguien que nunca verificamos. Requiere el ajuste FE de la ficha para no leerlo como "Sin deuda". |
| **D3** | ¿Se cablea `refreshBalance` en `composeAssistantEngine` (hoy código muerto)? | **SÍ**, y es bloqueante: sin eso el bot queda mudo la mayor parte del tiempo (ver R2). |
| **D4** | Con el dato **stale**: ¿la ficha y el inbox **muestran el número con su fecha**, o lo ocultan? | **Mostrarlo con la fecha.** Ocultar un dato de 90 minutos convierte información imperfecta en un agujero, y el humano que mira sabe interpretarlo. El bot sigue sin emitirlo. |
| **D5** | ¿El cambio de FE va ahora como change coordinado o después? | **BE primero** (no hay regresión), FE inmediatamente después: 3 estados en `BalanceCard` + indicador de frescura en ambas superficies. |
| **D6** | ¿Se toca la moneda hardcodeada `'ARS'` del parser GR en este change? | **NO.** Es un bug distinto, preexistente, con su propia evidencia (43 facturas DOL). Mezclarlo diluye el revert de éste. Change aparte. |

## MEDIDO vs ASUMIDO

**MEDIDO**
- 73 `late` / 5.323 `active` / 3.213 no-`late` con `balanceDue > 0` (prod, 2026-08-10 — brief;
  consistente con el censo del 2026-08-04).
- Fast-lane: estados 1/2/3/4, 5.582 llamadas, ~43 min a 0,459 s/llamada; slow-lane estado 6,
  9.082 llamadas 1×/día (`gr-balance-refresh-lanes`, 2026-08-04).
- 11.352 de 14.668 clientes sin facturas espejadas (77%) — funda el rechazo de la Opción B.
- 7.430 facturas `PES` y 43 `DOL` en prod (`normalizeGrCurrency`).
- `ClienteSaldoResolver` llama `findById` y no `getPortalBalanceSummary` (código, verificado).
- `app.ts:3267-3277` no pasa `refreshBalance` a `composeAssistantEngine` (código, verificado).
- El FE ficha conflaciona `null` con 0; el FE inbox ignora `stale` (código, verificado).

**ASUMIDO**
- Que la mayoría de los ~3.213 no-`late` con deuda son deudas legítimas y no basura del espejo
  (la columna la escribe el mismo `updateClientBalance` que alimenta a los `late`, pero **no se
  hizo un spot-check contra GR en esta fase**). ⇒ Un spot-check de N clientes no-`late` con deuda
  contra GR en vivo debería ser el primer paso de `sdd-tasks`.
- Que el desfasaje de ~2 h es el peor caso realista (deriva de la cadencia medida, no de una
  medición del desfasaje en sí).
- Que ninguna superficie fuera del censo consume `Customer.balanceDue` (el censo cubre todos los
  call-sites de `toCustomer`: líneas 451, 457, 495, 680).
