# Tasks — `customer-balance-unmask`

Strict TDD: rojo→verde→refactor, runner `npm test` (Jest), adapters in-memory, jamás mockear
Prisma. Techo `BALANCE_REFRESH_TIMEOUT_MS` = 10 s entra en este change. Comentario huérfano de
`config.ts:27` (nombra `PORTAL_BALANCE_STALE_TTL_MINUTES`, inexistente) se borra acá.

## Fase 0 — Premisas cumplidas + helper `customerFrom()`

- [x] 0.1 Registrar como CUMPLIDA la premisa ASUMIDA del proposal: spot-check en vivo contra GR de
      15/15 clientes no-`late` con `balanceDue>0`, calcan GR al centavo (2026-08-10, orquestador,
      engram `sdd/combo-5-6/decisiones`). Ojo: `cuentas.debt` de GR viene con punto DECIMAL. No se
      repite el spot-check en este change.
- [x] 0.2 [ROJO] Test smoke de `customerFrom(row, opts)` en
      `src/__tests__/helpers/customerFixture.ts` (no existe → falla el import).
- [x] 0.3 [VERDE] Crear `customerFixture.ts`: `BASE_ROW` + `FIXED_NOW` + `customerFrom()` delega en
      `toCustomer(row, ttlMinutes, now)` real — ningún estado inventado a mano.

## Fase 1 — Mapper `toCustomer`: unmask + null + firma con `now` inyectable

- [x] 1.1 [ROJO] `PrismaCustomerRepository.mappers.test.ts`: `active` + `grClienteId` +
      `balanceDue=45000` ⇒ `balanceDue:45000` (S1, hoy en rojo — pisado a 0).
- [x] 1.2 [ROJO] Mismo archivo: `late` + `balanceDue=1000` ⇒ paridad sin cambios (S2).
- [x] 1.3 [ROJO] `CustomerBalanceMapper.test.ts`: `grClienteId:null` + `row.balanceDue:500` ⇒
      `balanceDue:null` (nunca 500, nunca 0) (S3).
- [x] 1.4 [ROJO] Mismo archivo: `grClienteId:'GR123'` + `row.balanceDue:500` ⇒ `balanceDue:500`
      (S4).
- [x] 1.5 [ROJO] `row.balanceCurrency:'DOL'` ⇒ `balanceCurrency:'DOL'`, sin default a `'ARS'`
      (S7).
- [x] 1.6 [ROJO] `create()` en `PrismaCustomerRepository.mappers.test.ts`: `toEqual` pasa a
      `balanceDue:null` (era `0`) — efecto lateral documentado de Decisión 1 (mandato 8).
- [x] 1.7 [VERDE] `toCustomer(row, ttl, now = () => new Date())` en
      `PrismaCustomerRepository.ts:39`: passthrough — `balanceDue`/`balanceCurrency` desde la
      columna para TODO status; `null` sale de la columna, no de `isDebtor`; borrar `isDebtor` del
      mapper.
- [x] 1.8 Docstrings `customer.ts:25,31`: sacar `"(ARS)"` y `"and client is a debtor"`.

## Fase 2 — Helper de staleness: retiro de `isBalanceStale`

- [x] 2.1 [ROJO] Mapper: `status='active'`, `lastBalanceAt`=10min, `ttl=60` ⇒ `balanceStale:false`
      (S5). Nota apply: NO fue rojo (el código viejo ya devolvía `false` para `active` sin mirar
      `lastBalanceAt` — el escenario coincide por accidente con el bug). Se agregó una
      triangulación (`active` + `lastBalanceAt` viejo ⇒ `true`) que SÍ fue roja, más S6 abajo.
- [x] 2.2 [ROJO] `lastBalanceAt:null`, cualquier status ⇒ `balanceStale:true` (S6, S14).
- [x] 2.3 [VERDE] Borrar `isBalanceStale` (`PrismaCustomerRepository.ts:28-37`); importar
      `isBalanceOlderThanTtl` de `@application/use-cases/RefreshClientBalanceIfStale`; `toCustomer`
      calcula `balanceStale: isBalanceOlderThanTtl(lastBalanceAtIso, ttl, now)`.
- [x] 2.4 Censo de callers post-retiro: `rg "isBalanceStale\("` en `src/` da CERO matches fuera de
      comentarios/historial (S11). Confirmar que NINGÚN caller (`ClienteSaldoResolver`,
      `GetInboxClientContext`, FE ficha/inbox) quedó con la semántica vieja `status!=='late'⇒false`
      — tabla de censo del design, Decisión 2.
