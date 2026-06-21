<!-- generated from engram topic_key: sdd/customer-zones-map/tasks -->
# Tasks — customer-zones-map

## Backend (repo `ipnext-backend`, worktree `feat/customer-zones-map`) — TDD estricto

### Domain
- [ ] T1. `domain/entities/zone.ts`: `Zone` + `ZonePoint`
- [ ] T2. `domain/errors/`: `ZoneNotFoundError`, `InvalidPolygonError`
- [ ] T3. `domain/ports/ZoneRepository.ts`: create/findById/list/update/delete

### Application (test-first)
- [ ] T4. `CreateZone` + test (válido / <3 puntos / coord fuera de rango / name vacío / color inválido)
- [ ] T5. `ListZones` + test
- [ ] T6. `GetZone` + test (404)
- [ ] T7. `UpdateZone` + test (válido / 404 / revalida polígono)
- [ ] T8. `DeleteZone` + test (404)
- [ ] T9. `application/dto/zone.dto.ts`: `ZoneDto` + mapper (sin Prisma)

### Infrastructure
- [ ] T10. `InMemoryZoneRepository` (tests de use case)
- [ ] T11. `PrismaZoneRepository` (singleton prisma, NO `constructor(prisma)`)
- [ ] T12. `zones.routes.ts`: 5 rutas + guards (read/manage) + mapeo errores 422/404
- [ ] T13. wiring en `app.ts` + composition test (rutas montadas + guards estáticos)
- [ ] T14. routes test (supertest, repos in-memory): happy paths + 403 (sin permiso) + 422 + 404

### Migraciones (aditivas)
- [ ] T15. `20260805000000_zone_model`: `CREATE TABLE "Zone"`
- [ ] T16. `20260805001000_zones_rbac_permissions`: RbacModule + RbacPermission + grants (idempotente, `ON CONFLICT`)
- [ ] T17. `RBAC_MODULES += 'zones'` en `domain/entities/rbac.ts`

### Gate BE
- [ ] T18. suite completa verde + `tsc --noEmit` limpio (**corrido por el orquestador**, no por el agente)
- [ ] T19. review adversarial (foco: guards en TODAS las rutas, validación de polígono, DTO sin leak, idempotencia migración) → fix wave → re-review CLEAN
- [ ] T20. dry-run rolled-back de ambas migraciones vs schema

## Frontend (repo `ipnext-frontend`, worktree separado) — commits separados
- [ ] F0. ⚠️ Resolver **Tailwind vs CSS Modules** en `CustomerMapPage` (¿Tailwind configurado?). Seguir convención REAL + skill `ui-ux-pro-max`/`impeccable`.
- [ ] F1. Instalar `leaflet-draw` + `@types/leaflet-draw`
- [ ] F2. `useZones` (TanStack Query) + mutations create/update/delete (contrato `ZoneDto` exacto)
- [ ] F3. Capa de polígonos en `CustomerMapPage` (fetch + render por color)
- [ ] F4. Modo edición (leaflet-draw) gateado por `zones.manage`; form nombre/color
- [ ] F5. `<Can>`/`RequirePermission` para los controles; view-only con `zones.read`
- [ ] F6. Gate FE: typecheck + suite Vitest verde + review adversarial

## Integración / deploy (cada repo, push = prod, **OK del usuario**)
- [ ] I1. `zones.read`/`zones.manage` asignados en la PermissionMatrix a los roles que correspondan
- [ ] I2. Merge BE a main + push (confirmar) → seguir run en `gh` (incluido step migraciones)
- [ ] I3. Merge FE a main + push (confirmar) → run verde
- [ ] I4. Verificación Playwright en vivo (dibujar/editar/borrar zona) + limpiar datos de prueba
- [ ] I5. `sdd-verify` (matriz spec-compliance) ANTES de cada push
