# Design — contract-node-ap-catalog (Fase A)

## 1. Modelo de datos

### 1.1 `AccessPoint` (NUEVO — catálogo derivado)

```prisma
model AccessPoint {
  id            String       @id @default(uuid())
  uispDeviceId  String       @unique   // UispDevice.uispId — upsert key
  networkSiteId String?
  networkSite   NetworkSite? @relation(fields: [networkSiteId], references: [id], onDelete: SetNull)
  name          String
  mac           String?
  missingSince  DateTime?                 // FIX-2: AP retirado (device desaparecido / no-'ap'). Null si vivo.
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
  contracts     Contract[]                // back-relation (Fase B)
  @@index([networkSiteId])
}
```

- **Es un catálogo DERIVADO**, no una entidad de negocio editable: la fuente de verdad es el mirror de
  UISP (`UispDevice`). Se upsertea por `uispDeviceId`. NUNCA se borra desde el sync (misma disciplina
  que el auto-import de `NetworkSite`).
- No hay FK dura a `UispDevice`: se linkea por `uispDeviceId` TEXT (mismo criterio que
  `UispDevice.uispSiteId`/`NetworkSite.uispSiteId` — el mirror re-upsertea por TEXT y la validación es
  a nivel aplicación, no DB).

### 1.2 Campos nuevos en `Contract` (manual-only)

```prisma
  networkSiteId String?
  networkSite   NetworkSite? @relation(fields: [networkSiteId], references: [id], onDelete: SetNull)
  accessPointId String?
  accessPoint   AccessPoint? @relation(fields: [accessPointId], references: [id], onDelete: SetNull)
  @@index([networkSiteId])
  @@index([accessPointId])
```

- **manual-only**: `PrismaClientMirrorRepository.upsertContract` arma un `const data` WHITELISTEADO que
  EXCLUYE estos campos → el sync de GR nunca los pisa (idéntico a `name`/`gps`/`technology`). Pinneado
  por test en `PrismaClientMirrorRepository.upsertData.test.ts` (el set exacto de keys + asserts de
  ausencia de `networkSiteId`/`accessPointId`).
- Molde de la FK tomado de `ScheduledTask.networkSiteId` (`onDelete: SetNull`, indexado): borrar un
  nodo/AP no borra el contrato, solo desliga.

### 1.3 Nombres de relación de Prisma

No hicieron falta `@relation("...")` explícitos. Prisma solo exige nombrar relaciones cuando **dos o
más relaciones conectan el MISMO par de modelos**. Acá cada relación conecta pares DISTINTOS:
`Contract↔NetworkSite`, `Contract↔AccessPoint`, `AccessPoint↔NetworkSite`, y la ya existente
`NetworkSite↔NetworkSite` (self, ya nombrada `SiteHierarchy`). `NetworkSite` ahora tiene varias
back-relations (`scheduledTasks`, `accessPoints`, `contracts`) pero todas a modelos distintos →
auto-nombrado sin ambigüedad. Confirmado con `npx prisma validate` (schema válido, sin warnings).

## 2. Criterio de AP y link al nodo

- **AP = `UispDevice.role === 'ap'`** (verificado en vivo: 544/4130 devices, en 74 nodos). Los `station`
  / `router` / `null` se ignoran.
- **AP → NetworkSite**: se busca el `NetworkSite` cuyo `uispSiteId === device.uispSiteId`. Si no existe
  (device huérfano, o site aún no sembrado), `networkSiteId = null`. La relación es "best effort" y se
  re-resuelve en cada sync (si el device se mueve de nodo, el AP se re-linkea).

## 3. `SyncUispMirror` — paso 9 (auto-import AccessPoints)

Se corre DESPUÉS del paso 8 (auto-import NetworkSites) porque necesita ver los NetworkSites recién
creados en este tick. Algoritmo:

1. Si no hay `accessPointRepo` (dep opcional) → no-op, contadores 0 (back-compat).
2. Re-leer `networkSiteRepo.findAll()` → `Map<uispSiteId, NetworkSite.id>` (fresco, incluye las
   creaciones del paso 8; reusar el map pre-paso-8 perdería los sites nuevos).
3. Pre-leer `accessPointRepo.findMany()` → `Set<uispDeviceId>` existentes, para clasificar
   created vs updated en los contadores SIN complicar el contrato del port (el upsert sigue siendo un
   upsert simple).
4. Por cada `device` con `role === 'ap'`: resolver `networkSiteId` del map (o null) y
   `upsertByUispDeviceId({ uispDeviceId, networkSiteId, name, mac })`.
5. Contar `accessPointsCreated` / `accessPointsUpdated` y reportarlos en el result + en el JSON de
   `SyncState`.

**Disciplina anti-destrucción** (heredada del sync): NUNCA se borra un AP. Una respuesta de UISP con
`devices: []` (posible truncación) simplemente NO itera nada → el catálogo queda intacto.

### 3.1 FIX WAVE — hardening del paso 9 (post-review adversarial)

- **FIX-1 [HIGH] · aislamiento en try/catch**: TODO el paso 9 va envuelto en `try/catch`. Un fallo del
  catálogo (ej. la tabla `AccessPoint` aún no migrada porque el deploy se adelantó a la migración) NO
  debe abortar el sync: sites/devices ya se persistieron y el `SyncState` "ok" (paso 7, POSTERIOR al
  paso 9) tiene que escribirse igual. Sin este guard, el catch del scheduler reportaría "error,
  itemsSynced:0" en cada tick, enmascarando un sync de sites/devices perfectamente sano. En el catch:
  `console.warn('[uisp-sync] AP catalog step failed:', err)` y seguir (no re-throw); los contadores de
  AP quedan en lo que alcanzaron (0).