- [x] 2.5 [ROJO→VERDE] Test: mismo `lastBalanceAt`+`ttl`, en `toCustomer`, `GetInboxClientContext`
      y `RefreshClientBalanceIfStale`, dan el MISMO booleano (S13). Nota apply: escrito DESPUÉS de
      2.3 (deviation de orden) — verificado verde contra el código post-fix; el contrafáctico
      status-keyed queda cubierto por el revert-probe M-B (Fase 6, gate del bot).

## Fase 3 — Ficha + inbox + pin del portal

- [x] 3.1 [ROJO] `GetClientDetail.test.ts` (via `customerFrom()`): activo + `balanceDue=45000`
      fresco ⇒ `GET /api/clients/:id` responde `balanceDue:45000` (S23). Nota apply: verde de
      entrada — `GetClientDetail.execute` no necesitaba cambio de código (design lo anticipaba,
      "on-open refresh is preserved unchanged"); el fix vivía enteramente en el mapper (Fases 1/2).
- [x] 3.2 Test (ya existente, no debería requerir cambio): stale + `grClienteId` ⇒
      `RefreshClientBalanceIfStale` se intenta, éxito ⇒ campos frescos (S24). Confirmado verde sin
      tocar `GetClientDetail.execute`.
- [x] 3.3 Test: GR inalcanzable dentro del timeout ⇒ fallback a `balanceDue` guardado +
      `balanceStale:true`, el request NUNCA tira (S25).
- [x] 3.4 [ROJO] `balanceDue=12000` guardado, `lastBalanceAt`=3h, TTL=60, refresh falla ⇒ los TRES
      campos (`balanceDue`, `balanceStale:true`, `lastBalanceAt` viejo) viajan juntos (S26).
- [x] 3.5 Test: `grClienteId:null` ⇒ sin refresh, `balanceDue:null` (S27, regresión).
- [x] 3.6 [ROJO] `GetInboxClientContext.test.ts` (via `customerFrom()`): activo + `balanceDue=45000`
      ⇒ `balance.due:45000`, `balance.isDebtor:true` (S28). Nota apply: verde de entrada — mismo
      motivo que 3.1, `GetInboxClientContext` nunca pasaba por `toCustomer` (fake repo bypassea el
      mapper), así que el fix del mapper alcanza sin tocar el use case.
- [x] 3.7 Test: `stale` del DTO == `customer.balanceStale` para el mismo `lastBalanceAt`/TTL, en
      cualquier status (S29 — regresión, ya no puede discrepar del mapper).
- [x] 3.8 Test: `grClienteId:null` ⇒ `balance.due:null` (S30, regresión).
- [x] 3.9 Test: `params.refresh===true` + stale + `grClienteId` ⇒ `RefreshClientBalanceIfStale`
      llamado, éxito ⇒ `due`/`stale` re-derivados (S31, regresión). Ya cubierto por el test #10
      preexistente — confirmado verde, sin test nuevo.
- [x] 3.10 [DESVÍO documentado] `customerFrom()` se usó para TODOS los escenarios NUEVOS de balance
      en ambos archivos (S23/S25/S26/S27/S28/S29/S30), pero NO se reescribió el resto de los ~30
      fixtures preexistentes de `GetInboxClientContext.test.ts`/`GetClientDetail.test.ts` (tickets,
      tareas, contratos, PPPoE) — esos jamás pasan por `toCustomer` (el fake repo devuelve el
      `Customer` directo) y nunca certificaron el masking bug; reescribirlos en bloque arriesgaba
      romper ~30 tests por beneficio marginal (muchos usan `lastBalanceAt` como STRING ISO, que
      `customerFrom`/`toCustomer` exige como `Date`). Ver "Deviations" en el reporte final.
- [x] 3.11 [ROJO→VERDE] `GetPortalMe.test.ts`: `findById` devuelve `Customer` `active` con
      `balanceDue:99999` (producible post-unmask) + `getPortalBalanceSummary` devuelve `null` ⇒
      `PortalMeDto.balances:null` — pin de que el mapper NO se filtra al portal (S10, mandato 7).
      Verde de entrada (GetPortalMe nunca leyó balanceDue).
