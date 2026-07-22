# Tasks — gigared-tv-identity-hardening

**Change**: gigared-tv-identity-hardening · **Phase**: tasks (RE-SCOPED 2026-07-22 por el root cause
confirmado — engram `gigared/root-cause-cic-envenenado`) · **Repo BE**: este worktree
(`gigared-tv-identity-be`). **Repo FE**: `ipnext-frontend` (sección propia al final, apply DESPUÉS
del BE verde).

**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases (`InMemory*Repository`,
fakes `jest.fn` del `GigaredPort`), JAMÁS mockear Prisma ni el use case — seam completo (regla del
repo). **Regla dura, TODO el suite**: CERO writes reales al partner Gigared — fakes/in-memory
siempre. El primer register/link/transfer EN VIVO tras deploy lo aprueba el usuario (patrón K2
SmartOLT) — checklist al final.

**RE-SCOPE (ver Desvíos)**: el fix REAL es **B1 (anti-envenenamiento del pool)** — la causa raíz
confirmada. La verificación del seq (ex-B1) y su fix condicional (ex-B1b) quedaron **ELIMINADOS** del
scope (la auditoría probó que el seq/link NO fue causal). El nombre BE-authoritative (ex-B2/B3) se
**DEGRADÓ** a hardening OPCIONAL al final (B8). Todo lo demás se mantiene, renumerado.

**Dependencias entre batches**:
```
B1 (anti-poison pool: 2 errores + filtro + verify) → B2 (recovery/probe + TvEmailOwnedByOtherError)
  → B3 (207 route, depende de B1+B2)
B4 (lista local-first) ─┐
B5 (transferencia) ─────┼→ B7 (wiring app.ts + composition-root)
B6 (newCic en baja) ────┘   (B6 self-contained, sin wiring nuevo)
B8 (OPCIONAL, ÚLTIMO — nombre BE-authoritative) — depende de B1 (mismo archivo), corre al final
```
B1/B2/B3 son secuenciales (los tres tocan la misma secuencia de `RegisterGigaredAccount`). B4/B5/B6
son independientes entre sí y de B1-B3 (archivos distintos, salvo `gigared.routes.ts`/`app.ts` en
secciones separadas). FE arranca solo cuando B1-B7 (BE) están verdes.

---

## Batch 1 — Anti-envenenamiento del pool (fix #1, D-pool) — LA CAUSA RAÍZ, PRIMERO

- [ ] **1.1** RED+GREEN — dos errores nuevos en `domain/errors/gigared.ts` (molde de
  `NoCicAvailableError` / `TvAlreadyLinkedError`; codes = contrato de wire FROZEN):
  - `TvPoolPoisonedError` — code `TV_POOL_POISONED`, carga `poisonedCount`. Branch nuevo en
    `sendGigaredError` (`gigared.routes.ts`, espejo del branch de `NoCicAvailableError` ~línea 158)
    → **422** `{ code, poisonedCount }`.
  - `TvIdentityStampUnverifiedError` — code `TV_IDENTITY_UNVERIFIED`, carga `cic` + `internalId`.
    Branch nuevo en `sendGigaredError` (espejo de `GigaredUnavailableError` ~línea 101) → **503**
    `{ code, cic, internalId }`.
  - Sin test standalone del branch (mismo criterio que el resto de la familia; se ejercita
    end-to-end en B3).
