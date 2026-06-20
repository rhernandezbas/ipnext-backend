# Tasks: Asignaciones a escala + pulido Gestión de Red

> TDD estricto. BE worktree `feat/asignaciones-scale` (scale-be). FE worktree `feat/asignaciones-scale` (scale-fe).
> Deploy bloqueado hasta que vuelva `.37`: build + verify ahora, deploy + visual después.

## BE — paginación server-side (Asignaciones)
- [ ] **(test primero)** `InMemoryPppoeServiceRepository.findAssignedPaginated`: page/pageSize, search (username/IP/contrato), filtro nasId, total correcto, excluye huérfanos/sin-IP/no-enabled.
- [ ] `PppoeServiceRepository` (port): `findAssignedPaginated({page,pageSize,search?,nasId?})` → `{data,total}`.
- [ ] Impl in-memory + Prisma (WHERE + search OR + nasId + skip/take + count; orden username asc).
- [ ] **(test primero)** `ListPppoeAssignments` con params → `{data,total,page,pageSize}` (mapea DTO, propaga total).
- [ ] `ListPppoeAssignments.ts`: aceptar params.
- [ ] **(test primero)** ruta `GET /api/ip-assignments?page&pageSize&search&nasId` (seam: page 2, search, nasId; defaults; clamp pageSize≤200; guard network.read).
- [ ] `ipNetwork.routes.ts`: parsear query + pasar al use case.

## FE — Asignaciones paginada
- [ ] **(test primero)** Asignaciones: 1ª página renderiza; "siguiente"→refetch page=2; búsqueda(debounce)→refetch search; filtro nasId→refetch; skeleton en loading; error state en isError.
- [ ] `types/network.ts`: `PaginatedAssignments { data, total, page, pageSize }`.
- [ ] `network.api.ts`: `getIpAssignments(params)` → shape paginado.
- [ ] `useNetwork.ts`: `useIpAssignments(params)` (params en queryKey, keepPreviousData).
- [ ] `GestionRedPage.tsx`: tab Asignaciones server-side — `<Pagination>` (25/pág), búsqueda debounce, filtro por router (de `useNasServers`), skeleton, `createdAt` formateada, contador = total.
- [ ] Adaptar los 3 tests de Asignaciones al shape paginado.

## FE — pulido transversal (ui-ux-pro-max)
- [ ] Error states por tab (`isError` → panel "No se pudo cargar · Reintentar", role="alert").
- [ ] IPv6: toolbar de búsqueda (client-side).
- [ ] A11y CSS (`.module.css`, sobre `--gr-*`): cursor-pointer, :focus-visible ring, transiciones 150–300ms, prefers-reduced-motion, breakpoints 768/1024.
- [ ] Mantener consistencia data-dense entre tabs; NO migrar tokens/Button; NO tocar `<Can>`/permisos.

## Verificación
- [ ] BE: `npm test` verde + tsc limpio. DIP preservado.
- [ ] FE: vitest verde (13 existentes adaptados) + typecheck limpio.
- [ ] Seam BE: ruta paginada → use case real → repo in-memory.
- [ ] Review adversarial (obligatorio): foco en el contrato BE↔FE del shape paginado + no romper gating.

## Pendiente de `.37` (cuando vuelva la VM)
- [ ] Verificación visual Playwright: paginación, búsqueda server-side, filtro por router, error states, responsive.
- [ ] Deploy coordinado BE+FE (shape breaking) junto con Change A + data fix Jorge + chequeo rate-limits.

## Salida
- [ ] Asignaciones escala a 5000+; página robusta (error states) + a11y; listo para deploy cuando vuelva `.37`.
