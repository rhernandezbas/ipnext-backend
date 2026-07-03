# Tasks: Limpieza de navegación de Clientes

> Cambio FE-only. TDD estricto (test primero, red → green). Sin migración, sin backend.
> Gate de salida: suite FE verde + `tsc` limpio + review adversarial (1 revisor) CLEAN.
> No hay push sin OK del usuario.

## 1. Tests (primero — red)

- [ ] 1.1 En `App.routing.test.tsx`: quitar los casos de `/admin/customers/search` (`[PAGE:CustomerSearch]`) y `/admin/customers/vouchers` (`[PAGE:CustomerVouchers]`) — tanto la lista de rutas montadas como los casos `shouldNotSee`.
- [ ] 1.2 En `Sidebar.test.tsx`: afirmar que el submenú Clientes NO contiene "Búsqueda" ni "Vouchers", y que SÍ contiene "Clientes" (antes "Lista").
- [ ] 1.3 En `SidebarVentasAccess.test.tsx` y `CollapsibleNavItem.test.tsx`: ajustar cualquier aserción que dependa de los labels "Búsqueda"/"Vouchers"/"Lista".
- [ ] 1.4 Confirmar rojo con el código actual.

## 2. Sidebar + routing (green)

- [ ] 2.1 `Sidebar.tsx`: quitar el `SubItem` de `Búsqueda` (`/admin/customers/search`) y el de `Vouchers` (`/admin/customers/vouchers`); cambiar el `label` de `/admin/customers/list` de "Lista" a "Clientes".
- [ ] 2.2 `App.tsx`: quitar los `lazy` de `CustomerSearchPage` y `CustomerVouchersPage`; quitar los `<Route path="search">` y `<Route path="vouchers">`.

## 3. Borrado de páginas y código huérfano (green)

- [ ] 3.1 Borrar `CustomerSearchPage.tsx` + `.module.css` + `__tests__/customers/CustomerSearchPage.test.tsx`.
- [ ] 3.2 Borrar `CustomerVouchersPage.tsx` + `.module.css` + `__tests__/customers/CustomerVouchersPage.test.tsx`.
- [ ] 3.3 Borrar el stack de vouchers huérfano: `types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`.
- [ ] 3.4 Grep de cierre: `voucher`/`Voucher`, `CustomerSearchPage`, `CustomerVouchersPage` no aparecen en `src/` (fuera de esta carpeta openspec).

## 4. Gate de calidad

- [ ] 4.1 Suite FE completa verde (corrida por el orquestador).
- [ ] 4.2 `tsc`/typecheck limpio.
- [ ] 4.3 Verificar que `useClientList` y `CustomersListPage` siguen intactos y funcionando.

## 5. Review

- [ ] 5.1 Review adversarial (1 revisor focalizado): imports huérfanos, `lazy` colgado, rutas rotas, tests con lo viejo, no-regresión de la Lista.
- [ ] 5.2 Fix wave si el review no da CLEAN + re-review focalizada.

## 6. Salida de fase

- [ ] 6.1 Commit FE (conventional). Push con OK del usuario → deploy FE.
- [ ] 6.2 Actualizar BACKLOG (card a ✅ EN PROD + PR/commit). `sdd-archive` del change si corresponde.
