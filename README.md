# Prominense — Backend

Backend de gestión para un ISP: clientes, contratos, servicios, facturación, tickets,
tareas de campo, red (RADIUS/PPPoE, fibra), portal de clientes y mensajería.

Nació como réplica funcional de Splynx y hoy es el sistema propio de IPNEXT. Parte de los
datos de clientes y contratos se alimenta de la API externa de **Gestión Real (GR)** a
través de un mirror read-only; GR está en deprecación planificada.

> El paquete todavía se llama `splynx-replica-backend` en el `package.json` por razones
> históricas. El sistema es **Prominense**.

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js + TypeScript (strict), CommonJS, target ES2022 |
| HTTP | Express 4 |
| Datos | Prisma 7 + PostgreSQL (driver `@prisma/adapter-pg`) |
| Auth | JWT (`jsonwebtoken`) + bcryptjs, cookies. RBAC con permisos granulares |
| Tests | Jest + ts-jest + supertest |
| Integraciones | Gestión Real, IClass, SmartOLT, UISP, Gigared (TV), Chatwoot, RADIUS orchestrator |

## Arquitectura — Hexagonal (Ports & Adapters)

La dirección de dependencias va **siempre hacia adentro**:
`infrastructure → application → domain`. El dominio no conoce a nadie.

```
src/
├── domain/              # Núcleo puro. Sin dependencias externas.
│   ├── entities/        # Modelos de negocio
│   ├── errors/          # Errores de dominio tipados
│   └── ports/           # Interfaces (BillingRepository, AuthProvider, ...)
├── application/         # Casos de uso. Orquestan dominio + puertos.
│   ├── use-cases/       # Un archivo = un caso de uso (CreateTicket, ApplyCreditNote, ...)
│   └── dto/             # DTOs de entrada/salida
├── infrastructure/      # Adapters concretos: acá viven Express, Prisma, JWT, los partners.
│   ├── adapters/        # prisma/ · in-memory/ (tests) · jwt/ · splynx/ · gestion-real/ · ...
│   ├── http/            # app.ts (composition root) · routes/ · middleware/
│   ├── scheduling/      # Schedulers in-process detrás de feature flags
│   ├── database/        # Cliente Prisma compartido
│   └── config.ts        # Validación fail-fast de env vars (revienta al import si falta una)
└── main.ts              # Entry point
```

Dos reglas que no se negocian:

- **DIP estricto**: un use case que importe algo de `infrastructure/` o de Prisma es un bug.
  Se depende del *port*, nunca del adapter.
- **Nunca devolver entidades Prisma crudas** desde un use case o una ruta. Siempre se mapea a DTO.

### Path aliases

Configurados en `tsconfig.json`, resueltos con `tsconfig-paths` (dev) y `tsc-alias` (build):

```
@domain/*         → src/domain/*
@application/*    → src/application/*
@infrastructure/* → src/infrastructure/*
```

Usarlos siempre en imports cross-layer. Nada de `../../../`.

## Arranque

```bash
npm install
cp env.example .env          # completar las variables (config.ts falla rápido si falta alguna)
npx prisma generate
npm run prisma:migrate       # aplica migraciones sobre la DB local
npm run prisma:seed          # datos base (catálogos, RBAC)
npm run dev                  # nodemon + ts-node con hot reload
```

Requiere una PostgreSQL accesible; el `.env` local apunta a `localhost:5432`.

## Scripts

| Script | Qué hace |
|--------|----------|
| `npm run dev` | Nodemon + ts-node con path aliases sobre `src/main.ts` |
| `npm run build` | `tsc` + `tsc-alias` (reescribe los aliases en `dist/`) |
| `npm start` | Corre `dist/main.js` (post-build) |
| `npm test` | Jest — la suite completa |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:coverage` | Jest con coverage |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run prisma:seed` | Ejecuta `prisma/seed.ts` |
| `npm run prisma:studio` | Prisma Studio |

## Testing

TDD estricto: rojo → verde → refactor. El test va primero.

- Los tests viven en `src/__tests__/`, espejando la estructura de capas.
- **Use cases**: se testean con adapters in-memory (`InMemory*Repository`). No se mockea Prisma —
  se usa el port in-memory.
- **Routes**: supertest sobre la app Express con los repos in-memory inyectados.
- El gate antes de cualquier deploy es la **suite completa** (`npm test`) **más** `npm run typecheck`.

## Base de datos

El schema vive en `prisma/schema.prisma` y las migraciones en `prisma/migrations/`.

- Todo cambio de schema se hace con una migración generada (`npm run prisma:migrate`).
  **Jamás se edita el SQL a mano**, salvo transformaciones de datos, que van transaccionales y con guard.
- A producción **siempre** con `prisma migrate deploy` (lo corre el pipeline).
  **Nunca** `migrate dev` contra prod: puede detectar drift y ofrecer un reset destructivo.
- Los catálogos canónicos se bootstrappean en migraciones idempotentes
  (`INSERT ... ON CONFLICT DO NOTHING`), no solo en `seed.ts` — el deploy no corre el seed.

## Deploy

`git push` a `main` **deploya a producción**. No hay staging.

El pipeline (`.github/workflows/deploy.yml`, runner self-hosted) hace `docker build` →
`prisma migrate deploy` → deploy del container → verify. Si una migración falla, el job se cae
y producción no se actualiza.

El estado de cada deploy se confirma con `gh run list` / `gh run watch`, nunca se asume.

## Documentación

| Documento | Para qué |
|-----------|----------|
| [`docs/`](docs/README.md) | Arquitectura real del repo, ADRs, TDRs, glosario de dominio |
| [`CLAUDE.md`](CLAUDE.md) | Contexto y convenciones para agentes de IA |
| [`WORKFLOW-MULTI-REPO.md`](WORKFLOW-MULTI-REPO.md) | Cómo se trabaja: worktrees, SDD, gates, deploy, gotchas |
| [`BACKLOG.md`](BACKLOG.md) | Estado del trabajo de **todo el ecosistema**. Fuente de verdad |
| [`INFRAESTRUCTURA.md`](INFRAESTRUCTURA.md) | Mapa de red y servidores (sin credenciales) |
| [`openspec/`](openspec/) | Artefactos SDD: proposals, specs, designs y tasks por cambio |

## Ecosistema

Este backend es uno de cinco repos que viven uno al lado del otro:

| Repo | Qué es |
|------|--------|
| **ipnext-backend** | Este repo — la API y el dominio |
| **ipnext-frontend** | Panel de administración (React + Vite + CSS Modules) |
| **ipnext-customer-app** | App de clientes finales (Expo + React Native) — consume `/api/portal/*` |
| **ipnext-tecnicos** | App de técnicos de campo (Expo + React Native) — consume `/api/tech/*` |
| **ipnext-noc-collector** | Sensores de fibra del NOC (Rust) — empuja alertas al hub |
| **freeradius-orchestrator** | Servicio sobre FreeRADIUS HA (Python + FastAPI) |

> `/api/portal/*` y `/api/tech/*` son **contratos públicos**: hay apps instaladas en teléfonos
> que no controlamos. Los cambios son **aditivos**. Renombrar, borrar o cambiar el tipo de un
> campo rompe la app en la mano del cliente. Ver `WORKFLOW-MULTI-REPO.md`.

## Credenciales

Ninguna credencial vive en este repo. Los archivos `*-LOCAL.md` están gitignoreados
y es donde cada uno guarda sus accesos. Si una credencial llega a commitearse,
**se rota de inmediato**: borrar el archivo no la saca del historial.
