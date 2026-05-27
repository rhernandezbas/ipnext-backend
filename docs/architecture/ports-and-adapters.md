# Ports & Adapters

## Qué es un port

Un **port** es una interfaz TypeScript en `src/domain/ports/`. Define **qué**
necesita la aplicación, sin decir **cómo** se implementa. Los use-cases dependen
del port; los adapters lo implementan.

Ejemplo — el port upstream de Gestión Real (`src/domain/ports/GestionRealPort.ts`):

```ts
export interface GestionRealPort {
  fetchClients(params: FetchClientsParams): Promise<FetchClientsResult>;
  fetchContractsByClient(grClienteId: string): Promise<GrContract[]>;
}
```

El use-case `SyncGestionRealClients` solo conoce esta interfaz. No sabe que detrás
hay axios, auth MD5 ni paginación: eso es problema del adapter.

## Convención de naming de adapters

Por cada port hay (al menos) dos implementaciones:

| Implementación | Naming | Ubicación | Uso |
|----------------|--------|-----------|-----|
| Producción (PostgreSQL) | `Prisma{Entity}Repository` | `adapters/prisma/` | Runtime real. |
| Test | `InMemory{Entity}Repository` | `adapters/in-memory/` | Tests de use-case. |

Ejemplos reales del mirror GR:

| Port (domain) | Adapter Prisma | Adapter in-memory |
|---------------|----------------|-------------------|
| `GestionRealPort` | `GestionRealClient` (\*) | `InMemoryGestionRealPort` |
| `ClientMirrorRepository` | `PrismaClientMirrorRepository` | `InMemoryClientMirrorRepository` |
| `SyncStateRepository` | `PrismaSyncStateRepository` | (in-memory en tests) |
| `MirrorCountsRepository` | `PrismaMirrorCountsRepository` | `InMemoryMirrorCountsRepository` |

(\*) El adapter upstream de GR se llama `GestionRealClient` (no
`Prisma...`) porque no habla con la DB sino con la API externa por HTTP. Vive en
`adapters/gestion-real/`. Sigue siendo un adapter que implementa un port; solo el
nombre refleja su naturaleza de cliente HTTP.

## Anatomía de un adapter Prisma

`PrismaClientMirrorRepository` (`src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts`)
implementa `ClientMirrorRepository`. Su trabajo:

1. Traducir la entidad de dominio (`GrClient`, `GrContract`) al modelo Prisma.
2. Mapear valores externos a tipos locales (ej. `estado.codigo` GR → enum
   `ClientStatus` local: `1→active`, `2→late`, `4→blocked`, `3/6→inactive`).
3. Hacer upsert idempotente por la business key externa (`grClienteId` /
   `grContratoId`), devolviendo `{ created: boolean }`.

El use-case nunca ve un row de Prisma: recibe un `UpsertResult`.

## Anatomía de un adapter HTTP externo

`GestionRealClient` (`src/infrastructure/adapters/gestion-real/GestionRealClient.ts`):

- Encapsula axios, la URL base y el **auth diario** (`MD5(CUIT + SECRET + "YYYY-MM-DD")`).
- Normaliza las rarezas del payload GR: clientes vienen como **objeto keyed by id**,
  contratos como **array**. Las funciones puras `parseClientsResponse` /
  `parseContractsResponse` aplanan todo a las entities `GrClient` / `GrContract`.
- Exporta esas funciones puras para testearlas sin red.

## El composition root es quien decide

`createApp()` (`src/infrastructure/http/app.ts`) es el único lugar que instancia
adapters concretos con `new`. Allí se elige qué implementación recibe cada
use-case. Cambiar de Prisma a otra DB = cambiar el wiring en un solo archivo, sin
tocar dominio ni aplicación.

## DTOs en el borde

Las routes nunca devuelven entidades crudas: mapean a DTOs (`application/dto/`).
Esto mantiene el contrato HTTP desacoplado del modelo de persistencia.
