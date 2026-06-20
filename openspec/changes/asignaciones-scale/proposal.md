# Proposal: Asignaciones a escala + pulido Gestión de Red (Change B)

## Intent

Preparar la página **Gestión de Red** para escala real (5000+ PPPoEs, varios routers) y pulir su UX con `ui-ux-pro-max`:

1. **Escala (#3)** — la tab **Asignaciones** trae HOY *todas* las filas (`GET /api/ip-assignments` → `ListPppoeAssignments` → `findAssigned()` sin límite) y filtra client-side. Con 5000 PPPoEs es inviable. → **paginación + búsqueda + filtro por router server-side**.
2. **Pulido transversal** — la página ya es data-dense (rediseñada antes), pero le faltan: **error states** (ninguna tab los maneja), **toolbar de búsqueda en IPv6** (única tab sin buscador), formateo de fecha en Asignaciones (`createdAt` ISO crudo), y el **checklist de accesibilidad** de ui-ux-pro-max (focus-visible, cursor-pointer, reduced-motion, responsive 375/768/1024/1440).

## Why

- A 5000 filas, traer todo + filtrar en el browser cuelga la página y satura la red.
- La página ya tiene buen estilo data-dense; este change la lleva a producción-grade (escala + robustez + a11y) sin rewrite.

## Scope

### In Scope

**BE — paginación server-side de Asignaciones:**
- `PppoeServiceRepository.findAssignedPaginated({ page, pageSize, search, nasId }): { data: PppoeService[]; total: number }` (WHERE `contractId!=null AND remoteAddress!=null AND status='enabled'` + search en username/IP/contrato + filtro `nasId` + LIMIT/OFFSET + COUNT). Impl in-memory + Prisma.
- `ListPppoeAssignments` acepta los params → devuelve `{ data: PppoeAssignmentDto[]; total; page; pageSize }`.
- Ruta `GET /api/ip-assignments?page&pageSize&search&nasId` (guard `network.read` sin cambios). Defaults: page=1, pageSize=25. **Compat**: si no llegan params, devuelve la 1ª página (no rompe consumidores).

**FE — Asignaciones paginada (data-dense, ui-ux-pro-max):**
- `getIpAssignments(params)` → `{ data, total, page, pageSize }`; `useIpAssignments(params)` con params en la queryKey.
- Tab Asignaciones: tabla server-side + molécula `<Pagination>` (25/pág) + **búsqueda con debounce** (server-side) + **filtro por router (nasId)** (dropdown poblado de `nasServers`) + skeleton loading + row-hover + `createdAt` vía `formatDateTimeShort`.

**FE — pulido transversal (5 tabs):**
- **Error states**: cada tab maneja `isError` (panel de error accesible, no pantalla en blanco).
- **IPv6**: agregar toolbar de búsqueda (additivo).
- **Checklist a11y ui-ux-pro-max**: `cursor: pointer` en clickeables, `:focus-visible` ring, transiciones 150–300ms, `prefers-reduced-motion`, breakpoints 375/768/1024/1440, SVG icons (ya están).
- Mantener tokens `--gr-*` existentes (no migrar al global — más seguro para los tests) y consistencia entre tabs.

### Out of Scope

- Migrar la página al token global / atom `<Button>` (divergencia conocida; riesgo para los 13 tests). Se documenta como deuda.
- Paginación server-side en NAS/Redes/Pools/IPv6 (pocas filas; client-side alcanza). Solo Asignaciones escala.
- URL param `?tab=` (nice-to-have, fuera de scope).

## Capabilities

### Modified Capabilities
- Gestión de Red: Asignaciones escala server-side; robustez (error states) + a11y transversal.

## Approach

1. **BE** paginación (TDD: in-memory `findAssignedPaginated` + `ListPppoeAssignments` + seam de ruta con query params).
2. **FE Asignaciones** (server-side: hook con params, `<Pagination>`, debounce, filtro nasId).
3. **FE pulido** (error states + IPv6 toolbar + a11y CSS), tab por tab, sin romper los 13 tests.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/domain/ports/PppoeServiceRepository.ts` | New — `findAssignedPaginated` |
| `src/infrastructure/adapters/{in-memory,prisma}/*PppoeServiceRepository.ts` | Modified — impl |
| `src/application/use-cases/ListPppoeAssignments.ts` | Modified — params + `{data,total,page,pageSize}` |
| `src/infrastructure/http/routes/ipNetwork.routes.ts` | Modified — query params |
| **FE** `src/api/network.api.ts` + `src/hooks/useNetwork.ts` | Modified — params + shape |
| **FE** `src/types/network.ts` | Modified — `PaginatedAssignments` |
| **FE** `src/pages/networking/GestionRedPage.tsx` (+ `.module.css`) | Modified — Asignaciones paginada + pulido transversal |
| **FE** `src/__tests__/networking/GestionRedPage.test.tsx` | Modified — adaptar al shape paginado |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| El cambio de shape (array→`{data,total}`) rompe los 3 tests de Asignaciones | Alta | Adaptar los mocks + leer `.data`; tests verdes parte del DoD |
| Romper el gating frágil de `<Can>` (el explore lo marcó) | Media | NO tocar la lógica de permisos; solo additivos de UI |
| Regresión visual sin poder verificar (.37 caído) | Media | Build + tests + ui-ux checklist ahora; **verificación visual Playwright cuando vuelva .37, ANTES de mergear** |
| Pulido transversal toca NAS (tab MEDIUM-HIGH risk) | Media | Additivos (error states, a11y CSS); no tocar acciones/cutover/EditNasModal |

## Rollback

Aditivo + cambio de contrato de 1 endpoint (con default compat). Rollback = `git revert` (BE+FE). El cambio de shape es el único breaking — coordinado BE↔FE en el mismo deploy.

## Dependencies

- Change A (mergeado en origin/main; este change parte de ahí). Sin cambio de schema Prisma.
- Molécula `<Pagination>` (existe) + `formatDateTimeShort` (existe).
- **Deploy bloqueado hasta que `.37` (VM/runner) vuelva.** Build + verify ahora; deploy + verificación visual después.

## Success Criteria

- [ ] `GET /api/ip-assignments?page&pageSize&search&nasId` pagina server-side; `{data,total,page,pageSize}`.
- [ ] Tab Asignaciones: paginación + búsqueda server-side + filtro por router + skeleton + fecha formateada.
- [ ] Las 5 tabs manejan error state; IPv6 con toolbar; checklist a11y aplicado.
- [ ] `npm test` (BE) + vitest (FE) verdes; tsc/typecheck limpios; los 13 tests existentes adaptados y en verde.
- [ ] Review adversarial GO. Verificación visual Playwright pendiente de `.37`.
