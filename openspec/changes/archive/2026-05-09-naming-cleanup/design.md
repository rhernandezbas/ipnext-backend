# Design: Naming Cleanup — Prisma Adapters & ReportRepository Port

## Technical Approach

Refactor mecánico en dos commits atómicos. **Commit 1**: rename `InMemory*Repository` → `Prisma*Repository` en los archivos `Prisma*.ts` (25 clases) + actualizar 24 imports en `app.ts` + JSDoc de deuda IPv6. **Commit 2**: introducir `ReportRepository` port en `domain/ports/`, hacer que los 3 use-cases (`ExportReport`, `GenerateReport`, `ListReportDefinitions`) tipen su constructor contra el port (no contra la implementación concreta), y mantener `InMemoryReportRepository` como adapter legítimo en `adapters/in-memory/` (genera datos sintéticos en runtime). Sin cambios de comportamiento. TS strict + suite de tests como red de seguridad.

> **Discrepancia con la propuesta**: la propuesta dice "23 clases + 1 mixta = 24". Verificación con `rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/` arroja **25 clases** a renombrar (la propuesta omite 2). `PrismaProjectRepository.ts` ya está correcto. La estrategia no cambia, solo el conteo.

## Architecture Decisions

| Decisión | Elegido | Alternativa rechazada | Rationale |
|----------|---------|------------------------|-----------|
| Ubicación del port | `src/domain/ports/ReportRepository.ts` | `src/application/ports/` | Convención del proyecto: 31 ports existentes viven en `domain/ports/`. DIP estricto: el port pertenece al lado del consumidor abstracto (domain) en hexagonal. |
| Tipos auxiliares (`ReportDefinition`, `ReportResult`, `ReportType`) | Reutilizar los existentes en `src/domain/entities/report.ts` | Mover/duplicar dentro del port | Ya están en domain. Crear nuevas entities sería duplicación. El port solo importa de entities. |
| Mantener `InMemoryReportRepository` como adapter | Sí, sin migrar a Prisma | Migrar a Prisma con seed de tablas | Out of scope. Los reports se generan en runtime con datos sintéticos; no hay tabla en `schema.prisma`. El adapter es legítimamente in-memory por diseño. |
| Estrategia de rename (archivo + clase + imports) | Rename SOLO clase + imports en un commit; nombre de archivo se mantiene (ya es `Prisma*.ts`) | Rename de archivo también | Los archivos YA se llaman `Prisma*.ts`. La propuesta es renombrar la CLASE EXPORTADA dentro del archivo, no el archivo. |
| Forma de aplicar el rename | `sd 'class InMemoryXRepository' 'class PrismaXRepository'` por archivo + `sd` para imports en `app.ts` | TS rename refactor del IDE | Sub-agente: find-replace exacto con verificación post-cambio (`tsc --noEmit` + `rg`). Determinístico. |
| NO renombrar `in-memory/` directorio | Mantener nombre | Renombrar a `test-doubles/` | Out of scope. El directorio sí contiene clases legítimamente in-memory (`InMemoryMonthlyBillingRepository`, `InMemoryReportRepository`). El nombre es correcto. |
| Big-bang vs incremental | Big-bang en 2 commits | Por adapter (25 commits) | Sin cambios de comportamiento. TS strict atrapa cualquier omisión. 25 commits inflarían historia sin valor. |

## Data Flow

Pre-cambio (commit 1):

    app.ts ──imports──> InMemoryCpeRepository (en Prisma*.ts)  ❌ naming engañoso

Post-commit 1:

    app.ts ──imports──> PrismaCpeRepository (en Prisma*.ts)    ✅ contrato alineado

Pre-cambio (commit 2):

    GenerateReport ──depende de──> InMemoryReportRepository (concreto)  ❌ DIP roto
                                       │
                                       └── @infrastructure/...

