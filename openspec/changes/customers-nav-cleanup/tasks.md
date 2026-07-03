# Tasks: Limpieza de navegación de Clientes

> Cambio FE-only. TDD estricto (test primero, red → green). Sin migración, sin backend.
> Gate de salida: suite FE verde + `tsc` limpio + review adversarial (1 revisor) CLEAN.
> **✅ HECHO Y EN PROD (2026-07-03, FE `c4922712`, deploy 28655386931).**

## 1. Tests (primero — red)

- [x] 1.1 En `App.routing.test.tsx`: quitados los casos de `/admin/customers/search` (`[PAGE:CustomerSearch]`) y `/admin/customers/vouchers` (`[PAGE:CustomerVouchers]`) + los `vi.mock` de ambas páginas + los casos `shouldNotSee`.
- [x] 1.2 En `Sidebar.test.tsx`: afirma que el submenú Clientes NO contiene "Búsqueda" ni "Vouchers", y SÍ contiene "Clientes" (antes "Lista").
- [x] 1.3 En `SidebarVentasAccess.test.tsx` y `CollapsibleNavItem.test.tsx`: ajustadas las aserciones de labels ("Lista"→"Clientes"; fixture de colapso pasó de "Vouchers" a "Añadir"; quitadas Búsqueda/Vouchers).
- [x] 1.4 Confirmado rojo con el código actual (3 files, 4 tests en rojo).

## 2. Sidebar + routing (green)

- [x] 2.1 `Sidebar.tsx`: quitados los `SubItem` de `Búsqueda` y `Vouchers`; label de `/admin/customers/list` de "Lista" a "Clientes".
- [x] 2.2 `App.tsx`: quitados los 2 `lazy` (`CustomerSearchPage`, `CustomerVouchersPage`) + los 2 `<Route>` (`search`, `vouchers`).

## 3. Borrado de páginas y código huérfano (green)

- [x] 3.1 Borrado `CustomerSearchPage.tsx` + `.module.css` + `__tests__/customers/CustomerSearchPage.test.tsx`.
- [x] 3.2 Borrado `CustomerVouchersPage.tsx` + `.module.css` + `__tests__/customers/CustomerVouchersPage.test.tsx`.
- [x] 3.3 Borrado el stack de vouchers huérfano: `types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`.
- [x] 3.4 Grep de cierre: sin rastros de `voucher`/`CustomerSearchPage`/`CustomerVouchersPage` en `src/` (salvo las aserciones negativas de `Sidebar.test.tsx`).

## 4. Gate de calidad

- [x] 4.1 Suite FE completa verde: **438/438 files, 4439 tests** (corrida por el orquestador).
- [x] 4.2 `tsc --noEmit` limpio.
- [x] 4.3 `useClientList` y `CustomersListPage` intactos (fuera del diff; su test pasa).

## 5. Review

- [x] 5.1 Review adversarial (1 revisor): **ISSUES FOUND (2), ambos LOW no bloqueantes** — (a) docs stale (`features.md`/`domain-glossary.md`/`overview.md` mencionaban Búsqueda/Vouchers/voucher.ts) → **FIXEADO**; (b) sin redirect para bookmarks viejos de `/search`·`/vouchers` (caen al catch-all `:id`) → **deuda documentada** (decisión de diseño #5: borrado completo, sin redirect, cero bookmarks externos conocidos).
- [x] 5.2 Fix aplicado (docs) + colisión de link-name "Clientes" (breadcrumb vs sidebar) resuelta en `AdminLayout.test.tsx` con `within(breadcrumb)`. El review confirmó que es la única colisión.

## 6. Salida de fase

- [x] 6.1 Commit FE `c4922712` (conventional). Push a `main` → deploy 28655386931.
- [x] 6.2 BACKLOG actualizado (card → ✅ EN PROD). `tasks.md` cerrado.

## Deuda LOW (no bloquea)

- Sin redirect de compatibilidad para `/admin/customers/search` y `/admin/customers/vouchers`: hoy caen al catch-all `/admin/customers/:id` → `CustomerDetailPage` con id inexistente. Cero bookmarks externos conocidos (rutas internas del sidebar recién removidas). Si molesta, es un `<Navigate to="/admin/customers/list" replace />` de 2 líneas.
