# IPNext Backend — Claude Code Context

Replica del backend de Splynx para gestión de ISPs. Node + TypeScript + Express + Prisma sobre PostgreSQL, en arquitectura hexagonal estricta.

## Stack

- **Runtime**: Node.js, TypeScript (strict), CommonJS, target ES2022
- **HTTP**: Express 4
- **ORM/DB**: Prisma 7 + PostgreSQL (driver `@prisma/adapter-pg`)
- **Auth**: JWT (`jsonwebtoken`) + bcryptjs, cookies
- **Tests**: Jest + ts-jest + supertest
- **Integraciones externas**: Splynx (adapter dedicado en `src/infrastructure/adapters/splynx`)

## Arquitectura — Hexagonal / Ports & Adapters

El código está dividido en tres capas. La dirección de dependencias va SIEMPRE hacia adentro: `infrastructure → application → domain`. El dominio no conoce a nadie.

```
src/
├── domain/              # Núcleo puro. Sin dependencias externas.
│   ├── entities/        # Modelos de negocio
│   ├── errors/          # Errores de dominio tipados
│   └── ports/           # Interfaces (ej: BillingRepository, AuthProvider)
├── application/         # Casos de uso. Orquesta dominio + puertos.
│   ├── use-cases/       # Un archivo = un caso de uso (CreateTicket, ApplyCreditNote, ...)
│   └── dto/             # DTOs de entrada/salida
├── infrastructure/      # Adapters concretos. Acá vive Express, Prisma, JWT, Splynx.
│   ├── adapters/
│   │   ├── prisma/      # Implementaciones Prisma de los ports
│   │   ├── in-memory/   # Implementaciones in-memory (tests)
│   │   ├── jwt/         # AuthProvider basado en JWT
│   │   └── splynx/      # Cliente del Splynx legacy
│   ├── http/
│   │   ├── app.ts       # Composición de Express + wiring de DI
│   │   ├── routes/      # Routers por feature (admin.routes.ts, billing.routes.ts, …)
│   │   └── middleware/
│   ├── database/
│   └── config.ts        # Validación fail-fast de env vars en import
└── main.ts              # Entry point — solo levanta el server
```

### Convenciones críticas

- **Naming de adapters**: `Prisma{Entity}Repository.ts`, `InMemory{Entity}Repository.ts`. Los archivos en `infrastructure/adapters/prisma/` se renombraron recientemente (ver `f6585e2a`). Respetar esa convención al crear nuevos.
- **Naming de use cases**: verbo + sustantivo, un caso por archivo: `CreateTicket.ts`, `ApplyCreditNote.ts`, `ConvertLeadToClient.ts`.
- **Ports**: van en `domain/ports/` como interfaces TypeScript. Los use cases dependen del port, NUNCA del adapter.
- **DIP estricto**: si encontrás un use case importando algo de `infrastructure/` o de Prisma, es un bug — hay que invertir la dependencia (ver `b708dc89`).
- **DTOs**: nunca devolver entidades Prisma crudas desde un use case ni desde una route. Mapear a DTO.

## Path aliases

Configurados en `tsconfig.json` y resueltos en runtime con `tsconfig-paths` (dev) y `tsc-alias` (build):

```ts
"@domain/*"         → "src/domain/*"
"@application/*"    → "src/application/*"
"@infrastructure/*" → "src/infrastructure/*"
```

Usar SIEMPRE los aliases en imports de cross-layer. Evitar `../../../`.

## Scripts

| Script | Qué hace |
|--------|----------|
| `npm run dev` | Nodemon + ts-node con path-aliases. Hot reload sobre `src/main.ts`. |
| `npm run build` | `tsc` + `tsc-alias` (reescribe los aliases en `dist/`). |
| `npm start` | Corre `dist/main.js` (post-build). |
| `npm test` | Jest. |
| `npm run test:coverage` | Jest con coverage. |
| `npm run prisma:migrate` | `prisma migrate dev`. |
| `npm run prisma:seed` | Ejecuta `prisma/seed.ts`. |
| `npm run prisma:studio` | Prisma Studio. |

**Regla**: no correr `npm run build` por cuenta propia tras editar — el usuario lo decide.

## Testing

- Tests en `src/__tests__/`, espejando la estructura de capas (`application/`, `infrastructure/`, raíz para integration).
- **Use cases**: testear con adapters in-memory (`InMemory*Repository`). NO mockear Prisma directamente — usar el in-memory port.
- **Routes**: supertest sobre la app Express, con repos in-memory inyectados.
- Strict TDD Mode está activo: red → green → refactor. Empezar por el test.

## Base de datos

- Schema en `prisma/schema.prisma`. Migraciones en `prisma/migrations/`.
- Cambios recientes en el modelo: tabla `Project` con FK `projectId` en `ScheduledTask` (`2254a329`, `661b50ba`). El campo es opcional para no romper fixtures (`8048001d`).
- Para cualquier cambio de schema: crear migration con `npm run prisma:migrate`, jamás editar SQL a mano.

## Config y env

`src/infrastructure/config.ts` valida las env vars al import. Si falta alguna, el proceso revienta antes de levantar el server (fail-fast). Ver `env.example` para la lista.

## Estado actual del repo

- Branch principal: `main`.
- Hay cambios refactor recientes hacia DIP estricta y renaming de adapters. Si tocás algo en `infrastructure/adapters/prisma/`, alinear con esa convención.
- Carpeta `openspec/` presente — el proyecto usa SDD (Spec-Driven Development) para cambios sustanciales.

## Qué evitar

- Importar Prisma o Express desde `domain/` o `application/`.
- Devolver entidades Prisma desde routes/use-cases sin mapear a DTO.
- Crear archivos `.md` de documentación salvo que el usuario los pida explícitamente.
- Usar rutas relativas largas (`../../../`) cuando hay path alias.
- Mockear Prisma en tests de use case — usar el port in-memory.
