# Design — actions-worklist

Anclas verificadas (exploración 2026-07-10, main de1842c0). Hexagonal estricta.

## 1. Modelo `OwnershipTransferCase` (migración aditiva)

Clona la forma de `RecaptureLead` (schema:2607-2632) + booleans estilo `closure*Done`:

```prisma
model OwnershipTransferCase {
  id                 String   @id @default(uuid())
  // Lado BAJA (origen) — siempre presente, es el disparador
  sourceContractId   String   @unique          // 1 caso por contrato de baja (idempotencia)
  sourceClientId     String
  motivoBaja         String                    // snapshot del motivo que disparó
  bajaDate           String?                   // L6: HOY SIEMPRE null — el mirror no persiste
                                               // la fecha de baja de GR. Queda en el wire (el FE
                                               // ya lo renderiza); se pobla en un follow-up cuando
                                               // el sync persista raw `baja` (dd-mm-yyyy)
  // Lado ALTA (destino) — null si sin candidato o ambiguo hasta el pick
  targetContractId   String?
  targetClientId     String?
  candidates         Json?                     // [{contractId, clientId, score/keys}] si ≥2
  status             String   @default("pending") // pending | ambiguous | done | dismissed
  dismissReason      String?
  // Check MANUAL (mundo físico) — con rastro
  equipmentReviewed    Boolean  @default(false)
  equipmentReviewedById String?
  equipmentReviewedAt  DateTime?
  detectedAt         DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@index([status])
  @@index([targetClientId])
}
```

Sin FKs duras a Contract/Client (los ids del mirror pueden re-sincronizarse; el caso es un
registro operativo — mismo criterio que RecaptureLead usa SetNull, acá directamente String).
Los checks AUTO NO se persisten (se computan en la lectura).

## 2. Detector — `DetectOwnershipTransferCases` (application/use-cases/actions/)

Patrón `IngestChurnedClients` (scan mirror → upsert idempotente). Deps: ports nuevos finos
sobre el mirror (NO el ClientMirrorRepository entero):

- `OwnershipCaseRepository` (domain/ports): `existsBySourceContract(id)`, `create(input)`,
  `list(filter)`, `listPristineUnpaired(limit)`, `listAllSourceContractIds()`, `getById`,
  `update(id, patch)`, `updateIfPristine(id, patch)` (CAS del re-pareo — fix wave 2),
  `flipToDone(id)` — Prisma + InMemory.
- `ContractPairingReader` (domain/ports): `findTitularityBajas({limit, excludeContractIds})`
  → `{id, clientId, address, startDate, motivoBaja, status}[]`, `getContract(id)` y
  `findActivePairingCandidates({startDate, address, excludeClientId})` → mismos campos.
  (Implementación Prisma sobre Contract; el matching de motivo es
  `motivoBaja ILIKE '%CAMBIO DE TITULARIDAD%'` — tolerante a variantes de mayúsculas.)

**Sin ventana temporal (M2/B1 — decisión aceptada, antes vivía en una margin note):** el
mirror Contract NO tiene `updatedAt` ni persiste la fecha de baja del raw, así que una
ventana `sinceDays` NO es expresable en SQL — el port ya no la promete (la firma es
`{limit, excludeContractIds}`, sin días). El scan queda acotado igual por tres piezas que
se refuerzan:
1. `motivoBaja` es **forward-only** (solo se estampa en filas sincronizadas desde
   2026-07-10) — el universo matcheable nace vacío y crece lento.
2. **Cap por tick QUE DRENA (fix wave 2)**: `take: limit` (el detector pasa 500) +
   **exclusión explícita de las bajas ya caseadas** — el detector obtiene
   `listAllSourceContractIds()` una vez por tick (set acotado: un id por titularidad
   real, cualquier status) y el reader agrega `id NOT IN (...)` (omitido con lista
   vacía). Esta exclusión ES el mecanismo de drenaje: sin ella el WHERE matchea las
   filas ya caseadas para siempre y las mismas `limit` filas ocupan cada batch —
   `createdAt` es la fecha de creación de la fila del mirror, NO la fecha de baja, así
   que el viejo argumento "newest-first drena" era FALSO (el excedente sobre el cap
   starvaba permanente). El orden estable (`createdAt DESC + id ASC`) se mantiene como
   detalle determinístico, no como invariante de drenaje.
