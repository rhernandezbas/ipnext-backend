# Exploration: naming-cleanup

**Change**: naming-cleanup
**Project**: ipnext-backend
**Phase**: explore
**Date**: 2026-05-09

---

## Current State

El proyecto tiene 26 archivos en `src/infrastructure/adapters/prisma/Prisma*.ts`.
De esos, **24 exportan clases `InMemory*`** siendo que todas acceden a Postgres vía Prisma.

Existe un segundo directorio `src/infrastructure/adapters/in-memory/` con **27 archivos** que son
los adaptadores verdaderamente en memoria (Map/array), usados **exclusivamente en tests**.

`app.ts` (617 líneas) importa las clases `InMemory*` desde los archivos `Prisma*.ts` en producción.
Los tests importan las clases `InMemory*` desde los archivos `InMemory*.ts` — esos sí son Map/array.
El naming miente sobre la implementación en todos los archivos de la capa Prisma.

---

## Clasificación de los 26 archivos

### Categoría A — Coherentes (2 archivos)
Archivo=`Prisma*`, clase=`Prisma*`, usa Prisma internamente. Sin acción.

| Archivo | Clase exportada |
|---------|-----------------|
| PrismaMonitoringRepository.ts | `PrismaMonitoringRepository` |
| PrismaProjectRepository.ts | `PrismaProjectRepository` |

---

### Categoría B — Mal nombrados pero usan Prisma (23 archivos)
Solo necesitan **rename de la clase exportada** + actualizar los call sites.

| Archivo | Clase actual (incorrecta) | Clase correcta |
|---------|--------------------------|----------------|
| PrismaAdminRepository.ts | InMemoryAdminRepository | PrismaAdminRepository |
| PrismaClientCommentRepository.ts | InMemoryClientCommentRepository | PrismaClientCommentRepository |
| PrismaCpeRepository.ts | InMemoryCpeRepository | PrismaCpeRepository |
| PrismaCreditNoteRepository.ts | InMemoryCreditNoteRepository | PrismaCreditNoteRepository |
| PrismaDashboardRepository.ts | InMemoryDashboardRepository | PrismaDashboardRepository |
| PrismaEmpresaRepository.ts | InMemoryEmpresaRepository | PrismaEmpresaRepository |
| PrismaFinanceHistoryRepository.ts | InMemoryFinanceHistoryRepository | PrismaFinanceHistoryRepository |
| PrismaGponRepository.ts | InMemoryGponRepository | PrismaGponRepository |
| PrismaHardwareRepository.ts | InMemoryHardwareRepository | PrismaHardwareRepository |
| PrismaLeadRepository.ts | InMemoryLeadRepository | PrismaLeadRepository |
| PrismaMessageRepository.ts | InMemoryMessageRepository | PrismaMessageRepository |
| PrismaNasRepository.ts | InMemoryNasRepository | PrismaNasRepository |
| PrismaNetworkSiteRepository.ts | InMemoryNetworkSiteRepository | PrismaNetworkSiteRepository |
| PrismaNotificationRepository.ts | InMemoryNotificationRepository | PrismaNotificationRepository |
| PrismaPartnerRepository.ts | InMemoryPartnerRepository | PrismaPartnerRepository |
| PrismaProformaRepository.ts | InMemoryProformaRepository | PrismaProformaRepository |
| PrismaRadiusSessionRepository.ts | InMemoryRadiusSessionRepository | PrismaRadiusSessionRepository |
| PrismaRoleRepository.ts | InMemoryRoleRepository | PrismaRoleRepository |
| PrismaSchedulingRepository.ts | InMemorySchedulingRepository | PrismaSchedulingRepository |
| PrismaSettingsRepository.ts | InMemorySettingsRepository | PrismaSettingsRepository |
| PrismaTr069Repository.ts | InMemoryTr069Repository | PrismaTr069Repository |
| PrismaUbicacionRepository.ts | InMemoryUbicacionRepository | PrismaUbicacionRepository |
| PrismaVozRepository.ts | InMemoryVozRepository | PrismaVozRepository |

