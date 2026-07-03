# Proposal: Limpieza de navegación de Clientes — quitar Vouchers + Búsqueda, renombrar Lista → "Clientes"

## Intent

Simplificar el submenú **CRM › Clientes** del sidebar: **borrar por completo** las entradas **Vouchers** y **Búsqueda** (sidebar + ruta + página + código huérfano + tests) y **renombrar** la entrada **"Lista" → "Clientes"**. Cambio FE-only, sin backend.

## Why

- **Búsqueda es redundante:** `CustomerSearchPage` es una página mínima (input + `useClientList` + `DataTable`) cuya única capacidad —buscar clientes— ya está **cubierta y superada** por `CustomersListPage`, que tiene búsqueda por texto, filtro por estado, paginado y sincronización con la URL. Mantener las dos confunde y duplica. El operador **no pierde nada** al quitar Búsqueda.
- **Vouchers es una feature muerta:** la página `CustomerVouchersPage` y todo su stack (`types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`) son **self-contained** — ningún otro módulo los importa. No aporta valor operativo hoy y ensucia el menú. Es exactamente el tipo de código dormant que el workflow manda remover (mismo criterio que `pppoe-sqlippool-cleanup`).
- **"Lista" → "Clientes":** el label "Lista" es genérico; renombrarlo a "Clientes" deja claro que es **la** vista principal de clientes (la que concentra búsqueda + filtros + paginado).

## Scope

### In Scope (FE)

- **Sidebar** (`Sidebar.tsx`): quitar los `SubItem` de `Búsqueda` (`/admin/customers/search`) y `Vouchers` (`/admin/customers/vouchers`); renombrar el label de `Lista` (`/admin/customers/list`) a **"Clientes"**.
- **Routing** (`App.tsx`): quitar los `lazy(() => import(...))` de `CustomerSearchPage` y `CustomerVouchersPage` y sus `<Route>` (`search`, `vouchers`).
- **Borrado de páginas y código huérfano:**
  - `CustomerSearchPage.tsx` + `.module.css` + su test.
  - `CustomerVouchersPage.tsx` + `.module.css` + su test.
  - Stack de vouchers huérfano: `types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`.
- **Tests:** actualizar los tests de routing (`App.routing.test.tsx`) y de sidebar (`Sidebar.test.tsx`, `SidebarVentasAccess.test.tsx`, `CollapsibleNavItem.test.tsx`) para reflejar la ausencia de las rutas/labels y la presencia del label "Clientes".

### Out of Scope

- Backend: ninguna ruta, use case ni endpoint del BE se toca (Vouchers/Búsqueda son 100% FE; `useClientList` — que la Lista sigue usando — se conserva).
- Cambiar la funcionalidad de `CustomersListPage` (ya tiene búsqueda; no se modifica su comportamiento).
- Redirecciones legacy de `/customers/search` y `/customers/vouchers` (quedan como 404/catch-all del router; no había enlaces externos conocidos).

## Capabilities

### Removed Capabilities

- `customer-search-page`: la página dedicada `GET /admin/customers/search` deja de existir. La búsqueda de clientes vive ahora **solo** en `CustomersListPage` (`/admin/customers/list`, renombrada "Clientes" en el menú).
- `customer-vouchers-page`: la página `GET /admin/customers/vouchers` y su stack de datos dejan de existir.

### Modified Capabilities

- `customers-sidebar-nav`: el submenú Clientes pasa de `[Añadir, Búsqueda, Lista, Vouchers, Mapas, Contratos, TV, Internet, Recaptación, Mis clientes, Configuración]` a `[Añadir, Clientes, Mapas, Contratos, TV, Internet, Recaptación, Mis clientes, Configuración]`.

## Approach

1. **TDD:** primero actualizar/rojo los tests de routing y sidebar (las rutas `search`/`vouchers` ya no deben resolver a sus páginas; el label "Vouchers"/"Búsqueda" ya no debe aparecer; el label "Clientes" sí). Confirmar rojo.
2. **Sidebar + routing:** aplicar los cambios en `Sidebar.tsx` y `App.tsx`.
3. **Borrado:** eliminar las páginas + CSS + tests + stack huérfano de vouchers. Verificar con búsqueda que no queda ningún import colgado (`voucher`, `CustomerSearchPage`, `CustomerVouchersPage`).
4. **Verify:** suite FE completa verde + `tsc` (typecheck) limpio.
5. **Review adversarial** (1 revisor focalizado, piso del workflow): foco = imports huérfanos, `lazy` colgado, rutas rotas, tests que quedaron afirmando lo viejo, y que `useClientList`/`CustomersListPage` sigan intactos.

## Affected Areas (FE)

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/components/organisms/Sidebar/Sidebar.tsx` | Modified | Quita 2 `SubItem`, renombra "Lista" → "Clientes" |
| `src/App.tsx` | Modified | Quita 2 `lazy` imports + 2 `<Route>` |
| `src/pages/customers/CustomerSearchPage.tsx` + `.module.css` | Deleted | Página redundante con la Lista |
| `src/pages/customers/CustomerVouchersPage.tsx` + `.module.css` | Deleted | Feature muerta |
| `src/types/voucher.ts` | Deleted | Tipo huérfano (solo lo usaba Vouchers) |
| `src/hooks/useCustomerVouchers.ts` | Deleted | Hook huérfano |
| `src/api/voucher.api.ts` | Deleted | API huérfana |
| `src/__tests__/customers/CustomerSearchPage.test.tsx` | Deleted | Test de página borrada |
| `src/__tests__/customers/CustomerVouchersPage.test.tsx` | Deleted | Test de página borrada |
| `src/__tests__/routing/App.routing.test.tsx` | Modified | Quita casos de `search`/`vouchers` |
| `src/__tests__/layout/Sidebar.test.tsx` | Modified | Ajusta labels visibles |
| `src/__tests__/components/organisms/Sidebar/SidebarVentasAccess.test.tsx` | Modified | Ajusta labels visibles |
| `src/__tests__/components/organisms/Sidebar/CollapsibleNavItem.test.tsx` | Modified | Ajusta labels visibles |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Import huérfano de `voucher.*` que rompe el build | Baja | Grep exhaustivo de `voucher`/`Voucher` antes de commitear; `tsc` limpio |
| Un test sigue afirmando el label/ruta viejo → rojo | Media | TDD: se ajustan los tests en el paso rojo, antes del código |
| Enlace externo a `/customers/search` o `/customers/vouchers` | Muy baja | Sin enlaces externos conocidos; el catch-all del router maneja la URL |
| `CustomersListPage` dependía de algo de Búsqueda | Nula | Verificado: solo comparten `useClientList` (se conserva); páginas independientes |

## Rollback

Revertir el commit FE. No hay migración ni estado persistido; el cambio es puramente de UI/routing.

## Dependencies

Ninguna. Cambio FE-only, independiente del resto del backlog (no toca PPPoE, NAS ni GR).

## Success Criteria

- [ ] El submenú Clientes NO muestra "Búsqueda" ni "Vouchers"; muestra "Clientes" (antes "Lista").
- [ ] `/admin/customers/search` y `/admin/customers/vouchers` ya no resuelven a sus páginas (rutas eliminadas).
- [ ] No queda ningún archivo `voucher`/`CustomerSearchPage`/`CustomerVouchersPage` ni import colgado.
- [ ] `CustomersListPage` (renombrada "Clientes" en el menú) sigue funcionando con su búsqueda/filtros/paginado intactos.
- [ ] Suite FE verde + `tsc` limpio.
- [ ] Review adversarial CLEAN.