3. **Idempotencia como cinturón** (`sourceContractId` único + guard
   `existsBySourceContract` per-baja): cubre las carreras DENTRO del tick — un caso
   creado después del snapshot de ids caseados es un skip barato, no un P2002.

`execute()`:
1. **Re-pareo de prístinos (H1a)** — PRIMERO (así los casos creados en este mismo tick no
   se re-parean contra el mismo estado del mirror): `listPristineUnpaired(limit)` trae los
   casos `pending` SIN target, SIN candidates y con `equipmentReviewed=false` (prístinos —
   nada manual pasó). Por cada uno: `getContract(sourceContractId)` (si ya no está en el
   mirror → skip) y re-correr el pairing: 1 candidato → set target (sigue pending);
   ≥2 → `status: ambiguous` + candidates. 0 → sigue prístino para el próximo tick. Esto
   cierra el dead-end del timing F0: baja y alta con segundos de diferencia vs tick de
   3 min → el caso nace sin target y el tick siguiente lo re-parea. Los casos NO prístinos
   (el operador los tocó de CUALQUIER forma) JAMÁS se re-parean.
   **El write del re-pareo es un CAS (fix wave 2):** AMBAS ramas escriben vía
   `updateIfPristine(id, patch)` — updateMany condicional sobre el shape prístino
   COMPLETO (`{id, status:'pending', targetContractId:null, candidates SQL NULL
   (Prisma.DbNull), equipmentReviewed:false}`, el mismo WHERE que `listPristineUnpaired`).
   Un operador puede dismissear o set-targetear por HTTP ENTRE el listado y el write; el
   update incondicional viejo resucitaba el caso descartado (a `ambiguous`, con
   `dismissReason` seteado) o pisaba el target manual. count 0 → skip, NO cuenta como
   `repaired`.
2. `listAllSourceContractIds()` + `findTitularityBajas({limit: 500, excludeContractIds})`
   — cap por tick que drena (ver arriba).
3. Por cada baja del batch (`existsBySourceContract` → skip, cinturón intra-tick): buscar
   candidatos (`startDate` igual + `address` igual + cliente distinto + status activo).
   Address `null` **o en blanco/whitespace** (L5) jamás parea — la key F0 es string-exact.
4. 1 candidato → caso `pending` con target seteado. ≥2 → `ambiguous` + candidates JSON.
   0 → `pending` sin target (visible, resolvible a mano o por el re-pareo del punto 1).
5. **Per-baja try/catch (M2)**: un fallo de create (P2002 por carrera, fila rota) cuenta
   como `skipped++` y NO aborta el resto del batch. Ídem per-caso en el loop de re-pareo.
6. Devuelve `{scanned, created, skipped, repaired}`; NUNCA lanza al scheduler (patrón
   best-effort del runOnce — error swallowed + log, igual que las otras patas).

**Known debt (edge lejano, aceptado):** el repair-loop de prístinos es FIFO con cap
(`listPristineUnpaired(500)`, detectedAt ASC). Si algún día se acumularan >500 casos
prístinos con 0 candidatos PERMANENTES (bajas sin alta pareja que nadie resuelve ni
descarta), los prístinos más nuevos starvarían detrás de ese backlog fijo — el re-pareo
H1a dejaría de alcanzarlos. Hoy es teórico (el universo forward-only es chico y los
0-candidatos se resuelven a mano o se descartan); si aparece, la salida es un cursor
rotativo o excluir prístinos con N re-intentos fallidos.

Wiring: `GestionRealSyncScheduler` gana una pata opcional `detectOwnershipCases` que corre
DESPUÉS del delta (runOnce:110-116, mismo patrón que syncContractsDelta — inyección opcional,
error swallowed). Construcción en `bootstrapGestionRealSync.ts`, pineada por composition test
(B2/W6 — anti-"detector muerto": import + `new DetectOwnershipTransferCases(` +
`detectOwnershipCases` en el call del scheduler).

## 3. Checks AUTO — `ListOwnershipCases` (computa en lectura)