---

### Categoría C — Mixto con deuda adicional (1 archivo)

| Archivo | Clase actual | Situación |
|---------|-------------|-----------|
| PrismaIpNetworkRepository.ts | InMemoryIpNetworkRepository | Usa Prisma para IpNetwork/IpPool/IpAssignment. Usa array en memoria + counter para Ipv6Network (comentario en código: "Ipv6Network has no Prisma model yet"). Renombrar clase a `PrismaIpNetworkRepository`. Documentar deuda IPv6. |

**Nota sobre PrismaDashboardRepository**: Las arrays `SHORTCUTS` y `ACTIVITY` son datos estáticos de
presentación (no estado mutable) — no es in-memory real, es configuración hardcoded. Sigue siendo
Categoría B.

---

## Call Sites: imports a actualizar en app.ts

El único call site de producción es `src/infrastructure/http/app.ts`.
Los 24 imports siguientes necesitan actualizar el nombre de la clase importada:

| Clase importada actualmente | Línea aprox | Nueva clase |
|-----------------------------|-------------|-------------|
| InMemoryClientCommentRepository | 24 | PrismaClientCommentRepository |
| InMemoryAdminRepository | 36 | PrismaAdminRepository |
| InMemorySettingsRepository | 38 | PrismaSettingsRepository |
| InMemorySchedulingRepository | 64 | PrismaSchedulingRepository |
| InMemoryVozRepository | 73 | PrismaVozRepository |
| InMemoryEmpresaRepository | 89 | PrismaEmpresaRepository |
| InMemoryPartnerRepository | 91 | PrismaPartnerRepository |
| InMemoryRoleRepository | 98 | PrismaRoleRepository |
| InMemoryIpNetworkRepository | 127 | PrismaIpNetworkRepository |
| InMemoryNasRepository | 136 | PrismaNasRepository |
| InMemoryDashboardRepository | 138 | PrismaDashboardRepository |
| InMemoryMessageRepository | 143 | PrismaMessageRepository |
| InMemoryCreditNoteRepository | 149 | PrismaCreditNoteRepository |
| InMemoryProformaRepository | 150 | PrismaProformaRepository |
| InMemoryFinanceHistoryRepository | 151 | PrismaFinanceHistoryRepository |
| InMemoryNetworkSiteRepository | 170 | PrismaNetworkSiteRepository |
| InMemoryCpeRepository | 177 | PrismaCpeRepository |
| InMemoryTr069Repository | 185 | PrismaTr069Repository |
| InMemoryHardwareRepository | 196 | PrismaHardwareRepository |
| InMemoryGponRepository | 203 | PrismaGponRepository |
| InMemoryRadiusSessionRepository | 213 | PrismaRadiusSessionRepository |
| InMemoryLeadRepository | 217 | PrismaLeadRepository |
| InMemoryUbicacionRepository | 225 | PrismaUbicacionRepository |
| InMemoryNotificationRepository | 245 | PrismaNotificationRepository |

**Los tests NO se ven afectados**: importan de `infrastructure/adapters/in-memory/InMemory*.ts`,
que son clases distintas y permanecen intactas.

---

## DIP Violations en use-cases

3 use-cases importan directamente de `@infrastructure/`:

```
src/application/use-cases/ExportReport.ts:2
  import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository'

src/application/use-cases/GenerateReport.ts:2
  import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository'

src/application/use-cases/ListReportDefinitions.ts:2
  import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository'
```

El `InMemoryReportRepository` genera datos estadísticos ficticios — NO tiene modelo Prisma.
Es LEGÍTIMAMENTE in-memory. No debe moverse a Prisma ahora.

### Puerto que falta: `src/domain/ports/ReportRepository.ts`

