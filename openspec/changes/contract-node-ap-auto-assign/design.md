# Design — contract-node-ap-auto-assign (Fase B)

## 1. Cadena de derivación (visión completa)

```
Contract
  ↑ contractId                       (PppoeService → Contract, 1:N; selección: el 'enabled' más reciente)
PppoeService
  → MAC del CPE (cascada §4):        (1) callerId  (2) último RadiusEvent.macAddress por username
  ↓ normalizeMac (§3) en AMBOS lados del join
UispDevice (role='station', viva)    match por mac normalizada; desempate §6.2
  → apUispDeviceId                   ESLABÓN NUEVO (§2) ← raw.attributes.apDevice.id
AccessPoint (uispDeviceId @unique)   catálogo Fase A, ya poblado (544 en prod)
  → { id → Contract.accessPointId, networkSiteId → Contract.networkSiteId }
```

La llave del join pppoe↔mirror es **MAC, NO IP**: `UispDevice.ip` es la IP de management
(`raw.ipAddress`, `UispClient.ts:76`) y jamás coincide con la Framed-IP PPPoE.

## 2. Cobertura medida (spike prod + probe NMS, 2026-07-16)

**Spike en prod (DB Prominense):**

| Métrica | Valor |
|---|---|
| `PppoeService` total | 5456 |
| ... con `callerId` no vacío | **231 (4.2%)** ← el cuello de botella real |
| De esos 231, matchean una MAC de `UispDevice` | **184 (79.7%)**, 100% role=`station` |
| ... y además tienen `contractId` | **183** |
| MACs duplicadas en `UispDevice` (normalizadas) | **130** → política de desempate obligatoria (§6.2) |
| Formato de `callerId` | con `:` y case mixto → normalización NECESARIA en ambos lados |
| Catálogo Fase A en prod | 544 `AccessPoint` (0 missing), 74 `NetworkSite` con `uispSiteId`, mirror fresco (~5 min) |

**Probe en vivo contra el NMS (`/v2.1/devices`, 2026-07-16):**

| Métrica | Valor |
|---|---|
| Devices totales | 4130 (3385 stations, 544 APs) |
| Stations con `attributes.apDevice.id` | **3346 (98.8%)** |
| ... cuyo `apDevice.id` existe como device role='ap' en la MISMA respuesta | **100%** |
| Stations sin `apDevice` | 39 (24 disconnected, 15 active); `uplinkDevice` no ayuda (0) |
| MACs duplicadas en la respuesta VIVA (normalizadas) | **0** → los 130 dups del spike son filas del mirror (stale/missing), ver §6.2 |

**Implicaciones (deciden el diseño):**

1. Con solo `callerId`, el auto-assign cubriría ~183 contratos — inaceptable. La fuente masiva de MAC
   es el accounting RADIUS ya espejado (`RadiusEvent`: `username` + `macAddress` + `status`), poblado
   por el ingest cada 5 min. → **cascada de resolución de MAC (§4) es parte del scope**, no opcional.
   Con `RadiusEvent` de fuente, la cota esperada ≈ todos los PPPoE enabled con sesión RADIUS reciente
   cuya MAC matchea una station del mirror (techo: ~3346 stations linkeables). El número real
   post-deploy es la métrica `assigned` del primer run (visible en `SyncState`).
2. El join es CONFIABLE cuando hay dato (79.7% de match con solo callerId, 100% stations) — el 20.3%
   sin match (equipos fuera de UISP, MACs de routers propios, fibra) es exactamente el público del
   **picker manual**, que mantiene protagonismo.
3. El eslabón station→AP NO necesita llamadas extra (§3): viene en el mismo payload.

## 3. D1 — Eslabón station→AP: `attributes.apDevice` (NO `/data-links`)

`UispClient.mapDevice` (`src/infrastructure/adapters/uisp/UispClient.ts:53`) hoy solo lee
`identification` + `overview` + `raw.ipAddress`. El payload crudo de `/v2.1/devices` trae MÁS:
verificado en vivo, cada station incluye:

```json
"attributes": {
  "ssid": "Hornet9_Canepa",
  "apDevice": {
    "type": "airMax",
    "siteId": "5467e4d0-...",
    "name": "Canepa Hornet9 ...",
    "model": "RP-5AC-Gen2",
    "id": "b8ad3503-02e9-40de-a7b0-18b7ffc28830"   ← UISP device id del AP
  }
}
```