Deps: caseRepo + `ClientTvCancellationRepository` + `ContractServiceRepository` +
`ServiceCatalogRepository` + `PppoeServiceRepository` + `ContractInventoryRepository` +
lookups de nombre de cliente (patrón prismaContractClientNameLookup de F1).

Por caso (solo los `pending`/`ambiguous` de la página pedida — N acotado por paginación).
**Semántica H2 — `null` significa "no evaluable O no aplica"** (el FE ya renderiza null
como "—"; contrato wire INTACTO):

- `tv`: `null` cuando no hay target, no hay catálogo TV, **o el ORIGEN no tiene rastro de
  TV** — `!isCancelled(source)` Y sin fila TV managed ACTIVA en el contrato origen
  (`getByPair(sourceContractId, tvCatalogId)?.status !== 'active'`): un titular viejo SIN
  TV no tiene nada que transferir y jamás va a llegar a `ok`. `'pending'` solo cuando HAY
  TV que transferir (fila TV viva en el origen, o severed con destino aún sin fila activa).
  `'ok'` = `isCancelled(source)` **Y** fila TV ACTIVA en `targetContractId` (como siempre).
- `pppoe`: `null` cuando no hay target **o el contrato ORIGEN no tiene NINGÚN
  PppoeService** (`findByContract(source)` vacío — nada que migrar, cliente TV-only).
  `'ok'` = existe PppoeService `enabled` con `contractId===target`; si no, `'pending'`.
- `equipment` = `{sourceActive, targetActive}` counts (`listByContract` filter active) +
  el manual `equipmentReviewed` persistido.
DTO `OwnershipCaseDto`: ids + nombres (source/target client), motivo, fechas, status,
candidates (con nombres), checks `{tv, pppoe, equipment}`, manual review info. NUNCA
entidades crudas. `bajaDate` HOY SIEMPRE null (L6 — ver §1).

## 4. Bajas recientes — `ListRecentBajas` (computado, sin tabla)

- `ContractPairingReader.findRecentBajas({excludeTitularity, page, pageSize})` →
  contratos `status='baja'`, paginados. Por default EXCLUYE los de titularidad (esos
  viven en el otro tab).
- **"Reciente" honesto (M3 — decisión, antes vivía en una margin note):** Contract no
  tiene `updatedAt` ni persiste la fecha de baja del raw → un parámetro `days=` NO es
  implementable y NO existe en el port ni en la API. El proxy escrito y testeado es
  `motivoBaja IS NOT NULL`: el campo es forward-only (se estampa desde 2026-07-10), así
  que las bajas históricas del backfill (motivo NULL) quedan FUERA y todo lo listado es
  posterior al rollout. Bonus: el NOT NULL destraba el `excludeTitularity` — el
  `NOT contains` de SQL (que es NULL para motivo NULL) se aplica solo sobre filas con
  motivo, sin el viejo OR de NULL-handling. Orden estable newest-first
  (`createdAt DESC + id ASC`). Revisitar si Contract gana updatedAt o fecha de baja.
- Check retiro: `RetirementOrderReader` (port fino): `hasRetirementTask(contractId, clientId)`
  → existe ScheduledTask cuyo `project.allowsEquipmentRetirement=true` (query Prisma con
  join a Project; schema:1215) que referencia el CONTRATO directamente, **o al cliente
  con `task.contractId IS NULL`** (M4 — una task de retiro de OTRO contrato del mismo
  cliente NO cuenta como orden de esta baja). Devuelve también el taskId para linkear.
- DTO por fila: cliente (nombre/id), contrato (dirección/startDate), motivo,
  `retirementOrder: {exists, taskId?}` + conteo de equipos activos aún en el contrato
  (si quedan equipos y no hay orden → es exactamente la alarma que el usuario quiere ver).
  SIN fecha de baja (no existe en el mirror — ver arriba).

## 5. Router `/api/actions` + RBAC

- `rbac.ts`: `'actions'` a `RBAC_MODULES` (:92-134). Acciones base read/manage (sin custom).
- Migración `2026090200000?_actions_permissions` (timestamp POSTERIOR a la última al momento
  del push — VERIFICAR y renombrar si main avanzó, lección F1): módulo + permisos read/manage
  + grants a super_admin/administrador (patrón exacto 20260717000100_grant_recapture_permissions).