Shape propuesto:
```typescript
import { ReportType, ReportResult, ReportDefinition } from '@domain/entities/report';

export interface ReportRepository {
  getDefinitions(): ReportDefinition[];
  generateReport(type: ReportType, filters: Record<string, string>): ReportResult;
}
```

Los 3 use-cases deben recibir `ReportRepository` (interfaz de domain) en sus constructores,
no la clase concreta `InMemoryReportRepository`. `InMemoryReportRepository` debe implementar
esta interfaz. `app.ts` continúa inyectando `InMemoryReportRepository` — esto es correcto
(la infraestructura conoce al adaptador concreto).

---

## Approaches

### 1. Big-bang rename (todo en 2 commits atómicos)
- **Pros**: limpio, coherente, fácil de revisar en un diff; `tsc --noEmit` como gate inmediato
- **Cons**: merge conflicts si hay trabajo paralelo; si se olvida un archivo, TypeScript lo atrapa
- **Esfuerzo**: Bajo (rename mecánico)

### 2. Incremental por módulo (PRs chicos agrupados por dominio)
- **Pros**: diff pequeño, reversible por dominio
- **Cons**: app.ts inconsistente durante transición; más commits para seguir
- **Esfuerzo**: Bajo-medio

### 3. Incremental con tests-first
- **Pros**: validación automática por rename; STRICT TDD
- **Cons**: Los renames no cambian comportamiento — escribir tests antes de un rename puro agrega overhead sin valor; los tests de repos Prisma son de integración
- **Esfuerzo**: Alto

### Recomendación: Approach 1 + separar DIP fixes

**Commit 1** — rename mecánico (sin cambio de comportamiento):
- 23+1 archivos `Prisma*.ts`: rename la clase exportada
- `app.ts`: 24 imports actualizados
- Gate: `tsc --noEmit` debe pasar

**Commit 2** — DIP fix:
- Crear `src/domain/ports/ReportRepository.ts`
- Actualizar constructor de los 3 use-cases
- `InMemoryReportRepository` agrega `implements ReportRepository`
- Gate: `tsc --noEmit` + `npm test`

---

## Esfuerzo estimado

| Categoría | Archivos | Acción | LOC afectadas | Riesgo |
|-----------|----------|--------|---------------|--------|
| A (coherente) | 2 | Ninguna | 0 | Ninguno |
| B (rename clase) | 23 | Rename export class | ~23 | Muy bajo |
| C/Mixed | 1 | Rename + doc | ~2 | Bajo |
| app.ts call sites | 1 | 24 imports | ~24 | Muy bajo |
| DIP fix | 3 use-cases + 1 port | Crear interfaz + fix tipos | ~15 | Bajo |

**Total**: ~2h estimadas.

---

## Risks

- `app.ts` tiene 617 líneas — verificar que no haya imports desde rutas secundarias (`routes/*.ts`)
- El array IPv6 en `PrismaIpNetworkRepository` es estado mutable que se pierde en restart de proceso — deuda técnica documentada, no bloqueante para este cambio
- `InMemoryReportRepository` es legítimamente in-memory (datos estadísticos fakeados) — NO crear modelo Prisma para esto en este cambio
- Los tests que importan de `in-memory/` son inmunes al rename — no hay riesgo de romper tests existentes
- Verificar con grep si algún `routes/*.ts` importa directamente alguna de las clases `InMemory*` desde `prisma/` antes del rename

---

## Ready for Proposal

**Yes** — la exploración está completa. El cambio es bien acotado, el riesgo es bajo, y hay
suficiente evidencia para proponer la especificación y el plan de tareas.

**Next**: `sdd-propose` con foco en:
1. Especificar la regla invariante: clase en `Prisma*.ts` DEBE exportar `Prisma*`
2. Definir el port `ReportRepository` y las reglas del boundary hexagonal
3. Dejar explícito que `InMemory*.ts` en `in-memory/` son fakes de testing — no tocar