`apDevice.id` ES el `identification.id` del AP = **`AccessPoint.uispDeviceId` directo** (la upsert
key del catálogo Fase A) — ni siquiera hace falta pasar por la MAC del AP.

**Dos rutas evaluadas:**

| | (A) `attributes.apDevice.id` en `/devices` | (B) `GET /v2.1/data-links` |
|---|---|---|
| Llamadas extra | **0** (mismo payload que ya se consume) | +1 por tick (payload grande, from/to por link) |
| Mapeo | 1 campo null-safe en `mapDevice` | parsear grafo from/to, filtrar wireless, orientarlo |
| Resiliencia a APs no adoptados | `apDevice` ausente → `null` (degrada solo esa station) | link ausente → igual, pero con superficie de fallo extra (endpoint nuevo, timeout propio) |
| Identidad que entrega | device id del AP (== upsert key del catálogo) | device ids de ambas puntas (igual utilidad, más trabajo) |
| Evidencia | verificada en vivo: 98.8% de cobertura, 100% resoluble | no necesaria |

**Decisión: (A).** Cumple el criterio "1 sola llamada extra máx" con CERO llamadas extra y es la
representación que el propio UISP usa para pintar la columna "AP" de sus grillas. (B) queda
documentada como fallback si alguna versión futura de UISP dejara de exponer `attributes`.

**Cambios:**

- `UispDevice` (entity `src/domain/entities/uisp.ts`): campo nuevo
  `apUispDeviceId: string | null` — *"UISP device id del AP al que está asociada la station
  (`attributes.apDevice.id`). Null para APs, routers y stations sin AP reportado. NO es FK interna."*
- `mapDevice`: `const attributes = (raw['attributes'] ?? {})`; `const apDevice = attributes['apDevice'] ?? null`;
  `apUispDeviceId: apDevice ? (apDevice['id'] as string) ?? null : null`.
- `prisma/schema.prisma` `UispDevice`: `apUispDeviceId String?` (sin índice: el consumo es
  `listAll()` → Map en memoria, nunca WHERE por esta columna).
- `PrismaUispDeviceRepository.upsert`: agregar el campo a `create` y `update` (whitelist explícito,
  `PrismaUispDeviceRepository.ts:57`). `InMemoryUispDeviceRepository`: idem.
- El paso 9 del sync NO cambia (el AP se sigue sembrando igual); el campo nuevo viaja por el upsert
  de devices del paso 3 y queda fresco en cada tick.

## 4. D3 — Resolución de MAC por contrato: CASCADA

### 4.1 Cascada

Para cada `PppoeService` candidato (§6.1):

1. **`callerId`** — si `normalizeMac(callerId)` devuelve una MAC válida → se usa. (231 filas hoy;
   crece sola por el write-through on-demand de `GetPppoeCallerId`.)
2. **`RadiusEvent`** — si no, la MAC del "mejor" evento del `username`: entre eventos con
   `macAddress != null`, se prefiere `status='online'` (stoppedAt IS NULL); si no hay online, el de
   `startedAt` más reciente. UNA query batch para todos los usernames (§8), jamás N+1.
3. Sin MAC por ninguna vía → derivación **no resuelve** (§6, fila "no toca").

Métricas separadas: `macFromCallerId` / `macFromRadiusEvent` — para observar la cascada en prod.

### 4.2 Tradeoff: ¿backfill de `callerId` desde `RadiusEvent`?

Evaluado y **descartado en este change**:

| | Cascada read-time (elegida) | Backfill write-through a `callerId` |
|---|---|---|
| Resultado del auto-assign | idéntico | idéntico |
| Escrituras | 0 extra | ~5k updates una vez + doble-escritura continua |
| Ownership | `callerId` sigue siendo del feature `persist-caller-id` (lo escribe SOLO `GetPppoeCallerId`) | el auto-assign pasaría a escribir un campo ajeno — acopla features |
| Semántica de `callerId` | "última MAC VISTA por el inspector" (intacta) | cambiaría a "última MAC según RADIUS" sin que ningún consumidor lo pida |
| Costo si RADIUS trae basura | contenida al run del auto-assign | persistida en la fila del pppoe |

El write-through natural + la cascada convergen al mismo lugar sin migrar data. Si más adelante otro
consumidor necesita `callerId` poblado, el backfill se hace como change propio (una corrida
`UPDATE ... FROM`), no acá.

