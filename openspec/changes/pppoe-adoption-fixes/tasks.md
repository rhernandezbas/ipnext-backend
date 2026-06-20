# Tasks: PPPoE Adoption Fixes

> TDD estricto (test primero). **Apply en worktrees** — BE: `fix/pppoe-adoption` (branch desde SHA de main).
> FE: `fix/pppoe-adoption` en `ipnext-frontend` (branch desde SHA de su main). Cross-repo.

## Bug 2 — status FE (primero: 2 líneas, cero riesgo)
- [ ] **(test primero)** FE: InternetPanel muestra panel activo con `status:'enabled'`; "Desactivado" con `'disabled'`.
- [ ] FE `InternetPanel.tsx` L53: `p.status === 'active'` → `p.status === 'enabled'`.
- [ ] FE `InternetPanel.tsx` L647 (badge): `pppoe.status === 'active'` → `'enabled'`.
- [ ] (opcional) `types/pppoe.ts`: narrow `status: 'enabled'|'disabled'|'pending'`.

## Bug 1 — filtro de placeholders (BE)
- [ ] **(test primero)** `IngestPppoeFromNas` con `exclusionPatterns: [/^accesosur\d+$/i]`: excluye `accesosur1`, persiste `juanperez`; `{ created:1, excluded:1 }`.
- [ ] `IngestPppoeFromNas.ts`: constructor `exclusionPatterns: RegExp[] = []` + filtro en el loop + counter `excluded` en `IngestResult`.
- [ ] **(test primero)** `ListUnassignedPppoe` filtra el patrón (defensa en profundidad).
- [ ] `ListUnassignedPppoe.ts`: aplicar el filtro secundario.
- [ ] `config.ts` + `env.example`: `PPPOE_INGEST_EXCLUDE_PATTERN` (default `^accesosur\d+$`).
- [ ] `app.ts`: pasar los patrones resueltos al construir `IngestPppoeFromNas` (+ composition test no rompe).

## Bug 3 — fuente de asignaciones (BE)
- [ ] **(test primero)** `InMemoryPppoeServiceRepository.findAssigned()`: devuelve solo `contractId!=null && remoteAddress!=null && status='enabled'`; excluye huérfanos y sin-IP.
- [ ] `PppoeServiceRepository.ts` (port): declarar `findAssigned(): Promise<PppoeService[]>`.
- [ ] `InMemoryPppoeServiceRepository.ts` + `PrismaPppoeServiceRepository.ts`: implementar.
- [ ] **(test primero)** `ListPppoeAssignments` mapea a `PppoeAssignmentDto[]`.
- [ ] `ListPppoeAssignments.ts` (new) + DTO en `pppoe.dto.ts`.
- [ ] `ipNetwork.routes.ts`: `GET /api/ip-assignments` → `ListPppoeAssignments` (mantener endpoint, cambiar fuente).
- [ ] `app.ts`: wiring (+ composition test).

## Bug 3 — FE (tab Asignaciones)
- [ ] **(test primero)** FE: tab Asignaciones con asignaciones mockeadas muestra la IP; no "No se encontraron asignaciones".
- [ ] `types/network.ts`: ajustar `IpAssignment` a la nueva shape (ip, username, contractId, profile, status, createdAt).
- [ ] `GestionRedPage.tsx`: re-map columnas (IP, Usuario, Contrato, Plan, Estado, Creada) + referencias de campos.

## Verificación
- [ ] BE: `npm test` verde + `tsc --noEmit` limpio. DIP: use cases no importan infra.
- [ ] FE: `npm run test` (vitest) verde + `npm run typecheck` limpio.
- [ ] Seam test BE: ruta `/api/ip-assignments` → `ListPppoeAssignments` real → repo in-memory (no mockear el use case).
- [ ] `GET /api/pppoe/unassigned` no devuelve `accesosurN`.

## Post-deploy (ops)
- [ ] Borrar las 10 filas `PppoeService` placeholder (`username ~ ^accesosur\d+$`) de la DB Prominense. NO tocar HA/router.
- [ ] Verificar en prod (Playwright): lista sin placeholders · PPPoE asociado se ve activo · tab Asignaciones con datos reales.

## Salida de la fase
- [ ] Los 3 bugs corregidos, con tests, EN PROD y verificados en vivo. Adopción de inventario plenamente usable.