- [ ] **1.2** RED — extender la suite de `RegisterGigaredAccount` (`RegisterGigaredAccount.usecase.test.ts`
  o `GigaredAccount.usecases.test.ts`, describe `RegisterGigaredAccount`), fake `GigaredPort` con
  `listAccounts`/`getAccountByInternalId`/`register`/`activate`/`setInternalId` configurables + el
  `pick` inyectable (#109):
  - **Pool mixto**: `listAccounts({status:'unregistered'})` devuelve `[{cic:'A', internalId:'ca4023a2'},
    {cic:'B', internalId:null}]` → el register usa **`cic:'B'`** (el limpio); `register` es llamado
    con `cic:'B'`, NUNCA con `'A'` (el envenenado). Verificar con `toEqual` sobre los call args.
  - **Pool TODO envenenado**: todas las entradas traen `internalId` no vacío → lanza
    `TvPoolPoisonedError`; `register`/`activate`/`setInternalId` NUNCA se llaman
    (`toHaveBeenCalledTimes(0)` cada uno) — **cero writes al partner**.
  - **Pool vacío** (`[]`) → `NoCicAvailableError` (regresión, sin cambio).
  - **Post-stamp mismatch**: tras `setInternalId`, `getAccountByInternalId(internalId)` devuelve una
    cuenta con `cic` DISTINTO del estampado → lanza `TvIdentityStampUnverifiedError`; el reconcile
    local NUNCA corre (0 filas locales a medias).
  - **Post-stamp 404**: `getAccountByInternalId` post-stamp lanza `GigaredNotFoundError` → propaga
    sin escribir fila local (no se traga el 404 como éxito).
  - **Regresión**: los tests `#109`/`#115`/`#118`/`#81` existentes siguen verdes — el pool de sus
    fixtures debe tener al menos un CIC limpio (`internalId: null`) para no romper el happy path
    (ajustar SOLO el fixture del pool, sin tocar aserciones de seq/CIC/contractId).
- [ ] **1.3** GREEN — `RegisterGigaredAccount.ts`:
  - Pool-filter (reemplaza `:113-120`):
    ```ts
    const pool = await this.gigared.listAccounts({ status: 'unregistered' });
    if (pool.length === 0) throw new NoCicAvailableError();
    const clean = pool.filter(e => e.cic && (e.internalId === null || e.internalId === ''));
    if (clean.length === 0) throw new TvPoolPoisonedError(pool.length);
    const pickFn = this.pick ?? ((n: number) => Math.floor(Math.random() * n));
    const poolEntry = clean[pickFn(clean.length)];
    if (!poolEntry?.cic) throw new NoCicAvailableError();
    const cic = poolEntry.cic;
    ```
  - Post-stamp verify (tras `:152` `getAccountByInternalId`):
    ```ts
    const account = await this.gigared.getAccountByInternalId(internalId);
    if (account.cic !== cic) throw new TvIdentityStampUnverifiedError(cic, internalId);
    ```
  - **Decisión de diseño cerrada**: el filtrado es en memoria — el listado del pool YA trae
    `internalId` por cuenta (`GigaredPort.ts:37`, `GigaredClient.ts:146`). CERO llamadas extra.
- [ ] **Gate B1**: suite `RegisterGigaredAccount` completa verde (viejos + nuevos); `tsc --noEmit`
  limpio.

## Batch 2 — Recovery/probe idempotente (fix #2, D2) + `TvEmailOwnedByOtherError`

- [ ] **2.1** RED+GREEN — `TvEmailOwnedByOtherError` en `domain/errors/gigared.ts` (molde
  `TvAlreadyLinkedError`): code `TV_EMAIL_OWNED_BY_OTHER`, carga `email` + `ownedByInternalId`.
  Branch nuevo en `sendGigaredError` (espejo del branch de `TvAlreadyLinkedError` ~línea 168) →
  **409** `{ code, email, ownedByInternalId }`. Se ejercita end-to-end en B3.
- [ ] **2.2** RED — nuevo describe en la suite de `RegisterGigaredAccount` (o archivo dedicado
  `RegisterGigaredAccount.recovery.test.ts`), fake `GigaredPort` con `getAccountByInternalId`
  configurable + `listAccounts` espiado:
  - **mine-stamped** (probe previo encuentra `internalId === MI internalId`): NO se llama
    `listAccounts({unregistered})` (pool-pick), NI `register`/`activate`/`setInternalId`
    (`toHaveBeenCalledTimes(0)`); solo corre el reconcile local; `recovered: true`.
  - **404 happy path**: probe 404 → pool-pick filtrado (B1) → `register→activate→setInternalId→
    getAccountByInternalId` en orden, UNA vez cada uno; `recovered: false`.
  - **orphan (email dup, mía, CIC limpio)**: probe 404 → `register` rechaza `GigaredRejectedError`
    → `listAccounts({email})` devuelve match con `internalId: ''` → resume
    `activate→setInternalId→getAccountByInternalId→reconcile`, SIN re-llamar `register`;
    `recovered: true`. (Con B1, todo orphan NUEVO nace con `internalId` vacío → esta es la rama
    esperada.)
  - **mine vía email**: probe 404 → `register` rechaza → `listAccounts({email})` match con
    `internalId === MI internalId` → solo reconcile local, `setInternalId` NUNCA llamado.
  - **other (ajena / orphan histórico envenenado)**: probe 404 → `register` rechaza →
    `listAccounts({email})` match con `internalId` de OTRO → throw `TvEmailOwnedByOtherError` (2.1);
    `setInternalId` NUNCA llamado; CERO reconcile local. (Cubre el orphan histórico envenenado — la
    salida segura: no auto-tocar cuenta bindeada a otro cliente.)
  - **none (no recuperable)**: probe 404 → `register` rechaza → `listAccounts({email})` SIN match →
    re-lanza el `GigaredRejectedError` ORIGINAL tal cual.
  - **infra error propaga sin recovery**: `register` lanza `GigaredUnavailableError` (no
    `GigaredRejectedError`) → propaga DIRECTO, `listAccounts({email})` NUNCA se llama (catch gateado
    a `instanceof GigaredRejectedError`).
  - **idempotencia end-to-end**: 2do `execute()` idéntico tras un mine-stamped → 0 llamadas nuevas a
    `register`/`activate`/`setInternalId`, 0 consumo de CIC del pool (mismo fake port reutilizado,
    contador acumulado).
- [ ] **2.3** GREEN — `RegisterGigaredAccount.ts`: probe-previo `getAccountByInternalId(internalId)`
  ANTES del pool-pick (mine-stamped → skip a reconcile local, `recovered=true`; 404 → sigue a B1);
  la secuencia `register/activate/setInternalId` (con el post-stamp verify de B1) envuelta en
  try/catch gateado a `instanceof GigaredRejectedError`; en el catch, `listAccounts({email})` como
  discriminador → 3 ramas (`''`→resume · mine→local · other→`TvEmailOwnedByOtherError`) + rethrow.
  Guía, no literal — `sdd-apply` puede extraer un helper privado, pero el orden de guardas
  (probe → pool-filter → register-path → post-stamp verify → catch por instancia → discriminador por
  email → 3 ramas + rethrow) queda PINNED.
- [ ] **Gate B2**: suite de recovery completa verde + B1 sin regresión; `tsc --noEmit` limpio.

## Batch 3 — 207 en `POST /register` (fix #3, D3, espejo link/addService)

- [ ] **3.1** RED — extender el describe de ruta (`gigared.routes.test.ts` o donde viva el supertest
  del router `/customers/:id/register`; si no existe uno dedicado, crearlo espejando `link`/`addService`):
  - `localReconciled: 'failed'` (reconcile local lanza) → 207, body incluye
    `{ partnerCreated: true, localReconciled: 'failed' }`.
  - Happy path completo → 201 `{ partnerCreated: true, localReconciled: 'synced', recovered: false }`.
  - Recovery mine-stamped con reconcile OK → 201 `recovered: true` (recovered NO gatea el status).
  - `TvPoolPoisonedError` → **422** `{ code: 'TV_POOL_POISONED', poisonedCount }`.
  - `TvIdentityStampUnverifiedError` → **503** `{ code: 'TV_IDENTITY_UNVERIFIED', cic, internalId }`.
  - `TvEmailOwnedByOtherError` → **409** `{ code: 'TV_EMAIL_OWNED_BY_OTHER', email, ownedByInternalId }`.
- [ ] **3.2** GREEN — `RegisterGigaredAccount.execute` retorna `{ account, partnerCreated,
  localReconciled: 'synced'|'failed', credentialsPersisted, recovered }` (`localReconciled` es campo
  INDEPENDIENTE — NO reemplaza `credentialsPersisted`, que sigue viajando igual, ver Desvíos #5).
  `gigared.routes.ts` línea 380: `const partial = !result.partnerCreated || result.localReconciled
  === 'failed'; res.status(partial ? 207 : 201).json(result);` (reemplaza el `res.status(201).json(account)`
  fijo actual).
- [ ] **Gate B3**: suite de ruta verde (207/201 + 422/503/409 + regresión); `tsc --noEmit` limpio.

## Batch 4 — Lista local-first (fix #4, D4)

- [ ] **4.1** Port `ContractServiceRepository` (`domain/ports/ContractServiceRepository.ts`) gana
  `findActiveTvOwnersByCics(serviceCatalogId: string, cics: string[]): Promise<{ notes: string;
  clientId: string }[]>`.
- [ ] **4.2** RED+GREEN `InMemoryContractServiceRepository.findActiveTvOwnersByCics` (mismo
  archivo/test que ya cubre `findActiveByCatalogAndNotesPrefix`): filtra `status==='active' &&
  serviceCatalogId===X && cicFromNotes(notes) ∈ cics` (match EXACTO — evita "CIC 12" sobre-matcheando
  "CIC 123"), resuelve `clientId` vía el `contractId` de la fila (mapa `contractId → clientId`
  inyectable).
  - Test: 2 cuentas, 1 con fila local activa + 1 sin fila → batch devuelve SOLO la que matchea.
  - Test: dos filas activas con el MISMO cic exacto (dirty data) → primera por `createdAt` gana.
  - Test: fila `status:'inactive'` con el cic → NO aparece (origen inactivado por transfer).
- [ ] **4.3** RED+GREEN `PrismaContractServiceRepository.findActiveTvOwnersByCics`: UNA
  `findMany({ where: { serviceCatalogId, status: 'active', OR: cics.map(c => ({ notes: {
  startsWith: \`CIC ${c}\` } })) }, select: { notes: true, contract: { select: { clientId: true } }
  }, orderBy: { createdAt: 'asc' } })`, mapea a `{ notes, clientId: row.contract.clientId }`. Test
  adapter-intención (`jest.mock('.../database/prisma')`) — pinea el shape EXACTO del
  `where`/`select`/`orderBy` (UNA llamada a `findMany`, jamás N+1).
- [ ] **4.4** RED — extender `GigaredAccount.usecases.test.ts` describe `ListGigaredAccounts`:
  - `ListGigaredAccounts(gigared)` (sin deps, legacy) → comportamiento BYTE-IDÉNTICO (alias-only).
  - `ListGigaredAccounts(gigared, csRepo, catalogRepo)` con 1 cuenta con fila local activa para su
    `cic` → `clientId` = el del contrato local (NO el alias).
  - Mismo caso SIN fila local → fallback al `clientId` alias-derivado (`reapplyClientId`).
  - Batch mixto (N cuentas) → `csRepo.findActiveTvOwnersByCics` se llama **UNA sola vez**
    (`toHaveBeenCalledTimes(1)`) — nunca por cuenta (N+1 PROHIBIDO).
  - Sin `catalogRepo.getByName('TV')` resolviendo → degrada a alias-only sin tirar (fail-open).
- [ ] **4.5** GREEN — `ListGigaredAccounts.ts`: constructor gana `csRepo?: ContractServiceRepository,
  catalogRepo?: ServiceCatalogRepository` (opcionales). Sin ambas → comportamiento actual intacto.
  Con ambas: resuelve `tvCatalog = await catalogRepo.getByName('TV')` (sin catálogo → fallback
  alias-only, no throw); junta los `cic`; UNA llamada `findActiveTvOwnersByCics(tvCatalog.id, cics)`;
  arma `Map<cic, clientId>` con `cicFromNotes(row.notes)` (reusar el helper exportado de
  `reconcileTvContractService.ts`); cada cuenta: `clientId = ownerByCic.get(account.cic) ??
  reapplyClientId(account).clientId`.
- [ ] **Gate B4**: suites 4.2/4.3/4.4 verdes; `tsc --noEmit` limpio.

## Batch 5 — Evento `transferencia` en el Historial TV global (fix #5, D7)

Independiente de B1-B4: toca `TransferTvToCustomer.ts` + `TvActivationEventRepository.ts` +
`ListTvActivationHistory.ts`, ningún archivo compartido salvo `app.ts` (sección distinta).

- [ ] **5.1** `domain/ports/TvActivationEventRepository.ts`: `TvEventType` pasa a `'alta' | 'baja' |
  'reactivacion' | 'transferencia'`. Cero cambio en adapters (pasan el string tal cual); cero
  migración (`TvActivationEvent.eventType` ya es `String` libre).
- [ ] **5.2** RED — extender `TransferTvToCustomer.usecase.test.ts`: inyectar un
  `InMemoryTvActivationEventRepository` (o fake `jest.fn`) como arg opcional AL FINAL.
  - Test: transferencia fresh exitosa → `activationEventRepo` recibe DOS `record()`: uno
    `{ clientId: targetCustomerId, eventType: 'transferencia', internalId: targetInternalId,
    contractId: targetContractId, cic }` y otro `{ clientId: sourceCustomerId, eventType:
    'transferencia', internalId: sourceInternalId, cic }` (`reason` no vacío, sin pinear el string).
  - Test: modo RESUME → los DOS eventos se re-graban (append-only).
  - Test: `activationEventRepo.record` rechaza → la transferencia COMPLETA igual (200/207), sin
    excepción propagada — best-effort.
  - Test: SIN `activationEventRepo` inyectado → comportamiento BYTE-IDÉNTICO al actual.
- [ ] **5.3** GREEN — `TransferTvToCustomer.ts`: constructor gana `activationEventRepo?:
  TvActivationEventRepository` (opcional, AL FINAL). En el bloque best-effort del Paso 7 (junto a
  `transfer-out`/`transfer-in` del `eventRepo` por-contrato, ~línea 407), bloque independiente
  gateado a `this.activationEventRepo` (dep DISTINTA, no acoplar a `this.eventRepo`) que graba los
  dos eventos `transferencia` en try/catch (best-effort).
- [ ] **5.4** RED+GREEN `ListTvActivationHistory.ts`: el tipo inline de `toDto` (~línea 46,
  `eventType: 'alta' | 'baja' | 'reactivacion'`) referencia ahora `TvEventType` importado del puerto
  (evita desincronización). Test: fila `eventType: 'transferencia'` → el DTO la expone sin filtrar.
- [ ] **Gate B5**: `TransferTvToCustomer.usecase.test.ts` + `ListTvActivationHistory` tests verdes;
  `tsc --noEmit` limpio.

## Batch 6 — `newCic` del `renewCic` en el evento `baja` (fix #6, D-baja) — forense futura

Self-contained: toca SOLO `CancelTvJobRunner.ts` (el `eventRepo` ya está cableado ahí — sin wiring
nuevo). `CancelTv.execute` YA devuelve `renew: { oldCic, newCic } | null` (`CancelTv.ts:246`).

- [ ] **6.1** RED — extender el test de `CancelTvJobRunner` (`CancelTvJobRunner.test.ts` o donde viva
  el seam del runner): fake `eventRepo` (`jest.fn`) + `cancelTv.execute` mockeado devolviendo un
  `result` con `renew: { oldCic: 'X', newCic: '0006938875' }`.
  - Test: el `record()` del evento `baja` recibe `reason` que CONTIENE `renewCic:0006938875` (y
    preserva el motivo del usuario como segmento inicial si vino uno: `"{motivo} · renewCic:0006938875"`).
  - Test: `renew: null` (renew no corrió / falló) → `reason` = el motivo del usuario tal cual (o
    `null` si no hubo motivo) — SIN el sufijo, comportamiento legacy.
  - Test: sin motivo de usuario + `renew:{newCic}` → `reason` = `"renewCic:0006938875"` (solo el tag).
- [ ] **6.2** GREEN — `CancelTvJobRunner.ts` (~línea 59-67, dentro del `record` best-effort del
  `baja`): componer el `reason` con el `newCic`:
  ```ts
  reason: [reason ?? null, result.renew?.newCic ? `renewCic:${result.renew.newCic}` : null]
            .filter(Boolean).join(' · ') || null,
  ```
  Cero migración (columna `reason` existente). El tag `renewCic:{cic}` es grep-able para un futuro
  report de minas (deuda).
- [ ] **Gate B6**: test del runner verde; `tsc --noEmit` limpio.

## Batch 7 — Wiring `app.ts` + composition-root (fix #4 + fix #5)

- [ ] **7.1** RED — extender `gigared-composition.test.ts`:
  - nuevo `it` que pinea `new ListGigaredAccounts(...)` incluye `contractServiceRepo` y
    `serviceCatalogRepo` (molde de los `it` (e)/(h) existentes).
  - el `it` de `TransferTvToCustomer` gana un `.toMatch(/gigaredTvActivationEventRepo/)`.
- [ ] **7.2** GREEN — `app.ts`:
  - `:2502` — `listAccounts: new ListGigaredAccounts(gigaredClient, contractServiceRepo,
    serviceCatalogRepo)` (ambos singletons YA en scope).
  - `:2518` — `transferTv: new TransferTvToCustomer(gigaredClient, gigaredCustomerLookup,
    gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation,
    contractServiceEventRepo, gigaredTvActivationEventRepo)` (MISMO singleton ya instanciado `:2494`).
- [ ] **Gate B7**: `gigared-composition.test.ts` completo verde; `npx jest` del área gigared
  (`src/__tests__/**/*[Gg]igared*` + `CancelTvJobRunner*` + `TransferTvToCustomer*`) síncrono, 0
  failures; `tsc --noEmit` limpio. **NO** `npm run build` (regla del repo).

## Batch 8 — OPCIONAL, ÚLTIMO: Nombre BE-authoritative + split APELLIDO-primero (D1, DEGRADADO)

> **OPCIONAL**: NO fue causa del incidente (forense: página correcta + nombre correcto). Batch
> ÚLTIMO, puede diferirse fuera de v1 sin reabrir el incidente. Depende de B1 (mismo archivo
> `RegisterGigaredAccount.ts`). Se conserva la corrección del split **APELLIDO-primero**.

- [ ] **8.1** RED+GREEN `application/use-cases/gigared/splitCustomerName.ts` (helper puro), test
  `src/__tests__/application/splitCustomerName.test.ts`. **Convención: PRIMER token = lastName
  (apellido), el resto = firstName** — formato **APELLIDO NOMBRE(s)** (verificada contra prod +
  espejo del helper FE `GigaredPanel.tsx:58-67`, "#47e B: the FIRST token is the lastName").
  - Test: `"VACHERAND SILVIO GABRIEL"` → `{ lastName: 'VACHERAND', firstName: 'SILVIO GABRIEL' }`.
  - Test: `"CENTENO MIGUEL ANGEL"` → `{ lastName: 'CENTENO', firstName: 'MIGUEL ANGEL' }`.
  - Test: 1 token `"MADONNA"` → `{ lastName: 'MADONNA', firstName: 'MADONNA' }`.
  - Test: `''`/`null`/`undefined`/solo espacios → fallback determinístico (criterio de
    `normalizeLastName`, cae a `'cliente'`) — NUNCA tirar.
  - Test: espacios múltiples colapsan.
- [ ] **8.2** RED — extender la suite de `RegisterGigaredAccount`: `fakeCustomerLookup` gana un
  `name` configurable (ver Desvíos #4). Scenario body-name-corruption: `customer.name = 'CENTENO
  MIGUEL ANGEL'`; el `input` trae `firstName`/`lastName` de OTRA persona.
  - Test: `gigared.register` es llamado con `firstName: 'MIGUEL ANGEL'`, `lastName: 'CENTENO'` (del
    customer, split D1) — NUNCA con los del `input` (`toEqual` sobre call args).
  - Test: `deterministicTvEmail` se invoca con el `lastName` DERIVADO (`'CENTENO'`), no el del input.
  - Test: 1 token → firstName=lastName; register recibe eso.
  - Test regresión: `#109`/`#115`/`#118`/`#81` verdes SIN editar aserciones (solo agregar `name` al
    fixture donde haga falta).
- [ ] **8.3** GREEN — `RegisterGigaredAccount.ts`: import `splitCustomerName`; tras resolver
  `customer`, `const { firstName, lastName } = splitCustomerName(customer.name)`; línea 136
  `deterministicTvEmail(input.lastName, …)` → `deterministicTvEmail(lastName, …)`; línea 142-144
  `gigared.register({firstName, lastName, …})` usa las derivadas. El TIPO del input MANTIENE
  `firstName`/`lastName` (tolerancia de deploy) pero el código nunca los lee (`void input.firstName;
  void input.lastName;`, mismo patrón que `input.email`/`input.cic`).
- [ ] **Gate B8**: `splitCustomerName.test.ts` + suite `RegisterGigaredAccount` verdes; `tsc
  --noEmit` limpio.

---

## Sección FE — repo `ipnext-frontend` (apply DESPUÉS del BE verde, B1-B7)

Archivos reales verificados: `src/pages/customers/tabs/contracts/GigaredPanel.tsx` (form de alta,
`splitName` propio líneas 58-67 — YA usa "primer token = lastName", confirma D1),
`src/components/molecules/ActivationHistoryModal/ActivationHistoryModal.tsx` (badge `EventTypeBadge`,
líneas 45-48), `src/types/gigared.ts` (línea 187, union `eventType`).

- [ ] **FE-1** (fix #1) `GigaredPanel.tsx` — catch del submit de alta (~línea 703): ramas nuevas por
  código:
  - **422** `TV_POOL_POISONED` → "No hay CICs limpios en el pool de Gigared; hace falta limpiar el
    pool antes de dar altas" (accionable, NO reintentar en loop; sin CTA de auto-fix — es cleanup de
    datos). Test: mock error 422 → aparece el mensaje.
  - **503** `TV_IDENTITY_UNVERIFIED` → "No se pudo verificar la identidad en Gigared; reintentá" +
    botón reintentar (el retry es idempotente por B2). Test: mock 503 → mensaje + retry.
- [ ] **FE-2** (fix #2) 409 `TV_EMAIL_OWNED_BY_OTHER` en el submit — rama nueva en el
  `if (c === 'NO_CIC_AVAILABLE')`/`setRegisterError(...)`: "Ya existe una cuenta de TV con este
  email, vinculada a otro cliente" + CTA que cambia el foco a "Vincular cuenta existente"
  (`setLinkManual(true)`). El error NO trae `cic` (solo `email`/`ownedByInternalId`) → el operador
  completa el CIC a mano (documentar la limitación). Test: mock 409 → mensaje + CTA.
- [ ] **FE-3** (fix #3) 207 en el POST de alta — sumar lectura de `localReconciled === 'failed'` (D3)
  con el MISMO patrón visual que el 207 de link (`linkSyncNotice`, retry = re-submit idéntico,
  idempotente por B2). Test: mock `localReconciled: 'failed'` → banner + botón reintentar.
- [ ] **FE-4** (fix #5) `ActivationHistoryModal.tsx` — `EventTypeBadge` (líneas 45-48) gana una rama
  `if (type === 'transferencia') return <span className={styles.badgeTransferencia}>Transferencia</span>;`
  (ANTES del fallback genérico a Reactivación) + clase CSS `badgeTransferencia`. `src/types/gigared.ts:187`
  — union `eventType` gana `'transferencia'`. Test: fila `eventType: 'transferencia'` → badge
  "Transferencia", NO "Reactivación".
- [ ] **FE-5** (OPCIONAL, con B8) `GigaredPanel.tsx` — inputs `firstName`/`lastName` del form (líneas
  863-873) pasan a **readonly** (prefill de `splitName(customer.name)` intacto). El payload puede
  seguir mandando `...form` (BE los ignora, D1). Test: los inputs no aceptan `onChange`/están
  `disabled`, el valor sigue siendo el prefill derivado.

---

## Activación en vivo (runbook, fuera del repo) — regla dura, NO tasks de código

CERO writes reales al partner Gigared en TODO este change — desarrollo y CI corren 100% contra
fakes/in-memory. Antes de cualquier ejercicio real:

- [ ] Deploy con B1-B7 (+ FE) verdes, sin flag (Decisión E — aditivo, 207 superset de 201, sin
  migración).
- [ ] El usuario aprueba explícitamente el PRIMER register/link/transfer EN VIVO post-deploy (patrón
  K2 SmartOLT).
- [ ] **Smoke 0 (minas)**: medir cuántos CICs del pool `unregistered` traen `internal_id` no vacío
  (minas pre-fix). Si el pool queda sin CICs limpios, el fix #1 corta altas con `TV_POOL_POISONED` →
  limpiar el pool manualmente antes de confiar.
- [ ] Smoke 1 (anti-poison): registrar un cliente y confirmar que el CIC elegido salió del subconjunto
  LIMPIO (no heredó un `internal_id` ajeno).
- [ ] Smoke 2 (recovery): simular un parcial y confirmar que el retry NO duplica ni re-cobra un CIC.
- [ ] Smoke 3 (lista): confirmar que un cliente con transferencia previa (ej. Centeno/Vacherand, ya
  resuelto manualmente) aparece con el titular CORRECTO en `GET /accounts`.
- [ ] Smoke 4 (Historial TV): tras el próximo `transfer-tv` real, confirmar el evento `transferencia`
  para AMBOS clientes.
- [ ] Smoke 5 (forense baja): tras la próxima `baja` real con renew, confirmar que el evento `baja`
  lleva `renewCic:{newCic}` en el `reason`.
- [ ] Rollback disponible: revertir el change (sin migración de datos que deshacer).

---

## Desvíos / decisiones de esta fase (RE-SCOPE + spec ↔ design ↔ prod)

- **#0 — RE-SCOPE por root cause CONFIRMADO (2026-07-22, engram `gigared/root-cause-cic-envenenado`)**:
  la auditoría completa (AuditEvent) REFUTÓ la teoría inicial ("operador en la página equivocada").
  El incidente lo causó el CÓDIGO: `CancelTv`→`renewCic` deja CICs envenenados en el pool
  `unregistered` (con el `internal_id` del dueño viejo, imposible de limpiar por #72), y el register
  elegía uno AL AZAR sin verificar (`RegisterGigaredAccount.ts:113-116`). Consecuencias del re-scope:
  - **SUBE a fix #1 (B1)**: anti-envenenamiento del pool (filtrado en memoria + verificación
    post-stamp + 2 errores nuevos). Es la causa raíz.
  - **ELIMINADOS del scope**: la verificación del seq (ex-B1) y su fix condicional (ex-B1b). La
    auditoría probó que NO hubo link antes del manual y que el `seq=0` del incidente era CORRECTO
    (alta fresca de un cliente NO cancelado) → el seq/link NO fue causal (ver design D5). El gap del
    guard de `LinkCustomerToCic` queda como NOTA de deuda, no como task.
  - **DEGRADADO a OPCIONAL (B8, último)**: el nombre BE-authoritative (ex-D1/A). La forense probó
    página correcta + nombre correcto → no fue el vector. Se conserva el split APELLIDO-primero.
  - **AGREGADO fix #6 (B6)**: `newCic` del `renewCic` en el evento `baja` (forense de minas futuras).
  - **SE MANTIENEN**: recovery/207/lista/transferencia (renumerados B2-B5, B7).
  - **DEUDA CARDEADA (no v1)**: report read-only de CICs envenenados del pool. El fix #1 ya neutraliza
    el impacto operativo (saltea/corta las minas), así que el report es cleanup/observabilidad, no
    correctitud; reusa el MISMO filtro del D-pool → cero re-trabajo cuando entre como fast-follow.
- **#1 — Split APELLIDO-primero (D1, ahora en B8)**: verificado contra prod ("VACHERAND SILVIO
  GABRIEL", "CENTENO MIGUEL ANGEL"; el email del incidente `centeno12213` es el PRIMER token) + el
  helper FE `splitName` (`GigaredPanel.tsx:58-67`) ya usa esa convención hace meses. El `design.md`
  original asumía "último token = lastName" — refutado y corregido. Ahora vive en el batch OPCIONAL.
- **#2 — Transferencia en el Historial TV global (fix #5, D7/B5)**: sumado por reporte del usuario,
  verificado en vivo (CIC 0006938875/Centeno transferido → CERO filas en `tv_activation_events`).
  Spec nueva `service-transfer` (ADDED TV-3, sin tocar su spec hermana). Aditivo e independiente.
- **#3 — `LinkCustomerToCic` sin guard de re-alta**: confirmado por lectura del constructor (6
  params, ninguno es `ClientTvActivationRepository`). Bajo el root cause confirmado, esto NO participó
  en el incidente (no hubo link antes del manual) → **DEUDA documentada, no task** (ex-B1b eliminado).
- **#4 — `RegisterGigaredAccount.usecase.test.ts` no trae `name` en su `fakeCustomerLookup`**: B8.2
  debe extender ese helper (agregar `name` opcional, default neutro ej. `'CLIENTE TEST'`) sin romper
  los tests existentes. (Solo relevante si B8 entra.)
- **#5 — Naming del resultado 207 (D3)**: `localReconciled: 'synced'|'failed'` es campo NUEVO,
  INDEPENDIENTE de `credentialsPersisted` (booleano, semántica adyacente, sobre credenciales, no
  sobre el reconcile). B3.2 lo introduce sin reemplazar `credentialsPersisted`. `sdd-verify` no debe
  confundir ambos.