## 5. D4 — `AutoAssignContractNetwork`: use case APARTE, invocado post-sync

**Decisión: use case nuevo, NO paso 10 de `SyncUispMirror`.** Justificación:

1. **Bloat de dependencias**: `SyncUispMirror` ya tiene 6 deps y 9 pasos; el auto-assign necesita 4
   puertos más (`PppoeServiceRepository`, `RadiusEventRepository`, `ContractRepository`,
   `AccessPointRepository` re-usado). Un ctor de 10 args es una señal de SRP roto.
2. **Ciclo de vida propio**: flag propio (`contract-network-auto-assign`) → se puede apagar la
   escritura DURA sin apagar el mirror; `SyncState` propio (`entity='contract-network-auto-assign'`)
   → métricas observables sin mezclar con las del mirror; y un trigger manual futuro
   (`POST /api/.../auto-assign`) lo reusa sin tocar el sync.
3. **Testeabilidad**: la matriz §6 se testea con 5 in-memory repos sin arrastrar sites/devices/steps
   del mirror.

**Invocación**: `UispSyncScheduler.runOnce()` — tras `this.sync.execute()` exitoso, DENTRO del scope
del advisory lock (`uisp-sync`) para que dos réplicas no auto-asignen en paralelo:

```
const result = await this.sync.execute();
this.log(...done...);
if (this.autoAssign) {
  try {
    const flag = await this.flags.get('contract-network-auto-assign');
    if (flag?.enabled) {
      const aa = await this.autoAssign.execute();
      this.log(`[uisp-sync] auto-assign done — assigned=${aa.assigned} unresolved=${aa.unresolved} ...`);
    }
  } catch (err) {
    console.warn('[uisp-sync] auto-assign step failed:', err);   // NUNCA rompe el run del sync
  }
}
```

- `autoAssign?: AutoAssignContractNetwork` = 6º ctor arg opcional del scheduler (back-compat: todos
  los call-sites existentes siguen compilando).
- Flag NUEVO `contract-network-auto-assign`: `flags.get()` de una key inexistente devuelve null →
  `!flag?.enabled` → skip ⇒ **dark por default**, sin seed.
- El fallo del auto-assign NO persiste `lastResult='error'` del mirror (ese pertenece al sync); el
  use case persiste su PROPIO `SyncState` (ok o error) — ver §7.
- Wiring en `bootstrapUispSync.ts` (composition root del sync): construye los repos Prisma y pasa el
  use case al scheduler. Pin en `uisp-composition.test.ts` (mismo patrón que el 6º arg de Fase A).

### Algoritmo (todo en memoria, §8)

1. `pppoeRepo.list()` → candidatos: `status==='enabled' && contractId != null`. Agrupar por
   `contractId` y elegir UNO por contrato: el de `createdAt` más reciente (§6.1).
2. Resolver MAC por cascada (§4). Contratos sin MAC → `unresolved`.
3. `uispDeviceRepo.listAll()` → `Map<macNormalizada, UispDevice[]>` de **stations vivas**
   (`role==='station'` case-insensitive, `missingSince === null`, `mac != null`).
4. Match + desempate (§6.2) → station → `apUispDeviceId`; null → `unresolved`.
5. `accessPointRepo.findMany()` → `Map<uispDeviceId, AccessPoint>` → AP local; ausente → `unresolved`.
6. `contractRepo.getNetworkAssignments(contractIds)` → estado actual; si
   `(networkSiteId, accessPointId)` ya coincide → `unchanged` (sin write).
7. Diferentes → `contractRepo.updateNetworkAssignment(contractId, { networkSiteId: ap.networkSiteId,
   accessPointId: ap.id })` secuencial → `assigned`.
8. Persistir `SyncState` + devolver métricas.

Idempotente por construcción: segunda corrida con la misma data ⇒ todo `unchanged`, 0 writes.

## 6. D5 — Semántica AUTO DURA: matriz de casos

> **DECISIÓN CONFIRMADA** (usuario + orquestador, 2026-07-16 — ver §14): el sync escribe SIEMPRE que
> la derivación resuelva — **pisa lo que haya, incluso una asignación manual**. Si NO resuelve, **no
> toca** (jamás nullea algo existente).

### 6.1 Matriz

