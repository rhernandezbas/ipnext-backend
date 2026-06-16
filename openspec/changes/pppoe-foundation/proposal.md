# Proposal: PPPoE Service Foundation (Fase A del épico `pppoe-service`)

## Intent

Modelar en Prominense la relación **`cliente → contrato → pppoe → router`** (tabla permanente `PppoeService`) y **poblarla una sola vez** con un **script one-off** que barre los `/ppp secret` de los ~9 routers MikroTik y los cruza contra los clientes de GR. Esta fase es el **cimiento**: sin el vínculo persistido `pppoe ↔ nasId`, ni el management (Fase B) ni los cortes (Fase C) tienen sobre qué pararse.

**Regla del usuario (2026-06-15):** el barrido + matching + carga es **un SCRIPT de una sola vez, fuera de `src/`** — NO se desarrolla como feature de la app (sin use case, sin rutas, sin runner). La app solo recibe el **modelo** (tabla + entidad + repo), que es lo permanente que consumen B y C.

## Why

- El backend NO tiene dónde guardar el username PPPoE: `pppoeUsername` solo es transitorio en `GrContract`, nunca se persiste.
- NO existe el vínculo cliente↔router: ni `Client` ni `Contract` tienen `nasId`. Sin ese dato no se sabe a qué MikroTik pegarle.
- El estado (deudor/activo) ya es espejo de GR; el backend será el **ejecutor** que lo propaga a la red — pero primero necesita el mapa de quién-está-en-qué-router.
- Ese mapa es **one-off**: los `/ppp secret` de cada router son la verdad técnica de qué username vive en qué BRAS. Se barre una vez, se cruza con GR, se carga, y listo. No amerita maquinaria permanente en la app.

## Scope

### In Scope

**App (permanente — el modelo):**
- **Entidad de dominio `PppoeService`** con: `username`, `password`, `profile`, `remoteAddress` (nullable), `status`, `contractId` (**nullable** — soporta huérfanos sin match), `nasId` (router).
- **Tabla Prisma `PppoeService`** + **migración aditiva** (tabla nueva; FK a `Contract` y `NasServer`, ambas con la cardinalidad correcta para multi-contrato). Índices por `username` y `contractId`.
- **Port `PppoeServiceRepository`** + adapter Prisma + adapter in-memory (lo usarán B/C).
- Tests TDD del modelo/repo (in-memory + Prisma shape).

**Script one-off (fuera de `src/`, p.ej. `scripts/pppoe-import/`):**
- Conexión directa a los routers (RouterOS API, lib a confirmar) — read `/ppp secret print detail`.
- Lectura de clientes desde el **mirror GR local** (`Client`/`Contract` ya sincronizados) o GR on-demand.
- **Matching fuzzy** `nombre+apellido+dirección` / `apellido+nombre+dirección` (ver design).
- Carga (insert) en `PppoeService` vía Prisma directo (idempotente por `username`).
- **Reporte** (CSV/log): matcheados · huérfanos sin contrato (Agote/Gowland ~500-700 esperados) · ambiguos (multi-candidato / multi-contrato) para revisión manual.

### Out of Scope

- **El import como feature de la app** (use case + rutas + runner) — es script one-off, NO ensucia `src/`.
- **Adapter RouterOS "de la app"** (read/write reutilizable) → **Fase B** (cuando se necesite para provisioning/cortes). El script usa su propia conexión RouterOS.
- **Management** (crear/editar/mover/baja con aprovisionamiento) → **Fase B**.
- **Cortes / enforcement** → **Fase C**.
- **Adapter RADIUS CoA** → futuro.
- **FE / UI** → Fase B/C.
- **Reconciliación continua** router↔Prominense → posterior; esto es un import inicial repetible a mano.

## Capabilities

### New Capabilities

- `pppoe-inventory`: modelo `PppoeService` (la pieza de app). El import vive como script one-off, documentado pero NO como capacidad de runtime.

### Modified Capabilities

- Ninguna. Aditivo (tabla, ports, entidad nuevos). No toca `Client`/`Contract`/`NasServer` salvo la relación inversa opcional.

## Approach

