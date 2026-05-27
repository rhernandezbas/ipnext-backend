# Design — task-service-location

## Technical Approach

El cambio es aditivo en todas sus capas. No hay migración destructiva, no hay fallback
complejo. La cadena de datos es:

```
GR API (c.domicilio, c.lat?, c.lng?)
  → parseContractsResponse (GrContract)
    → upsertContract (Service DB)
      → toService (Service domain entity)
        → GET /api/clients/:id/services (HTTP response)
          → frontend auto-complete
```

Cada eslabón es modificado en orden. El backfill llena el gap de los 7 174 existentes
sin tocar la cadena de sync.

## Architecture Decisions

### AD-1 — Campos opcionales en `Service` (nullable, no requeridos)

**Choice**: `address String?`, `lat Float?`, `lng Float?` en Prisma schema. No hay
valor por defecto ni NOT NULL.

**Alternatives**:
- `address String @default("")` — genera strings vacíos que el frontend debería
  distinguir de null. Rechazado — null semántico es más limpio.
- Crear un modelo separado `ServiceLocation` — over-engineering. El Service ya existe
  y la ubicación es un atributo simple, no una entidad propia.

**Rationale**: GR no garantiza domicilio (aunque en práctica casi siempre lo trae).
lat/lng son explícitamente dispersos. Nullable es lo correcto.

### AD-2 — Capturar lat/lng en el parser, tratar `""` como null

**Choice**: En `parseContractsResponse`, leer `c.lat` y `c.lng` del payload GR y
convertirlos a `number | null`. Si `str(c.domicilio)` devuelve `""`, tratar como null.

**Rationale**: La entidad `GrContract` ya tiene un campo `raw: Record<string,unknown>`
que persiste el payload completo, pero el dominio no debería hacer lookups en `raw`.
Es correcto que el parser sea el único lugar que conoce la forma del payload GR.

**Nota sobre el campo lat/lng en GR**: la muestra indica que GR devuelve estos campos
en el objeto contrato directamente (mismo nivel que `domicilio`). Si GR los anida en
`conexiones` u otro subobjeto, el parser necesita ajuste — verificar con un payload real
antes de implementar.

### AD-3 — Backfill como script independiente, no como migración SQL

**Choice**: `prisma/scripts/backfill-service-address.ts` — un script Node/TS ejecutado
con `ts-node`, no en una migración Prisma.

**Alternatives**:
- Migración SQL que llame a GR — imposible desde SQL.
- Migración SQL que copie desde `raw` de algún log — no existe ese log.
- Resetear SyncState cursor y re-correr backfill completo — reutiliza código existente
  pero no re-sincroniza contratos de clientes ya existentes (ver Scheduler: en backfill
  solo toca `createdClientIds`). Requeriría modificar el Scheduler, lo cual aumenta
  el riesgo.

**Rationale**: El script es más simple, más controlado y no perturba la lógica de sync.
Es idempotente (un UPDATE con WHERE `address IS NULL` o siempre — ambos son seguros).

**Detalle del script**:
```
for each Service WHERE grContratoId IS NOT NULL (batch de 50):
  resolve Client.grClienteId via JOIN
  call GestionRealClient.fetchContractsByClient(grClienteId)
  para cada GrContract donde grContratoId matchea:
    UPDATE Service SET address=?, lat=?, lng=? WHERE grContratoId=?
  sleep(100ms)  // no spamear GR
log(updated, skipped, errors)
```

El script agrupa contratos por cliente (1 request GR por cliente, no por contrato).
Esto es importante: si hay 5 servicios del mismo cliente en el batch, se hace 1 solo
request GR.

### AD-4 — `toService` expone los tres campos nuevos

**Choice**: Actualizar la función `toService` en `PrismaCustomerRepository.ts` para
incluir `address`, `lat`, `lng` del row Prisma.

**Rationale**: La entidad de dominio `Service` en `customer.ts` agrega los tres campos.
`toService` es el único lugar que mapea Prisma → dominio para servicios. El cambio es
mecánico.

### AD-5 — No se agrega un nuevo endpoint; se extiende el existente

**Choice**: `GET /api/clients/:id/services` ya existe y devuelve `Service[]`. Los tres
campos nuevos aparecen en la respuesta automáticamente una vez que `toService` los expone.

**Rationale**: No hay razón para crear un endpoint separado. El frontend ya consume este
endpoint para poblar el dropdown de servicios.

## Data Flow Detallado

### Sync path (nuevos contratos desde GR)

```
GestionRealClient.fetchContractsByClient(grClienteId)
  → parseContractsResponse(data, grClienteId)
       c.domicilio → address: str(c.domicilio) || null   ← ya existía, corregir el ""
       c.lat       → lat: num(c.lat) ?? null             ← NUEVO
       c.lng       → lng: num(c.lng) ?? null             ← NUEVO
  → GrContract { ..., address, lat, lng }

PrismaClientMirrorRepository.upsertContract(k)
  data = {
    type, plan, status, startDate,
    address: k.address ?? null,    ← NUEVO
    lat: k.lat ?? null,            ← NUEVO
    lng: k.lng ?? null,            ← NUEVO
  }
  prisma.service.upsert(...)
```