- [x] 3.12 [FE, read-only, NO se toca código] Verificado en
      `C:\Users\ronald\projects\ipnext\ipnext-frontend` (grep, sin editar): (a) `InfoTab.tsx:250` —
      `hasDebt = typeof balanceDue === 'number' && balanceDue > 0` CONFIRMADO, `null` cae en
      "Sin deuda ✓" (b) `FinancialSection.tsx` — CONFIRMADO que `balance.stale` no aparece en
      ninguna referencia del archivo (solo `balance.due`/`balance.currency`). Change FE que sigue:
      3 estados en `BalanceCard` (desconocido/al día/deudor) + indicador de frescura en ambas
      superficies — mandato 9, ningún archivo FE tocado.

## Fase 4 — Bot: flujo completo + guard de moneda + timeout 10s + wiring + P1/aridad

- [x] 4.1 [ROJO] `ClienteSaldoResolver.test.ts` (via `customerFrom()`): activo, `grClienteId`,
      `balanceDue=45000`, `ARS`, fresco ⇒ `{disponible:true, saldo:45000, moneda:'ARS',
      tieneDeuda:true, estadoCliente:'active'}` — el bug original, para el bot (S17). Verde de
      entrada (mismo motivo que 3.1/3.6: el resolver siempre leyó `customer.balanceDue` directo,
      el bug vivía en el mapper).
- [x] 4.2 [ROJO] `lastBalanceAt`=ayer, `grClienteId` set, GR falla ⇒
      `{disponible:false, motivo:'saldo_desactualizado'}`, sin `saldo` (S18 — "GR caído⇒deriva").
- [x] 4.3 Test: mismo estado pero `refreshBalance.execute` devuelve `true` ⇒ re-`findById`, emite
      el saldo freschado (S19 — "stale⇒refresh(10s)⇒re-check⇒responde").
- [x] 4.4 [ROJO] `balanceDue:null` (sin `grClienteId`) ⇒
      `{disponible:false, motivo:'saldo_nunca_consultado'}` (S20 — "sin grClienteId⇒no sé").
- [x] 4.5 [ROJO] `balanceDue=1000` (via row con `balanceCurrency:null`, `balanceStale` fresco) ⇒
      `{disponible:false, motivo:'moneda_no_confirmada'}` — NO `moneda:'ARS'` (S21, guard de
      moneda del resolver, ratificado dentro de alcance). CONFIRMADO ROJO: recibía
      `{disponible:true, moneda:'ARS', ...}`.
- [x] 4.6 Test regresión: `balanceDue=1000`, `balanceCurrency:'ARS'`, fresco ⇒ emite normal (S22).
- [x] 4.7 [VERDE] `ClienteSaldoResolver.ts`: guard explícito
      `if (customer.balanceCurrency == null) return {disponible:false, motivo:'moneda_no_confirmada'}`
      ANTES de emitir; `moneda: customer.balanceCurrency` (ya no `?? 'ARS'`).
- [x] 4.8 Reescribí COMPLETO `ClienteSaldoResolver.test.ts` con `customerFrom()` (fila base
      `CUSTOMER_ROW` compartida); agregado assert de INVOCACIÓN de `fakeRefresh.execute` en el
      caso stale (test "P3", antes ausente).
- [x] 4.9 [ROJO] `assistant-composition.test.ts` — **P1**: boot real de `createApp()` con
      `jest.doMock('./composeAssistantEngine')` capturando `deps`; env GR seteado (`GR_SYNC_ENABLED`,
      `GR_CUIT`, `GR_SECRET`) ⇒ `deps.refreshBalance` es instancia de
      `RefreshClientBalanceIfStale`. Molde: `messaging-composition.test.ts:298-372`. CONFIRMADO
      ROJO: `Received value: undefined` (M-C reproducido antes del fix).
- [x] 4.10 [ROJO→VERDE de entrada] **Control obligatorio de P1**: mismo boot SIN env de GR ⇒
      `deps.refreshBalance` es `undefined`. Ya verde ANTES del fix (correcto: sin GR configurado
      `balanceRefresh` nunca se instancia en `app.ts`, con o sin la línea de wiring) — el control
      discrimina el mundo POSITIVO (P1) del NEGATIVO (este), no antes/después del fix.
- [x] 4.11 [VERDE de entrada] **P2**: `composeAssistantEngine` (real) con `jest.mock` del módulo
      `ClienteSaldoResolver` ⇒ el constructor recibe `deps.refreshBalance` como 2º arg. Ya verde
      (la función YA pasaba `deps.refreshBalance` al resolver — `composeAssistantEngine.ts:64` no
      cambió; el bug era que `app.ts` no lo alimentaba, cubierto por P1).