- `createActionsRouter(deps)` (patrón recapture.routes.ts: perms interface + auth en mount):
  - `GET /ownership-cases?status=&page=&pageSize=` — guard `read`. Lista paginada con
    checks. Paging clampeado en el use case (M5): pageSize>100 → 100, negativos/NaN →
    defaults (helper compartido `actions/paging.ts`).
  - `PATCH /ownership-cases/:id` — guard `manage`. Body union:
    `{equipmentReviewed: boolean}` (setea con actor/fecha; false limpia los tres campos;
    SOLO sobre casos abiertos pending/ambiguous — L2, 422 en done/dismissed) |
    `{targetContractId}` — tres ramas (H1b/H1c):
      · caso `ambiguous` → pick por membership en candidates (422 si no está),
      · caso `pending` CON `candidates !== null` → RE-pick por membership (corrige la
        elección errada sin dismiss+reopen),
      · caso `pending` SIN target NI candidates (el 0-candidatos del detector) →
        SET-target validado contra el mirror vía `ContractOwnershipLookup`: el contrato
        existe, NO está en baja y pertenece a un cliente ≠ sourceClientId — si no,
        `INVALID_TARGET_ASSIGNMENT` → 422 sin efectos.
      · cualquier otro estado/forma → 422 `INVALID_CANDIDATE_PICK`.
    | `{status:'dismissed', reason}` (motivo obligatorio; NUNCA desde `done` — L3, 422)
    | `{status:'pending'}` (reabrir desde dismissed; si el caso tiene `candidates` vuelve
      a `ambiguous` Y LIMPIA targetContractId/targetClientId — H1d, el target heredado de
      un pick previo no sobrevive al reopen).
  - `GET /recent-bajas?page=&pageSize=` — guard `read` (SIN `days=` — no implementable,
    ver §4). Mismo clamp de paging.
  - Handlers async con `next(err)` SIEMPRE (lección 504); errores tipados mapeados en el
    statusMap del errorHandler: OWNERSHIP_CASE_NOT_FOUND→404, INVALID_CANDIDATE_PICK→422,
    INVALID_TARGET_ASSIGNMENT→422, INVALID_CASE_TRANSITION→422, DISMISS_REASON_REQUIRED→400.
- **`ContractOwnershipLookup` (decisión H1b):** interfaz estructural en
  `application/use-cases/actions/lookups.ts` (`getContract(id) → {id, clientId, status} | null`)
  que AMBOS adapters de `ContractPairingReader` satisfacen vía su método `getContract` —
  un solo método de lectura nuevo total (lo reusa el re-pareo H1a del detector), sin
  adapter dedicado, e ISP preservada porque el use case solo ve la slice de 3 campos.
- Mount en app.ts (~:2420, junto a recapture): `app.use('/api/actions', createActionsRouter(...))`
  con `requirePerm('actions','read'|'manage')`. Flag known_debt god-object-app.
- **Flip a done (H2 + M1):** el caso pasa a `done` AUTOMÁTICO cuando
  `equipmentReviewed && tv !== 'pending' && pppoe !== 'pending'` — los checks n/a (null)
  NO bloquean; ambos null + reviewed = caso solo-equipos, también flipea. El flip se
  persiste vía `flipToDone(id)` (CAS: `updateMany({where:{id, status:'pending',
  equipmentReviewed:true}})`, count===1) — si el CAS pierde (dismiss concurrente entre la
  lectura y el flip, TOCTOU) el DTO NO sale done: sale el estado real releído. Si el flip
  LANZA (DB caída), best-effort como siempre: DTO done, se re-intenta en la próxima lectura.

## 6. FE — page "Acciones" (design-fe anclas en engram sdd/actions-worklist/explore-fe)

- Sidebar: SubItem bajo Clientes (`Sidebar.tsx:59` patrón) con `actions.read`. Ruta en
  App.tsx bajo customers ANTES del catch-all `:id`, lazy + RequirePermission.
