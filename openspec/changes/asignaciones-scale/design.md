# Design: Asignaciones a escala + pulido Gestión de Red

## Context

La tab Asignaciones trae todo y filtra client-side (inviable a 5000). El resto de la página ya es data-dense; falta robustez (error states) + a11y. Decisiones:

## Decisión 1 — Paginación server-side (Asignaciones)

**Contrato del endpoint** (BE↔FE, pinned):
```
GET /api/ip-assignments?page=1&pageSize=25&search=&nasId=
→ 200 { data: PppoeAssignmentDto[], total: number, page: number, pageSize: number }
```
- `PppoeServiceRepository.findAssignedPaginated({ page, pageSize, search, nasId })`:
  - WHERE base: `contractId != null AND remoteAddress != null AND status='enabled'` (igual que `findAssigned`).
  - `search` (opcional): match case-insensitive en `username` OR `remoteAddress` (IP) OR `contractId`.
  - `nasId` (opcional): filtra por router.
  - `skip=(page-1)*pageSize`, `take=pageSize`; `total` = COUNT con el MISMO WHERE (sin skip/take).
  - Devuelve `{ data, total }`. Orden estable: `username asc` (determinístico para paginar).
- `ListPppoeAssignments.execute(params)` → mapea `data` a DTO + propaga `total/page/pageSize`.
- Ruta: parsea `req.query` con defaults (page=1, pageSize=25, clamp pageSize ≤ 200). Sin params → 1ª página (compat).

**Por qué `findAssigned` (sin paginar) se conserva**: por si algún consumidor lo usa; el endpoint pasa a `findAssignedPaginated`. (Confirmar en apply que solo la tab lo consume.)

## Decisión 2 — FE Asignaciones server-side

- `useIpAssignments({ page, pageSize, search, nasId })` con TODOS los params en la queryKey (cache correcto por página/filtro). `keepPreviousData` para no parpadear al paginar.
- **Búsqueda con debounce** (~300ms) → resetea `page=1`. **Filtro por router**: `<select>` poblado de `useNasServers()` (id→name). Cambiar filtro → `page=1`.
- Render: `<Pagination>` (molécula existente, usa tokens globales) bajo la tabla; **skeleton** mientras `isFetching`; `createdAt` vía `formatDateTimeShort`. El contador "N asignaciones" pasa a `total` (server).
- Los otros tabs siguen client-side (sin cambio de data).

## Decisión 3 — Pulido transversal (a11y + robustez), tokens `--gr-*`

- **Error states**: cada `useQuery` expone `isError`; por tab, si `isError` → fila/panel "No se pudo cargar. Reintentar" (botón `refetch`). Accesible (`role="alert"`).
- **IPv6 toolbar**: agregar input de búsqueda (client-side, espeja las otras tabs).
- **A11y CSS** (en `.module.css`, sobre `--gr-*`): `cursor:pointer` en clickeables, `:focus-visible` ring (`outline` con `--gr-primary`), transiciones 150–300ms, `@media (prefers-reduced-motion: reduce){ * { transition:none } }`, breakpoints 768/1024 (tabla scroll-x ya está; mejorar toolbar fluido).
- **NO** migrar a tokens globales ni al atom `<Button>` (deuda documentada — riesgo para los 13 tests + divergencia `--gr-primary` #1e40af vs `--color-primary` #0d6efd).

## Decisión 4 — No romper los 13 tests

- Los 3 tests de Asignaciones mockean `useIpAssignments` devolviendo un array → adaptarlos al shape `{ data, total, page, pageSize }` y a leer `.data`. El resto (NAS/Redes/IPv6) intactos.
- NO tocar la lógica de `<Can>`/permisos (el explore marcó fragilidad). Solo additivos.

## Test Strategy (TDD)

- **BE**: `findAssignedPaginated` (in-memory) — paginación (page/pageSize), search (username/IP/contrato), filtro nasId, total correcto, excluye huérfanos/sin-IP/no-enabled. `ListPppoeAssignments` mapea + propaga total. Seam de ruta con query params (page 2, search, nasId).
- **FE**: Asignaciones — render de la 1ª página, click "siguiente" dispara refetch con page=2, búsqueda con debounce dispara refetch con search, filtro nasId dispara refetch; skeleton en loading; error state en isError. Adaptar los 3 tests existentes.

## Riesgo principal

El cambio de shape array→`{data,total}` es el único breaking; se deploya BE+FE juntos. Verificación visual Playwright cuando vuelva `.37`, antes de mergear.
