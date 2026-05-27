# Proposal: Naming Cleanup — Prisma Adapters & DIP Fix

## Intent

24 archivos en `src/infrastructure/adapters/prisma/Prisma*.ts` exportan clases con prefijo `InMemory*` aunque internamente USAN Prisma — naming engañoso que rompe el contrato hexagonal (`Prisma*.ts` DEBE exportar `Prisma*`). Adicionalmente, 3 use-cases violan DIP importando directamente de `@infrastructure/*`. Limpieza mecánica + creación de un port faltante para alinear el código con la arquitectura hexagonal estricta.

## Scope

### In Scope
- Renombrar 23 clases `InMemory*` → `Prisma*` en archivos `Prisma*.ts` (Categoría B de la exploración)
- Renombrar 1 clase mixta (`PrismaIpNetworkRepository.ts`) y documentar la deuda IPv6 in-memory
- Crear puerto `src/domain/ports/ReportRepository.ts` con interfaz limpia
- Actualizar 3 use-cases (`ExportReport`, `GenerateReport`, `ListReportDefinitions`) para depender del port en lugar de la clase concreta
- Actualizar 24 imports en `src/infrastructure/http/app.ts`
- Validar con `tsc --noEmit` y suite de tests existente

### Out of Scope
- NO tocar el directorio `src/infrastructure/adapters/in-memory/` (son adaptadores legítimos para tests)
- NO migrar `Ipv6Network` a Prisma (deuda técnica documentada para futuro)
- NO refactorizar la estructura/wiring de `app.ts` más allá de los path imports
- NO cambiar comportamiento runtime de ningún repositorio
- NO tocar migrations, schema Prisma, ni otros adapters
- NO agregar Splynx ni dependencias nuevas

## Capabilities

### New Capabilities
- `report-repository-port`: Interfaz de dominio `ReportRepository` que define el contrato para generar/listar reportes, permitiendo que use-cases dependan de dominio en vez de infraestructura.

### Modified Capabilities
- None (este change introduce un port nuevo y hace rename mecánico; no modifica requisitos de capacidades existentes en `openspec/specs/`).

## Approach

**Big-bang en 2 commits atómicos** (seguro porque es rename mecánico + un port nuevo, sin cambios de comportamiento):

1. **Commit 1** — `refactor: rename InMemory* classes to Prisma* in prisma adapters`
   - Rename de la clase exportada en los 24 archivos `Prisma*.ts`
   - Update de los 24 imports en `app.ts`
   - Comentario JSDoc en `PrismaIpNetworkRepository` documentando deuda IPv6
   - Gate: `tsc --noEmit` + tests

2. **Commit 2** — `refactor: introduce ReportRepository port to fix DIP violation`
   - Nuevo archivo `src/domain/ports/ReportRepository.ts`
   - 3 use-cases tipan el constructor con `ReportRepository` (port)
   - El wiring en `app.ts` sigue pasando `InMemoryReportRepository` — solo cambia el TYPE
   - Gate: `tsc --noEmit` + tests

Justificación de big-bang: TypeScript con `strict` actúa como red de seguridad — cualquier import roto es detectado antes del commit. No hay cambios de comportamiento, así que tests de integración no se rompen.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/infrastructure/adapters/prisma/Prisma*.ts` (24 archivos) | Modified | Rename `class InMemory*` → `class Prisma*` |
| `src/infrastructure/http/app.ts` | Modified | 24 imports actualizados |
| `src/domain/ports/ReportRepository.ts` | New | Port nuevo |
| `src/application/use-cases/{Export,Generate,ListReportDefinitions}.ts` | Modified | Constructor tipado contra port |
| `src/infrastructure/adapters/in-memory/` | Untouched | Sin cambios |
| `prisma/schema.prisma`, migrations | Untouched | Sin cambios |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Imports olvidados fuera de `app.ts` (otros adapters/routes) | Med | `rg "InMemory(Admin\|Cpe\|Lead\|...)Repository" src/` antes de commitear; TS strict como gate |
| Confusión con clases homónimas en `in-memory/` | Low | Las clases en `in-memory/` mantienen su nombre `InMemory*` — no hay colisión real |
| Deuda IPv6 olvidada después del rename | Low | TODO/JSDoc explícito en `PrismaIpNetworkRepository` |
| Breaking de tests por cambio de nombre exportado | Low | Tests importan de `in-memory/`, no de `prisma/` — no se ven afectados |
| Merge conflict si hay trabajo paralelo en `app.ts` | Med | Coordinar timing del merge; commit 1 es self-contained |

## Rollback Plan

Trivial: cada commit es atómico y reversible con `git revert <sha>`. Rename de clase no toca runtime ni schema, solo símbolos exportados. Si commit 2 falla, commit 1 sigue siendo válido independiente. Sin migraciones de DB que revertir.

## Dependencies

- Ninguna externa. Depende solo del estado actual del repo y de TS strict como quality gate.

## Success Criteria

- [ ] `rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/` retorna 0 resultados
- [ ] `rg "from '@infrastructure/" src/application/use-cases/` retorna 0 resultados
- [ ] `src/domain/ports/ReportRepository.ts` existe y es importado por los 3 use-cases
- [ ] `tsc --noEmit` pasa sin errores
- [ ] Suite de tests existente pasa al 100% sin modificaciones
- [ ] `app.ts` mantiene comportamiento runtime idéntico (mismo wiring, mismas clases instanciadas)
- [ ] PrismaIpNetworkRepository tiene JSDoc explicando la deuda IPv6 in-memory
