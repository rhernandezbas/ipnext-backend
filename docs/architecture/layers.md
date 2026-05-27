# Capas — qué vive en cada una y qué puede importar qué

## domain/

El núcleo puro. **Sin dependencias externas** (ni Express, ni Prisma, ni axios).

```
src/domain/
├── entities/   # Modelos de negocio como interfaces/tipos TS planos.
│               # Ej: gestionReal.ts (GrClient, GrContract), taskCategory.ts, lead.ts.
├── ports/      # Interfaces que la aplicación necesita. Ej: GestionRealPort,
│               # ClientMirrorRepository, SyncStateRepository, CustomerRepository.
└── errors/     # Errores de dominio tipados (DomainError + subclases con `code`).
```

**Regla de import**: un archivo de `domain/` solo importa de `domain/`. Las
entities GR (`gestionReal.ts`) son un buen ejemplo: estructuras planas y
normalizadas, sin rastro del payload crudo de la API externa.

## application/

Los casos de uso. Orquestan dominio + ports. **No conocen infraestructura.**

```
src/application/
├── use-cases/  # Un archivo = un caso de uso. Verbo + sustantivo:
│               # SyncGestionRealClients.ts, CreateTicket.ts, ConvertLeadToClient.ts.
└── dto/        # DTOs de entrada/salida. Nunca se devuelve una entidad Prisma cruda.
```

**Regla de import**: puede importar de `domain/` (vía aliases `@domain/*`). **No**
puede importar de `@infrastructure/*`, `@prisma/client`, ni rutas relativas que
trepen a infraestructura.

Un use-case recibe sus dependencias por **constructor** (inyección), tipadas como
ports. Ejemplo: `SyncGestionRealContracts` recibe `GestionRealPort` y
`ClientMirrorRepository` y nada más.

## infrastructure/

Los adapters concretos y todo lo que toca el mundo exterior.

```
src/infrastructure/
├── adapters/
│   ├── prisma/        # Prisma{X}Repository — implementan los ports contra PostgreSQL.
│   ├── in-memory/     # InMemory{X}Repository / InMemory{X}Port — para tests.
│   ├── jwt/           # JwtAuthAdapter — implementa AuthProvider.
│   ├── splynx/        # SplynxClient + adapters del legacy Splynx.
│   └── gestion-real/  # GestionRealClient — implementa GestionRealPort (HTTP + auth MD5).
├── http/
│   ├── app.ts         # Composition root: instancia adapters, wirea use-cases y routers.
│   ├── routes/        # Un router por feature. Mapea HTTP → use-case → DTO.
│   └── middleware/    # authMiddleware, etc.
├── scheduling/        # GestionRealSyncScheduler + bootstrap (mirror GR).
├── database/          # prisma.ts — instancia compartida del PrismaClient.
└── config.ts          # Validación fail-fast de env vars al import.
```

**Regla de import**: puede importar de `application/` y `domain/`. Es la única
capa autorizada a importar librerías externas.

## Path aliases

Configurados en `tsconfig.json`, resueltos con `tsconfig-paths` (dev) y
`tsc-alias` (build):

| Alias | Apunta a |
|-------|----------|
| `@domain/*` | `src/domain/*` |
| `@application/*` | `src/application/*` |
| `@infrastructure/*` | `src/infrastructure/*` |

Usar siempre los aliases en imports cross-layer. Evitar `../../../`.

## Resumen de la matriz de imports

| Desde \ Hacia | domain | application | infrastructure | libs externas |
|---------------|:------:|:-----------:|:--------------:|:-------------:|
| **domain** | ✅ | ❌ | ❌ | ❌ |
| **application** | ✅ | ✅ | ❌ | ❌ (\*) |
| **infrastructure** | ✅ | ✅ | ✅ | ✅ |

(\*) La aplicación solo usa tipos del estándar de TS. Cualquier import de una
librería de I/O en `application/` es un bug a invertir.