- [x] 4.12 [VERDE de entrada] Test de aridad `@ts-expect-error` sobre el composition root: llamar
      `composeAssistantEngine({...deps sin refreshBalance})` sigue compilando (aditivo, opcional);
      un objeto con `refreshBalance` de tipo incorrecto SÍ falla de tipo — pin de tipo, no de
      texto. Ya verde (la firma ya era aditiva desde antes de este change).
- [x] 4.13 [VERDE] `app.ts:3267-3277`: agregado `refreshBalance: balanceRefresh,` al objeto de
      `composeAssistantEngine({...})` — pone P1 en verde.
- [x] 4.14 [ROJO] `config.ts`: `BALANCE_REFRESH_TIMEOUT_MS=60000` clampea a `10000` (techo nuevo),
      default 4000 sin cambio.
- [x] 4.15 [VERDE] `config.ts`: `max: 60_000` → `max: 10_000` en `balanceRefreshTimeoutMs`.
- [x] 4.16 Header de `ClienteSaldoResolver.ts`: actualizado — el gate ya no depende del status,
      documentado el guard de moneda.

## Fase 5 — Saneo de fixtures restantes + `config.ts:27`

- [x] 5.1 Barrido `rg` en `src/__tests__/` de fixtures `Customer` armados a mano con pares
      `status`/`balanceDue` que el mapper real no produce, fuera de los 5 ya cubiertos (Fases 1/3/4)
      — confirmar que no queda ninguno o listarlos. RESULTADO: `clientBalance.routes.test.ts` (todo
      status `late`, seguro), `portalSelfService.routes.test.ts` (balance siempre `null` en el
      builder, portal no lo lee), `messaging.routes.test.ts:2230-2242` (mismo patrón que
      `GetInboxClientContext.test.ts` — bypassea `toCustomer`, nunca certificó el bug; scoping
      documentado en 3.10). El resto de archivos con `balanceDue` son `CampaignRecipientCandidate`
      (mapper DISTINTO, `toCampaignRecipientCandidate`, sin gate de `grClienteId`/status — fuera de
      alcance por diseño, proposal.md "Quiénes NO están afectados") o cartera/portfolio (columna
      cruda, ídem). Ningún fixture nuevo quedó por sanear.
- [x] 5.2 Fixture bypaseando el mapper (`{status:'active', balanceDue:45000}` directo, sin
      `toCustomer`) queda documentado como RECHAZADO en review — contra-scenario S9, sin test
      automatizable (es una regla de review, no runtime). Documentado en el docblock de
      `customerFixture.ts` y en los comentarios de cabecera de los archivos reescritos
      (`ClienteSaldoResolver.test.ts`).
- [x] 5.3 Borrado el comentario huérfano de `config.ts` que nombraba
      `portalBalanceStaleTtlMinutes` (inexistente) — reescrito sin esa referencia, preservando el
      resto (piso/techo siguen documentados, tests de config verdes).

## Fase 6 — Contrafáctico pre-fix + revert-probes

- [x] 6.1 Antes de dar la Fase 1 por cerrada: correr el scenario bandera "activo con deuda fresca
      ⇒ el bot la dice" (4.1) contra el código PRE-fix (`git stash` de los 5 archivos de src/,
      probe temporal `__probe_counterfactual.test.ts`, borrado después) y confirmar que FALLA —
      CONFIRMADO: `saldo:0, tieneDeuda:false` (el bug, reproducido).
