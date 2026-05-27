# Visión general — Arquitectura hexagonal

El backend está dividido en tres capas concéntricas. La regla de oro es la
**dirección de las dependencias**: siempre apuntan hacia adentro.

```
            ┌─────────────────────────────────────────────┐
            │              infrastructure                  │
            │   Express, Prisma, JWT, Splynx, GestiónReal  │
            │   ┌─────────────────────────────────────┐    │
            │   │           application                │    │
            │   │   use-cases + DTOs                   │    │
            │   │   ┌─────────────────────────────┐    │    │
            │   │   │          domain             │    │    │
            │   │   │  entities · ports · errors  │    │    │
            │   │   └─────────────────────────────┘    │    │
            │   └─────────────────────────────────────┘    │
            └─────────────────────────────────────────────┘

        infrastructure ──▶ application ──▶ domain
        (el dominio no conoce a nadie)
```

## Las tres capas

| Capa | Qué contiene | Puede importar de |
|------|--------------|-------------------|
| **domain** | Entities de negocio, **ports** (interfaces TypeScript), errores tipados (`DomainError`). | Nada externo. Solo otros archivos de `domain/`. |
| **application** | Use-cases (un archivo por caso de uso), DTOs de entrada/salida. | `domain/` (entities, ports, errors). **NUNCA** `infrastructure/` ni Prisma. |
| **infrastructure** | Adapters concretos (Prisma, in-memory, JWT, Splynx, Gestión Real), Express (routes, middleware), config, scheduler. | `application/` y `domain/`. Es la única capa que toca librerías externas. |

## La regla DIP en una frase

> Un use-case depende de un **port** (interfaz en `domain/ports/`), nunca de un
> adapter concreto. Quien decide qué adapter se inyecta es el **composition
> root** (`src/infrastructure/http/app.ts`).

Ejemplo real — `SyncGestionRealClients` (`src/application/use-cases/SyncGestionRealClients.ts`)
recibe por constructor tres **ports**:

```ts
constructor(
  private readonly gr: GestionRealPort,        // domain/ports/GestionRealPort.ts
  private readonly mirror: ClientMirrorRepository, // domain/ports/ClientMirrorRepository.ts
  private readonly state: SyncStateRepository,  // domain/ports/SyncStateRepository.ts
  opts: SyncOptions = {},
) {}
```

En producción el bootstrap (`src/infrastructure/scheduling/bootstrapGestionRealSync.ts`)
le inyecta `GestionRealClient`, `PrismaClientMirrorRepository` y
`PrismaSyncStateRepository`. En tests se le inyectan los `InMemory*`. El
use-case **no cambia**: no sabe que existe Prisma ni axios.

## Composition root

Todo el wiring de DI vive en `createApp()` (`src/infrastructure/http/app.ts`):
instancia adapters, los pasa a los use-cases, y los use-cases a los routers. Es
el único lugar donde se hace `new PrismaXRepository()`. El `main.ts` solo levanta
el server y arranca el sync GR.

## Verificación de la regla

Buscar imports de `@infrastructure`, `@prisma/client` o `PrismaClient` dentro de
`src/application/` debe devolver **cero** resultados. Al momento de escribir esta
doc, así es: la capa de aplicación está limpia de dependencias hacia afuera.

## Deuda técnica honesta

- **`prismaClientLookup` en `app.ts`** (líneas ~319-324): el composition root usa
  `(prisma as any)[model]` con un cast para resolver FKs de scheduling. Funciona y
  vive en infraestructura (lugar correcto), pero el `as any` evade el tipado de
  Prisma. Es una concesión pragmática, no un patrón a replicar.
- **`GlobalSearch` se instancia sin port** (`new GlobalSearch()` en `app.ts`):
  conviene revisar si encapsula acceso a datos sin pasar por un port.