1. **Modelo (app)**: entidad `PppoeService` + migración aditiva `CREATE TABLE "PppoeService"` (`contractId` nullable, `nasId`, `username` indexado). SQL generado con `prisma migrate diff` (sin DB local).
2. **Port + repos (app)**: `PppoeServiceRepository` (upsert/list/findByUsername/findByContract) con Prisma + in-memory.
3. **Script one-off**: standalone en `scripts/pppoe-import/` (ts-node, `node-routeros` + CSV de GR + Prisma directo). Barre los routers, lista secrets, **matching en cascada** (username exacto → fallback fuzzy por nombre → huérfano), upsert `PppoeService` con `nasId` del router; huérfanos (Agote/Gowland) → `contractId = null`. Best-effort por router. Throttle entre routers. Emite reporte (matched-username / matched-fuzzy / orphan / ambiguous).
4. **Tests TDD**: del modelo/repo (app). El script es one-off: se valida con un dry-run contra data real (Phase 0) + el reporte, no con suite permanente (aunque la **función pura de matching/normalización** SÍ se testea — es la parte riesgosa).

## Phase 0 — RESUELTO (2026-06-16)

**(a) Conectividad:** usuario `prominense` (grupo `write-api`, API 8728) creado en los 13 routers; **12/13 alcanzables** desde la red interna (solo Acceso Sur `10.64.10.2` filtrado — resolver antes del apply). **(b) Shape verificado** (Canepa, 736 secrets, 89% online): `name` username **100%**, `remote-address` IP fija **100%**, `profile` **incluye `IP-REDUCCION`** (= corte, ya existe), `comment` solo 43% y ruidoso, **sin dirección ni apellido separado**. → matching por username (no por nombre+apellido+dirección). `node-routeros` confirmada. Detalle en `design.md` (Phase 0 RESUELTO).

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `prisma/schema.prisma` | Modified | + `model PppoeService` (`contractId` nullable, `nasId`, FKs) |
| `prisma/migrations/<ts>_pppoe_service/migration.sql` | New | `CREATE TABLE` aditivo + índices |
| `src/domain/entities/pppoeService.ts` | New | Entidad de dominio |
| `src/domain/ports/PppoeServiceRepository.ts` | New | Port de persistencia |
| `src/infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts` | New | Adapter Prisma |
| `src/infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository.ts` | New | Adapter in-memory |
| `scripts/pppoe-import/` | New (one-off) | Script standalone: barrido + matching + carga + reporte. **Fuera de `src/`, no entra al build** |
| `package.json` | Modified | + lib RouterOS (a confirmar) como `devDependency` (la usa el script, no la app) |

> **NO se tocan**: `app.ts`, rutas, use cases. El import no es runtime de la app.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Backend/host sin ruta de red a los routers | Alta | **Phase 0 (a)** antes de codear |
| Matching fuzzy: falsos positivos (vincular un PPPoE al cliente equivocado) | Alta | Umbral conservador + bucket "ambiguo" para revisión manual + el script NO auto-resuelve dudosos; reporte revisable antes de confirmar |
| ~500-700 Agote/Gowland sin match | **Esperado** | Van como huérfanos (`contractId null`), NO se descartan; quedan en el inventario para linkear después |
| Clientes con +1 contrato | Media | El modelo soporta N `PppoeService` por cliente (vía `contractId`); el matching desambigua por dirección/plan y manda los multi-contrato dudosos a revisión |
| Campos del secret insuficientes para matchear | Media | **Phase 0 (b)**: ver data real antes de fijar el algoritmo |
| Falsos negativos (no matchea uno que sí está) | Media | Huérfano + reporte; re-correr el script es idempotente |

## Rollback

Aditivo y reversible. Rollback = `git revert` + `DROP TABLE "PppoeService"`. El script es one-off y no deja runtime. Re-correrlo es idempotente (upsert por `username`). Nada productivo consume aún el inventario.

## Dependencies

- Lib RouterOS (a confirmar en el design) — solo para el script (devDependency).
- `NasServer` cargados con credenciales API válidas de los 9 routers.
- Mirror GR (`Client`/`Contract`) poblado para el cruce.
- Phase 0 (a)+(b) resuelto antes del apply.

## Success Criteria

- [ ] Migración aditiva crea `PppoeService` (dry-run rolled-back vs prod OK).
- [ ] El script puebla `PppoeService` con los secrets de los routers alcanzables, `nasId` correcto por router.
- [ ] Huérfanos (Agote/Gowland) cargados con `contractId null` y listados en el reporte.
- [ ] Clientes multi-contrato manejados sin colapsar a 1 PPPoE; dudosos al bucket de revisión.
- [ ] Re-correr el script es **idempotente** (upsert por `username`, no duplica).
- [ ] La función pura de **matching/normalización** tiene tests unitarios.
- [ ] `npm test` verde + `tsc --noEmit` limpio. **`app.ts` / rutas / use cases SIN tocar** (el import no es runtime).
- [ ] DIP preservado (la app no importa la lib RouterOS).