- **FIX-2 [MEDIUM] · APs retirados (`missingSince`)**: un AP cuyo device desaparece de UISP o cambia de
  `role` a no-'ap' quedaba stale y seguía asignable. Se agregó `missingSince DateTime?` a `AccessPoint`
  (espeja `UispDevice.missingSince`). El paso 9, tras sembrar los APs actuales, estampa
  `missingSince = syncAt` en los AccessPoints cuyo `uispDeviceId` NO está en el set de devices role='ap'
  de esta respuesta, y lo limpia (`null`) en los que reaparecen — misma disciplina que el step 5.
  - **Guard anti-truncación**: si esta respuesta trajo CERO devices role='ap' (lista vacía o truncada),
    NO se marca nada como missing (`currentApDeviceIds.size > 0`), igual que los steps 4-6 no marcan con
    lista vacía. Congelar todo el catálogo por un hipo del proxy sería catastrófico.
  - **Timestamp**: se reusa el `syncAt` (`new Date()` computado UNA vez al inicio de `execute()`), no un
    `new Date()` nuevo — mismo criterio que el resto del sync.
  - **El filtrado NO va acá**: el paso 9 SOLO marca el estado. Los APs `missingSince != null` siguen en
    el catálogo. **Es la Fase B (selector de asignación contrato→AP) la que los filtra** — no se listan
    como asignables, pero el histórico de contratos ya asignados a un AP retirado no se rompe.
  - Port: `markMissing(uispDeviceIds, since)` / `clearMissing(uispDeviceIds)` (keyeado por
    `uispDeviceId`); Prisma con `updateMany` chunked (200), `markMissing` solo pisa donde `missingSince`
    es null (preserva la fecha original).

- **FIX-3 [LOW] · role case-insensitive**: el match es `(device.role ?? '').toLowerCase() === 'ap'` —
  si UISP devuelve `'AP'`/`'Ap'` igual se siembra.

- **FIX-4 [LOW] · sin double-count**: un `uispDeviceId` repetido en la misma respuesta se cuenta UNA vez
  (set `seen`), sin inflar `accessPointsCreated`/`Updated`. El upsert sigue siendo idempotente.

## 4. Port `AccessPointRepository`

```ts
interface UpsertAccessPointInput { uispDeviceId: string; networkSiteId: string | null; name: string; mac: string | null; }
interface AccessPointRepository {
  upsertByUispDeviceId(input: UpsertAccessPointInput): Promise<AccessPoint>;
  findMany(): Promise<AccessPoint[]>;
  findByNetworkSiteId(networkSiteId: string): Promise<AccessPoint[]>;
  findById(id: string): Promise<AccessPoint | null>;
  markMissing(uispDeviceIds: string[], since: Date): Promise<void>;   // FIX-2
  clearMissing(uispDeviceIds: string[]): Promise<void>;               // FIX-2
}
```

- `PrismaAccessPointRepository` — `prisma.accessPoint.upsert` por `uispDeviceId`.
- `InMemoryAccessPointRepository` — Map keyeado por `uispDeviceId`, `seed()` y `size` como test seams.
- `SyncUispMirror` depende del PORT (dep opcional en el constructor, 6º arg), nunca del adapter.

## 5. Migración

Aditiva pura, generada con `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script`
(sin DB local): `ADD COLUMN Contract.accessPointId/networkSiteId` (nullable), `CREATE TABLE AccessPoint`
(incluye `"missingSince" TIMESTAMP(3)` nullable — FIX-2, regenerada ya que la migración es LOCAL y no se
pusheó), índices (`AccessPoint_uispDeviceId_key` unique, `AccessPoint_networkSiteId_idx`,
`Contract_networkSiteId_idx`, `Contract_accessPointId_idx`) y 3 FKs `ON DELETE SET NULL`. Sin DROP, sin
backfill, sin `BEGIN/COMMIT` (Prisma envuelve). Archivo:
`prisma/migrations/20260910000000_add_accesspoint_and_contract_node_ap/migration.sql`.

**Nota FIX-5 (higiene)**: el diff de `schema.prisma` había explotado a 911 líneas. La causa NO era
LF→CRLF (el archivo ya estaba en LF; `core.autocrlf=true`) sino la re-alineación de columnas de TODO el
schema que hace `prisma format`. Se restauró el formato de `main` (`git checkout main -- schema.prisma`)
y se re-aplicaron SOLO las ~38 líneas reales a mano, sin `prisma format`. Diff final: 38 inserciones,
0 borrados. `prisma validate` OK, `prisma generate` OK.

## 6. Wiring

`bootstrapUispSync.ts` construye `new PrismaAccessPointRepository()` y lo pasa como 6º arg a
`SyncUispMirror` (junto al `networkSiteRepo`). `SyncUispMirror` no se arma en `app.ts` (solo se le pasa
el `UispSyncScheduler` ya construido) → el wiring vive en `bootstrapUispSync.ts`. El composition-test
(`uisp-composition.test.ts`) pinnea que el 6º arg no se caiga en silencio (guard idéntico al de
`networkSiteRepo`), replicando el riesgo "tests in-memory verdes pero prod no siembra".

## 7. Fases siguientes (fuera de este cambio)

- **Fase B** — rutas/use-cases de asignación: `AssignContractNode` / `AssignContractAccessPoint`, con
  validación de que el AP pertenezca al nodo elegido; UI (picker de nodo + AP en la ficha de contrato).
- **Fase C** — segment builder del bulk por nodo/AP: extender `ListSegmentRecipients` con filtro por
  `Contract.networkSiteId` / `Contract.accessPointId`.