| # | Caso | Acción | Métrica |
|---|---|---|---|
| 1 | Deriva OK + contrato sin asignación previa | escribe `networkSiteId` + `accessPointId` | `assigned` |
| 2 | Deriva OK + asignación previa DISTINTA (manual o auto) | **PISA ambos campos** | `assigned` |
| 3 | Deriva OK + asignación previa IGUAL | no escribe | `unchanged` |
| 4 | Derivación NO resuelve (cualquier eslabón roto: sin pppoe enabled, sin MAC, sin station viva, station sin `apUispDeviceId`, AP no en catálogo) | **NO TOCA lo existente** | `unresolved` |
| 5 | Match de MAC AMBIGUO tras desempate (§6.2) | **NO TOCA** + `console.warn` con mac + candidatos | `ambiguous` |
| 6 | `PppoeService` sin `contractId` | fuera del universo (no se evalúa) | — |
| 7 | Contrato con N pppoe | se evalúa SOLO el `status='enabled'` de `createdAt` más reciente; con 0 enabled ⇒ caso 4 | — |
| 8 | Station con `missingSince != null` | excluida de candidatos (el mirror dice que ya no existe) ⇒ tiende a caso 4 | `unresolved` |
| 9 | AP resuelto con `missingSince != null` | **SE ASIGNA IGUAL** — hay una station viva colgada de él: evidencia más fuerte que el marcador del catálogo (lag del mirror). El filtro `missingSince` es SOLO para el picker (§9). *(confirmado §14.1)* | `assigned` |
| 10 | AP resuelto con `networkSiteId = null` (AP sin nodo linkeado) | escribe `accessPointId = ap.id` y `networkSiteId = null` — el par persistido SIEMPRE es coherente con el AP; puede nullear un site manual. *(confirmado §14.2)* | `assigned` |

### 6.2 Duplicados de MAC en `UispDevice` — política de desempate

El spike encontró 130 MACs duplicadas en el mirror; la respuesta VIVA de UISP tiene 0. Conclusión:
los duplicados son filas STALE (devices retirados/re-adoptados que quedaron con `missingSince`).
Política, en orden:

1. Candidatos = devices con `mac` normalizada igual **y** `role='station'` (case-insensitive) **y**
   `missingSince === null`. (El filtro de vivas elimina la mayoría de los 130 dups.)
2. Si quedan >1: gana el de `lastSeenAt` estrictamente más reciente.
   **NOTA — corrección sobre la sugerencia original (`lastSyncAt`)**: `lastSyncAt` NO discrimina —
   el sync lo estampa UNIFORME para toda la respuesta de cada tick
   (`SyncUispMirror.ts:65`, `upsert({ ...device, lastSyncAt: syncAt })`), así que dos filas vivas
   siempre empatan. `lastSeenAt` (`overview.lastSeen`) sí es una señal por-device.
3. Si empatan también en `lastSeenAt` (ambos null o iguales) → **AMBIGUO: skip + log, jamás asignar**
   (fila 5 de la matriz).

## 7. Métricas y observabilidad

`AutoAssignContractNetworkResult`:

```ts
interface AutoAssignContractNetworkResult {
  contractsEvaluated: number;   // contratos con pppoe enabled candidato
  assigned: number;             // escrituras efectivas (filas 1, 2, 9, 10)
  unchanged: number;            // derivó igual a lo persistido — sin write
  unresolved: number;           // algún eslabón no resolvió — no se tocó
  ambiguous: number;            // dup de MAC sin desempate — no se tocó
  macFromCallerId: number;      // cascada nivel 1
  macFromRadiusEvent: number;   // cascada nivel 2
  durationMs: number;
}
```

Se persiste en `SyncState` `entity='contract-network-auto-assign'`
(`lastResult: 'ok: {json}'`, `itemsSynced: assigned`; en catch interno del use case:
`lastResult: 'error: <msg>'`). Rollout: prender el flag → mirar este JSON tras el primer tick.

## 8. D6 — Perf (~3500 stations, ~5456 pppoe)

Todo el join es **lookup en memoria** — exactamente 5 reads batch + writes solo-diff:

| Paso | Query | Volumen |
|---|---|---|
| pppoe candidatos | `pppoeRepo.list()` (existente) | ~5456 filas |
| MACs RADIUS | `radiusEventRepo.latestMacByUsernames(usernames)` — 1 query agregada (`DISTINCT ON` en Prisma `$queryRaw`, chunked de a 1000 usernames), NUNCA N+1 | ~5k usernames |
| Mirror devices | `uispDeviceRepo.listAll()` (existente) → Map por MAC normalizada | ~4130 filas |
| Catálogo APs | `accessPointRepo.findMany()` (existente) → Map por uispDeviceId | ~544 filas |
| Asignaciones actuales | `contractRepo.getNetworkAssignments(ids)` — 1 query proyectada `{id, networkSiteId, accessPointId}` | ~3.5k ids |
| Writes | `updateNetworkAssignment` secuencial SOLO para diffs | 1ª corrida ≲3300; siguientes ~0 |

Referencia: el sync ya hace ~4130 upserts secuenciales por tick sin problema; la 1ª corrida del
auto-assign está por debajo de eso y las siguientes son ~read-only.

## 9. D7 — Picker manual (BE)

### 9.1 Use case `SetContractNetworkAssignment`

Molde: `UpdateContractLocation` (`src/application/use-cases/UpdateContractLocation.ts`).

```ts
interface SetContractNetworkAssignmentCommand {
  contractId: string;
  networkSiteId?: string | null;   // undefined = no tocar; null = limpiar
  accessPointId?: string | null;
}
```

Validaciones (errores tipados nuevos en `src/domain/errors/networkAssignment.ts`, extienden
`DomainError`):

| Regla | Error | HTTP |
|---|---|---|
| Al menos una de las dos keys presente | (zod en la ruta) | 400 |
| Contrato existe | `ContractNotFoundError` (existente) | 404 |
| `networkSiteId` non-null existe | `NetworkSiteNotFoundError` | 422 |
| `accessPointId` non-null existe | `AccessPointNotFoundError` | 422 |
| AP con `missingSince != null` NO es asignable manualmente | `AccessPointRetiredError` | 422 |
| AP y site ambos non-null ⇒ `ap.networkSiteId === networkSiteId` | `AccessPointNotInSiteError` | 422 |

**Invariante de coherencia del par persistido** — `accessPointId != null ⇒ networkSiteId === ap.networkSiteId`:

- `accessPointId` non-null con `networkSiteId` omitido → se autocompleta `networkSiteId = ap.networkSiteId`.
- Solo `networkSiteId` non-null (AP omitido) → si el AP actual del contrato NO pertenece al nuevo
  site, se limpia (`accessPointId = null`).
- `networkSiteId: null` explícito → limpia AMBOS (desasignar el nodo desasigna el AP). *(confirmado §14.3)*
- `accessPointId: null` explícito → limpia solo el AP; el site queda.

Devuelve `ContractNetworkAssignmentResult { id, networkSiteId, accessPointId }` (patrón
`ContractLocationResult` — nunca entidad Prisma cruda).

### 9.2 Use case `ListAssignableAccessPoints`

- Input `{ networkSiteId?: string }` → `accessPointRepo.findByNetworkSiteId(id)` o `findMany()`.
- Filtra `missingSince === null` en memoria (~544 filas, cero cambios de port) — los APs retirados NO
  se listan como asignables, pero los contratos ya asignados a uno no se rompen (Fase A FIX-2).
- DTO `AccessPointOptionDto { id, name, mac, networkSiteId }`, orden `name` asc.
- El catálogo de NODOS no necesita endpoint nuevo: `GET /api/network-sites` ya existe (auth-gated,
  `app.ts:1896`); el FE lo reusa.

### 9.3 Rutas

| Ruta | Gate | Handler |
|---|---|---|
| `GET /api/access-points?networkSiteId=` | auth + `requirePerm('network','read')` | `ListAssignableAccessPoints` → `{ data: AccessPointOptionDto[] }` |
| `PATCH /api/contracts/:id/network-assignment` | auth + `requirePerm('contracts','assign')` | zod whitelist `{ networkSiteId?, accessPointId? }` → `SetContractNetworkAssignment` |

- `GET /access-points`: router NUEVO `accessPoints.routes.ts`
  (`createAccessPointsRouter(listAssignable, requirePerm?)`), montado en `app.ts` con
  `createAuthMiddleware` (patrón `/api/network-sites`, `app.ts:1893-1896`).