- `AccionesPage.tsx` + `AccionesPage/components/` (patrón RecaptacionPage): molecules/Tabs
  con 2 tabs lazy; cada tab su query (`useOwnershipCases` / `useRecentBajas`, keys
  `['actions','ownership',query]` / `['actions','bajas',query]`, staleTime 30s).
- Tab titularidad: cards de caso (NO DataTable — el checklist pide altura) con
  `CaseChecklist`: AUTO → StatusBadge (active=verde OK / late=pendiente / "—" no evaluable);
  manual → checkbox gateado `<Can permission="actions.manage">`. Botón "Transferir TV"
  (visible si !tvTransferred && target && can('tv.transfer')) → `TransferServiceModal`
  EXTENDIDO: props opcionales `initialTarget?: {id;name}` + `initialTargetContractId?`
  (estado inicial de :156-157; si vienen → arranca en step confirm). Ambiguo → selector de
  candidatos (pick → PATCH). Descartar → ServiceRemovalReasonModal (motivo obligatorio).
- Tab bajas: DataTable (patrón RecaptacionTableView) con StatusBadge del retiro-check
  ("Orden de retiro ✓" verde / "Sin orden de retiro" rojo si quedan equipos, ámbar si no) +
  link a la ficha.
- Invalidaciones: PATCH invalida `['actions']`; el transfer TV ya invalida su set (F1) —
  agregar `['actions']` al onSettled del useTransferTv SOLO si es barato, si no refetch
  del tab al cerrar el modal.

## 7. Testing (Strict TDD)

- Detector: unit con InMemory (bajas con/sin motivo, 0/1/≥2 candidatos, idempotencia por
  sourceContractId único, cliente igual excluido, cap por tick, per-baja try/catch,
  re-pareo de prístinos H1a — prístino gana target / pasa a ambiguous / no-prístino no se
  toca / origen fuera del mirror / address null-blanco; fix wave 2 — el cap drena en
  ticks sucesivos y termina en scan vacío, cinturón intra-tick vía hook en el reader,
  carreras CAS vía hook en listPristineUnpaired: dismiss no resucita en ninguna rama /
  set-target manual no se pisa / sin carrera repaired++).
- ListOwnershipCases: checks AUTO con InMemory de todos los ports (tv ok/pending/null "no
  aplica", pppoe ok/pending/null, sin target → null, flip a done: n/a no bloquean,
  solo-equipos, CAS con dismiss concurrente → NO se pisa, flip que lanza → best-effort,
  clamp de paging).
- ListRecentBajas: retiro-check con y sin task de proyecto retirement (incl. task de OTRO
  contrato → false — M4); exclusión titularidad; motivo NULL excluido (M3); clamp de paging.
- UpdateOwnershipCase: union completa — pick/re-pick/set-target (422 por inexistente/
  mismo-cliente/en-baja), guards L2/L3, reopen que limpia target.
- Rutas: supertest + router real + in-memory (403, validaciones, PATCH union, no-cuelga).
- **Tests de intención Prisma** (patrón fake-db `PrismaPppoeServiceRepository.listAllWhere`):
  `PrismaContractPairingReader.where.test.ts` (where de titularidad + take/orderBy del cap
  + `id notIn excludeContractIds` con guard de lista vacía — fix wave 2,
  where del recientes con NOT NULL + NOT contains, getContract),
  `PrismaOwnershipCaseRepository.where.test.ts` (flipToDone CAS where condicional,
  listPristineUnpaired where, updateIfPristine CAS con el where prístino completo +
  mapeo de data, listAllSourceContractIds select fino — fix wave 2, orden L7) y
  `PrismaRetirementOrderReader.where.test.ts` (OR con la pata cliente restringida M4).
- Composition pins: router/RBAC/migración/errorHandler (incl. INVALID_TARGET_ASSIGNMENT)
  + bootstrap del detector (B2/W6 — import, `new DetectOwnershipTransferCases(`,
  `detectOwnershipCases` en el call del scheduler).
- Scheduler: pata nueva swallowed-error (patrón test del delta).
- FE: Vitest — page render por tab, checklist estados, 1-click abre modal precargado en
  confirm, pick de candidato, descarte con motivo, permisos (sin actions.manage no hay
  checkbox), badge retiro.