### Read path (endpoint servicios)

```
GET /api/clients/:id/services
  → GetClientServices.execute(clientId)
  → CustomerRepository.listServices(clientId)
  → prisma.service.findMany({ where: { clientId } })
  → rows.map(toService)

toService(row):
  {
    id, type, plan, ip, status, startDate, endDate,
    address: row.address ?? null,   ← NUEVO
    lat: row.lat ?? null,           ← NUEVO
    lng: row.lng ?? null,           ← NUEVO
  }
```

### Backfill path (script one-off)

```
backfill-service-address.ts:
  services = prisma.service.findMany({
    where: { grContratoId: { not: null } },
    include: { client: { select: { grClienteId: true } } },
    take: BATCH_SIZE,
    skip: offset,
  })
  
  // Agrupar por grClienteId para minimizar requests GR
  byClient = groupBy(services, s => s.client.grClienteId)
  
  for (const [grClienteId, clientServices] of byClient):
    contracts = await grClient.fetchContractsByClient(grClienteId)
    for (const svc of clientServices):
      match = contracts.find(c => c.grContratoId === svc.grContratoId)
      if (match):
        await prisma.service.update({
          where: { id: svc.id },
          data: {
            address: match.address || null,
            lat: match.lat ?? null,
            lng: match.lng ?? null,
          }
        })
    await sleep(100)
```

## Schema Changes

### `prisma/schema.prisma` — model Service

```prisma
model Service {
  id           String          @id @default(uuid())
  clientId     String
  grContratoId String?         @unique
  type         String
  plan         String
  ip           String?
  status       String          @default("active")
  startDate    DateTime
  endDate      DateTime?
  address      String?         // ← NUEVO: domicilio de instalación desde GR
  lat          Float?          // ← NUEVO: latitud (dispersa en GR)
  lng          Float?          // ← NUEVO: longitud (dispersa en GR)
  createdAt    DateTime        @default(now())
  client       Client          @relation(fields: [clientId], references: [id], onDelete: Cascade)
  tasks        ScheduledTask[]

  @@index([clientId])
  @@index([status])
}
```

### Migración

Un solo `ALTER TABLE "Service" ADD COLUMN ...` nullable. Prisma lo genera automáticamente
con `npx prisma migrate dev --name service_add_location`. No hay SQL manual requerido.

## Domain Entity Changes

### `src/domain/entities/customer.ts`

```ts
export interface Service {
  id: string;
  type: string;
  plan: string;
  ip: string;
  status: string;
  startDate: string;
  endDate: string;
  address: string | null;   // ← NUEVO
  lat: number | null;       // ← NUEVO
  lng: number | null;       // ← NUEVO
}
```

### `src/domain/entities/gestionReal.ts`

```ts
export interface GrContract {
  grContratoId: string;
  grClienteId: string;
  plan: string | null;
  status: string | null;
  startDate: string | null;
  address: string | null;
  lat: number | null;       // ← NUEVO
  lng: number | null;       // ← NUEVO
  pppoeUsername: string | null;
  modificado: string | null;
  raw: Record<string, unknown>;
}
```

## Test Strategy

Seguimos strict TDD: test rojo primero.

| Test | Tipo | Archivo |
|------|------|---------|
| `parseContractsResponse` captura lat/lng cuando presentes | Unitario | `GestionRealClient.test.ts` |
| `parseContractsResponse` devuelve null lat/lng cuando ausentes | Unitario | `GestionRealClient.test.ts` |
| `parseContractsResponse` convierte `""` domicilio a null | Unitario | `GestionRealClient.test.ts` |
| `upsertContract` persiste address/lat/lng en Service | Integración (InMemory) | `SyncGestionRealContracts.test.ts` |
| `GET /api/clients/:id/services` incluye address/lat/lng en respuesta | Integración (supertest) | `clients.routes.test.ts` |
| Script backfill actualiza Service con datos de GR | Integración (con mock GR) | `backfill-service-address.test.ts` (nuevo, opcional) |

**Nota**: los tests de `upsertContract` usan `InMemoryClientMirrorRepository` para el
port, NO Prisma directo — consistente con las convenciones del proyecto.

## Frontend Coordination Contract

El endpoint `GET /api/clients/:id/services` retorna:

```json
[
  {
    "id": "uuid",
    "type": "internet",
    "plan": "Plan 100Mbps",
    "ip": "10.0.0.1",
    "status": "active",
    "startDate": "2024-01-15T00:00:00.000Z",
    "endDate": "",
    "address": "Av. Corrientes 1234, CABA",
    "lat": -34.6037,
    "lng": -58.3816
  }
]
```

Cuando `address` es null, el frontend hace fallback a `client.address`.
Cuando `lat`/`lng` son null, el mapa no muestra pin (no es error).

## Rollback Plan

- La migración es puramente aditiva (ADD COLUMN nullable). Rollback: migration down
  hace DROP COLUMN — sin pérdida de datos críticos (los datos de address/lat/lng son
  reconstructibles desde GR en cualquier momento).
- El script de backfill es idempotente: re-correrlo no genera inconsistencias.
- Los cambios en parser/upsert son aditivos; si se revierte el código, los campos
  simplemente quedan en null.