- `PATCH`: se agrega a `contracts.routes.ts` (patrón EXACTO de `PATCH /contracts/:id/location`,
  `contracts.routes.ts:74`: dep opcional → 501 si falta, zod → 400, typed errors → 404/422, fallback
  `next(err)` para Express 4).

### 9.4 Permiso granular

**`(module: 'contracts', action: 'assign')`** — CERO cambios de TS: el módulo `contracts` y la action
`assign` ya existen en `KNOWN_ACTIONS`/`RBAC_MODULES` (`src/domain/entities/rbac.ts:78,127`; `assign`
nació para recapture). Solo falta SEEDEAR la fila `RbacPermission` + grant a `super_admin`, con
migración idempotente (patrón `20260908000100_messaging_bulk_permissions`):

```sql
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'assign' FROM "RbacModule" m WHERE m."code" = 'contracts'
ON CONFLICT DO NOTHING;
-- + grant a super_admin (INSERT ... SELECT ... ON CONFLICT DO NOTHING)
```

Alternativa evaluada: action nueva `assign_network` — descartada (exige tocar `KNOWN_ACTIONS` y no
agrega granularidad real: `contracts.assign` no colisiona con ningún uso actual del módulo).
El GET del catálogo usa `network.read` (existente, ya seedeado).

## 10. D8 — Cambios de ports (exactos)

```ts
// RadiusEventRepository (+1 método)
/**
 * Batch: para cada username, la macAddress del "mejor" evento — prefiere status='online'
 * (stoppedAt IS NULL); si no hay online, el de startedAt más reciente. Solo eventos con
 * macAddress != null. UNA query agregada (DISTINCT ON, chunked), jamás N+1.
 * Map SIN entrada para usernames sin ningún evento con MAC.
 */
latestMacByUsernames(usernames: string[]): Promise<Map<string, string>>;

// ContractRepository (+2 métodos)
/** Batch read proyectado para el auto-assign (skip de sin-cambio). Solo ids existentes. */
getNetworkAssignments(contractIds: string[]): Promise<Array<{ id: string; networkSiteId: string | null; accessPointId: string | null }>>;
/**
 * Escribe SOLO networkSiteId/accessPointId (whitelist, jamás campos GR). Compartido por
 * auto-assign y picker manual. Null = limpiar. Devuelve null si el contrato no existe.
 */
updateNetworkAssignment(id: string, data: { networkSiteId: string | null; accessPointId: string | null }): Promise<ContractNetworkAssignmentResult | null>;
```

- `PrismaRadiusEventRepository.latestMacByUsernames`: `$queryRaw` con
  `SELECT DISTINCT ON (username) username, "macAddress" FROM "RadiusEvent" WHERE username = ANY($1)
  AND "macAddress" IS NOT NULL ORDER BY username, ("stoppedAt" IS NULL) DESC, "startedAt" DESC`,
  chunked de a 1000. In-memory: réplica JS de la MISMA semántica (test de paridad).
- `AccessPointRepository`, `UispDeviceRepository`, `PppoeServiceRepository`: **sin cambios de
  interface** (todo lo necesario ya existe: `findMany`, `listAll`, `list`).
- `UispDevice` entity + adapters ganan `apUispDeviceId` (§3).

## 11. Migraciones (2, aditivas)

1. `prisma/migrations/20260916000000_uispdevice_ap_link/migration.sql` — generada con
   `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script` (patrón Fase A, sin DB
   local): `ALTER TABLE "UispDevice" ADD COLUMN "apUispDeviceId" TEXT;`. Sin DROP, sin backfill (la
   columna se puebla sola en el próximo tick del sync). Sin `BEGIN/COMMIT`.
2. `prisma/migrations/20260916000100_contract_network_assign_permission/migration.sql` — seed SQL a
   mano (los seeds RBAC no salen de `migrate diff`): permiso `(contracts, assign)` + grant a
   `super_admin` + `administrador` (§14.7 — corrección sobre "admin", que no es un `RbacRole` code en
   este sistema), todo `ON CONFLICT DO NOTHING` (idempotente, patrón
   `20260908000100_messaging_bulk_permissions`).

Timestamps posteriores a `20260910000000_add_accesspoint_and_contract_node_ap` (la última). Higiene
FIX-5 de Fase A: editar `schema.prisma` A MANO (sin `prisma format`) para no re-alinear todo el
archivo.