Post-commit 2:

    GenerateReport ──depende de──> ReportRepository (interfaz)      ✅ DIP cumplido
                                       ▲
                                       │ implements
                                       │
                              InMemoryReportRepository
                                       ▲
                                       │ inyectado en
                                  app.ts wiring

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/domain/ports/ReportRepository.ts` | Create | Nuevo port: interfaz `ReportRepository` con `listDefinitions()` y `generateReport()` |
| `src/infrastructure/adapters/prisma/Prisma{Admin,ClientComment,Cpe,CreditNote,Dashboard,Empresa,FinanceHistory,Gpon,Hardware,IpNetwork,Lead,Message,Monitoring,Nas,NetworkSite,Notification,Partner,Proforma,RadiusSession,Role,Scheduling,Settings,Tr069,Ubicacion,Voz}Repository.ts` (25 archivos) | Modify | Rename `class InMemoryXRepository` → `class PrismaXRepository` (clase exportada) |
| `src/infrastructure/adapters/prisma/PrismaIpNetworkRepository.ts` | Modify | Rename + JSDoc en la clase: `/** @todo IPv6 deuda: Ipv6Network no tiene modelo Prisma; almacenamiento en memoria temporal hasta agregar tabla en schema.prisma */` |
| `src/infrastructure/http/app.ts` | Modify | 24 imports + 24 instanciaciones (`new InMemoryX...` → `new PrismaX...`). El import de `InMemoryReportRepository` (línea 232) se mantiene SIN cambios (es legítimo). El import de `InMemoryMonthlyBillingRepository` (línea 25) también se mantiene (vive en `in-memory/`). |
| `src/application/use-cases/ExportReport.ts` | Modify | Constructor `repo: ReportRepository` (interfaz). Eliminar import de `@infrastructure/*`. |
| `src/application/use-cases/GenerateReport.ts` | Modify | Idem. Constructor tipado contra port. |
| `src/application/use-cases/ListReportDefinitions.ts` | Modify | Idem. |
| `src/infrastructure/adapters/in-memory/InMemoryReportRepository.ts` | Modify | Agregar `implements ReportRepository` a la clase. Sin cambios funcionales. |
| `prisma/schema.prisma`, migrations, tests | Untouched | Sin cambios |

## Interfaces / Contracts

```typescript
// src/domain/ports/ReportRepository.ts
import { ReportDefinition, ReportResult, ReportType } from '@domain/entities/report';

export interface ReportRepository {
  getDefinitions(): ReportDefinition[];
  generateReport(type: ReportType, filters: Record<string, string>): ReportResult;
}
```

Métodos sincrónicos (no `Promise`) — coinciden con la implementación actual de `InMemoryReportRepository` que retorna data sintética sin I/O. Si en el futuro se persiste, se cambia el contrato a `Promise<>` (refactor mayor — out of scope).

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | Use-cases (`ExportReport`, `GenerateReport`, `ListReportDefinitions`) compilando contra la interfaz | Tests existentes deben pasar SIN modificación. Si rompen, hay regresión. |
| Compile-time | TypeScript strict valida que `InMemoryReportRepository` implementa `ReportRepository` | `npx tsc --noEmit` debe pasar |
| Integration | `app.ts` wiring: la instancia inyectada en use-cases sigue siendo la misma | Smoke: levantar servidor + hit endpoint `/reports` retorna 200 |
| Regression | Suite completa (61 tests) | `npm test` debe pasar al 100% sin modificaciones |

**STRICT TDD nota**: como NO hay nueva lógica (es rename + introducción de port), no aplica el ciclo red→green→refactor en su forma estricta. Lo que sí aplica: los tests existentes son la red de seguridad — DEBEN pasar antes y después de cada commit. Si fallan, rollback inmediato.

## Verification Commands (post-change)

```bash
# 0 resultados:
rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/

# 0 resultados:
rg "from '@infrastructure/" src/application/use-cases/

# Existe + tipado correcto:
fd ReportRepository.ts src/domain/ports/

# Pasa:
npx tsc --noEmit

# Pasa al 100% (61 tests):
npm test

# Smoke (manual): levantar servidor, GET /reports debe responder igual que antes.
```

## Migration / Rollout

No requiere migración. Cada commit es atómico y reversible con `git revert <sha>`. Sin cambios de schema, datos, o runtime behavior.

## Commit Order

**Orden propuesto: rename primero, port después.** El rename es self-contained (no depende del port). El port nuevo se beneficia de tener el rename hecho para que los 3 use-cases vean el adapter ya con nombre coherente.

1. **Commit 1** — `refactor(adapters): rename Prisma*.ts InMemory* classes to Prisma*Repository`
   - 25 archivos `Prisma*.ts` (rename de clase exportada)
   - JSDoc de deuda IPv6 en `PrismaIpNetworkRepository`
   - 24 imports + instanciaciones en `app.ts`
   - Gate: `tsc --noEmit` + `npm test`

2. **Commit 2** — `refactor(domain): introduce ReportRepository port; remove DIP violation in report use cases`
   - Nuevo `src/domain/ports/ReportRepository.ts`
   - `implements ReportRepository` en `InMemoryReportRepository`
   - 3 use-cases: constructor tipado contra port, eliminar import de `@infrastructure/*`
   - `app.ts` no cambia (la instancia ya se inyectaba; solo cambia el TYPE en el constructor del use-case)
   - Gate: `tsc --noEmit` + `npm test`

## Open Questions

- [ ] ¿Confirmás el conteo real de 25 (no 23) clases a renombrar? La propuesta dice 23 + 1 mixta = 24, pero `rg` da 25 hits. Si el conteo importa para tracking, actualizamos la propuesta antes de tasks.
- [ ] ¿Querés que `InMemoryReportRepository` se mueva a futuro a un módulo `reports/in-memory/` para diferenciarlo de los test-doubles puros? (Out of scope para este cambio, pero vale anotar para deuda técnica.)