- [x] 6.2 Revert-probe M-A "volver a enmascarar": reinsertado `if (status !== 'late') return 0;`
      en `toCustomer` ⇒ mató 3 tests, incluido el de la tarea 1.1 (S1, "active client with real
      debt"). Restaurado, verde.
- [x] 6.3 Revert-probe M-B "el bot emite stale": neutralizado el guard de `balanceStale` en
      `ClienteSaldoResolver` ⇒ mató S18 (tarea 4.2) y "P3" (assert de invocación, tarea 4.8).
      Restaurado, verde.
- [x] 6.4 Revert-probe M-C "refreshBalance descableado": comentado `refreshBalance: balanceRefresh`
      en `app.ts` ⇒ mató **P1** (tarea 4.9) — únicamente P1, ni el control ni P2 se movieron
      (correcto: son independientes de esta línea). Restaurado, verde.
- [x] 6.5 Revert-probe M-D "null⇒0": `balanceDue: (row.balanceDue ?? 0) as number` en el mapper ⇒
      mató el test de 1.3 (S3) Y el S30 de `GetInboxClientContext` ("no GR link ⇒ due:null").
      `GetPortalMe` quedó verde bajo este mutante — CORRECTO, no un hueco: Decisión 8 hace que
      `GetPortalMe` sea estructuralmente inmune a `Client.balanceDue` (nunca lo lee), así que
      ningún mutante del mapper puede discriminarlo — su propio pin (3.11) protege un modo de
      falla DISTINTO. Restaurado, verde.
- [x] 6.6 Documentado — ver tabla en el reporte final de `sdd-apply` (Decisión 9 del design).

## Fase 7 — Runbook de deploy (sin código)

- [ ] 7.1 Sin migración de DB (columnas ya nullable) y sin feature flag — documentar en el PR por
      qué (Rollout del design: un flag dejaría vivo el camino mentiroso).
- [ ] 7.2 Pre-deploy: nota de comunicación a operaciones — shock operativo de 73 deudores visibles
      a ~3.286 en ficha e inbox (R3). No es opcional: los agentes van a ver deuda donde ayer leían
      "Al día".
- [ ] 7.3 Runbook post-deploy (riesgo M4, de OTRO change, solo se OBSERVA acá): query de control
      del universo de `buildSegmentWhere` piso-0 (`PrismaCustomerRepository.ts:351-379`,
      `balanceMin≤0` ⇒ `OR [{range},{balanceDue:null}]`) ANTES y DESPUÉS del deploy — si sube el
      conteo de destinatarios de campañas/promos, la causa es el fast-lane (ya corriendo desde
      2026-08-04), NO este unmask. No se toca `buildSegmentWhere` en este change.

## Apéndice — Matriz scenario → tarea

| Spec | Scenario | Tarea |
|---|---|---|
| customer-balance-truth | active client with real debt | 1.1 |
| customer-balance-truth | late client, unchanged parity | 1.2 |
| customer-balance-truth | unlinked client with a stray column value | 1.3 |
| customer-balance-truth | linked client, normal path | 1.4 |
| customer-balance-truth | fresh active client | 2.1 |
| customer-balance-truth | never fetched | 2.2 |
| customer-balance-truth | non-ARS currency survives | 1.5 |
| customer-balance-truth | bot fixture goes through the real mapper | 0.3, 3.10, 4.8 |
| customer-balance-truth | (contra) fixture bypassing mapper rejected | 5.2 |
| customer-balance-truth | portal contract and anti-IDOR scope unchanged | 3.11 |
| balance-staleness-helper | no trace of old signature | 2.4 |
| balance-staleness-helper | (contra) reintroduce status-keyed staleness | 6.3 (mismo mutante que M-B, gate del bot) |
| balance-staleness-helper | identical verdict across all three call sites | 2.5 |
| balance-staleness-helper | no timestamp yet | 2.2 |
| assistant-balance-guard | composition wires the collaborator | 4.9 |
| assistant-balance-guard | (contra) refreshBalance omitted | 6.4 |
| assistant-balance-guard | active client with real debt, fresh | 4.1 |
| assistant-balance-guard | yesterday's balance, refresh fails | 4.2 |
| assistant-balance-guard | stale, but the refresh succeeds | 4.3 |
| assistant-balance-guard | client with no GR link | 4.4 |
| assistant-balance-guard | trusted balance, unconfirmed currency | 4.5 |
| assistant-balance-guard | regression — confirmed currency | 4.6 |
| client-detail-balance | active client with real debt | 3.1 |
| client-detail-balance | stale client, refresh succeeds | 3.2 |
| client-detail-balance | refresh fails or times out | 3.3 |
| client-detail-balance | stale-but-known balance ships all three fields | 3.4 |
| client-detail-balance | no GR link | 3.5 |
| inbox-client-balance | active client with real debt | 3.6 |
| inbox-client-balance | same TTL, same verdict everywhere | 3.7 |
| inbox-client-balance | no GR link | 3.8 |
| inbox-client-balance | agent forces a refresh | 3.9 |

**Cobertura**: 31/31 scenarios mapeados. Sin huecos de spec detectados.

**Nota sobre balance-staleness-helper / contra-scenario "reintroduce call keyed off status"**: no
hay un mutante DEDICADO nuevo para esta spec — se reutiliza 6.3 (M-B), que reintroduce
exactamente ese patrón (`status`-gated) en el consumidor real (`ClienteSaldoResolver`). No hay
hueco de spec: el requirement pide que NINGÚN caller reintroduzca la semántica vieja, y M-B es el
caller que existe.