**Orden deploy/migración**: la columna nueva la escribe el sync — si el deploy corre antes que la
migración, el upsert de devices FALLA (columna inexistente) y el scheduler reporta error del tick
(comportamiento pre-existente para cambios del mirror; se recupera solo tras migrar). El auto-assign
además nace con flag OFF ⇒ ningún write duro hasta prenderlo.

## 12. Testing (Strict TDD — Jest + in-memory, NUNCA mockear Prisma)

| Suite | Cubre |
|---|---|
| `src/__tests__/domain/services/macNormalize.test.ts` | `normalizeMac`: `AA:BB:..`, `aa-bb-..`, `aabb.cc..` (Cisco), sin separador, case mixto, inválidas (longitud ≠12 hex, vacía, null, con IP) → null |
| `src/__tests__/infrastructure/UispClient.apdevice.test.ts` | `mapDevice`: `attributes.apDevice.id` presente → `apUispDeviceId`; `attributes`/`apDevice`/`id` ausentes → null (patrón `UispClient.address.test.ts`, http inyectado) |
| `InMemoryUispDeviceRepository` + Prisma pin | upsert persiste/actualiza `apUispDeviceId` (paridad in-memory) |
| `src/__tests__/infrastructure/adapters/in-memory/InMemoryRadiusEventRepository.latestMac.test.ts` | `latestMacByUsernames`: prefiere online, fallback más reciente, ignora mac null, username sin eventos ausente del Map, batch multi-username |
| `InMemoryContractRepository` | `getNetworkAssignments` (proyección, ids inexistentes omitidos) + `updateNetworkAssignment` (escribe/limpia/null si no existe; NO toca otros campos) |
| `src/__tests__/application/use-cases/AutoAssignContractNetwork.test.ts` | **matriz §6 completa**: filas 1-10 + desempate §6.2 (dup con missing gana viva; dup vivas desempata lastSeenAt; empate → ambiguous) + cascada §4 (callerId gana; fallback RadiusEvent; contadores) + idempotencia (2ª corrida ⇒ unchanged, 0 writes) + métricas + SyncState ok/error |
| `src/__tests__/application/UispSyncScheduler.test.ts` (extender) | post-sync invoca autoAssign SOLO con flag on; error del autoAssign NO rompe el run ni el resultado del sync; sin autoAssign inyectado → no-op |
| `src/__tests__/application/use-cases/SetContractNetworkAssignment.test.ts` | tabla de validaciones §9.1 + invariante de coherencia (autocompletar site, limpiar AP al mover site, null explícitos) |
| `src/__tests__/application/use-cases/ListAssignableAccessPoints.test.ts` | filtra missingSince, filtro por networkSiteId, orden por name, DTO shape |
| `src/__tests__/infrastructure/accessPoints.routes.test.ts` (supertest) | 200 lista asignables, 401 sin auth, 403 sin permiso, query param |
| `src/__tests__/infrastructure/contracts.networkAssignment.routes.test.ts` (supertest) | PATCH 200 / 400 (body vacío o key desconocida) / 404 / 422 (cada typed error) / 403 / 501 sin dep |
| `uisp-composition.test.ts` (extender) | pin: `bootstrapUispSync` arma `AutoAssignContractNetwork` con adapters Prisma y lo pasa al scheduler (guard "tests verdes pero prod no asigna") |
| `src/__tests__/infrastructure/migration.uispdevice_ap_link.test.ts` | SQL solo aditivo: `ADD COLUMN "apUispDeviceId"`, sin DROP (patrón `migration.networksite_uisp_link.test.ts`) |
| Pin permiso | migración seed contiene `('contracts','assign')` + grant super_admin, todo ON CONFLICT |

## 13. Riesgos y rollout

| Riesgo | Mitigación |
|---|---|
| AUTO DURA pisa asignaciones manuales legítimas | decisión explícita del usuario (§6, re-confirmar); flag de apagado inmediato; métricas por corrida; fila 4 garantiza que NUNCA se nullea por no-match |
| MAC del CPE ≠ station (cliente con router propio detrás de la antena) | el `callerId`/RADIUS ve la MAC del equipo que DISCÓ el PPPoE; si ese equipo no es la antena, no matchea el mirror ⇒ `unresolved` (no toca) — el picker manual cubre |
| `RadiusEvent` con MAC vieja (cliente se mudó de antena hace meses y no reconectó) | se prefiere sesión online; el stale-assign se corrige solo en la próxima sesión; aceptado (mismo tradeoff que cualquier fuente pasiva) |
| Duplicados de MAC en mirror | política §6.2 — jamás asignar ambiguo |
| Deploy antes que migración | §11 — error de tick recuperable + flag OFF |
| Carga de la 1ª corrida (~3300 writes) | secuencial dentro del tick (cota: el sync ya upsertea 4130/tick); corridas siguientes ~0 writes |

**Rollout**: deploy + migraciones → tick siguiente puebla `apUispDeviceId` → prender flag
`contract-network-auto-assign` → leer `SyncState` (`assigned/unresolved/ambiguous`) → validar
muestras en la ficha de contrato → dejar prendido. El picker manual sirve desde el deploy (no
depende del flag).

## 14. Preguntas ABIERTAS — RESUELTAS (usuario + orquestador, 2026-07-16, confirmado antes del apply)

1. **Matriz fila 9** (AP retirado `missingSince != null` con station viva colgada) → **DECISIÓN: se
   asigna IGUAL**. La station realmente cuelga de ese AP — es evidencia de red más fuerte que el
   marcador `missingSince` del catálogo (que solo refleja lag del mirror). Confirma el texto
   propuesto en §6.1 fila 9; se retira la marca "(re-confirmar)".
2. **Matriz fila 10** (AP sin nodo, `ap.networkSiteId = null`) → **DECISIÓN: par coherente** — se
   escribe `accessPointId = ap.id` y `networkSiteId = null`. El par persistido en `Contract` SIEMPRE
   refleja el AP resuelto, nunca un site "heredado" de una asignación previa que ya no aplica.
   Confirma §6.1 fila 10; se retira la marca "(re-confirmar)".
3. **Picker manual — `networkSiteId: null` explícito** → **DECISIÓN: limpia también el AP** (par
   coherente, mismo principio que 2). Confirma §9.1 "desasignar nodo limpia todo"; se retira la marca
   "(re-confirmar)".
4. **Permiso** → **DECISIÓN: REUSO de la action existente `assign`** como `(contracts, assign)`. Cero
   cambios de TS — `contracts` (RBAC_MODULES) y `assign` (KNOWN_ACTIONS) ya existen
   (`src/domain/entities/rbac.ts:78,127`). Se descarta la action nueva `assign_network` (no agrega
   granularidad real).
5. **Rechazo de AP retirado en el PATCH manual** → **DECISIÓN: 422** (`AccessPointRetiredError`). El
   operador humano NO puede asignar a mano un AP que el mirror da por retirado — a diferencia del
   AUTO (regla 1), que tiene la señal extra de una station viva. Sin esa señal, el picker manual debe
   ser conservador.
6. **Backfill de `callerId`** → **DESCARTADO, CONFIRMADO**. La cascada read-time (§4.1) converge al
   mismo resultado sin doble-escritura ni acoplar el auto-assign a un campo ajeno (`persist-caller-id`
   sigue siendo el único escritor de `callerId`). Ver tradeoff completo en §4.2 — sigue vigente sin
   cambios.
7. **Roles del seed** → **DECISIÓN: `super_admin` + `administrador`**, CON UNA CORRECCIÓN sobre el
   pedido original ("`super_admin` + `admin`"): **no existe un `RbacRole` con code `'admin'`** en este
   sistema. Verificado en `prisma/migrations/20260529000000_auth_rbac_foundation/migration.sql`:
   - Línea 121: `'admin'` es el `code` de un **`RbacModule`** ("Administración"), una tabla distinta.
   - Líneas 147-152: los 6 `RbacRole.code` seedeados son `super_admin`, `administrador`,
     `administracion`, `ventas`, `noc`, `tecnico` — **sin `'admin'`**.
   - El equivalente semántico de "admin" en este sistema es **`administrador`** ("Dueño/jefe del
     negocio"), confirmado por el propio comentario del seed (`prisma/seed.ts:374`: *"'administrador'
     es el equivalente RBAC-system de 'admin'"*) y por el patrón EXACTO de la migración más reciente
     comparable (`20260908000100_messaging_bulk_permissions`), que grantea sus permisos a
     `super_admin` + `administrador`.
   - **Migración 20260916000100 grantea `(contracts, assign)` a `super_admin` + `administrador`**,
     mismo patrón, todo `ON CONFLICT DO NOTHING`.
