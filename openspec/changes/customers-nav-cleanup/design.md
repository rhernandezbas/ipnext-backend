# Design: Limpieza de navegación de Clientes

## Contexto

El submenú **CRM › Clientes** (`Sidebar.tsx`, `CRM_ITEMS[0].children`) lista hoy 11 entradas. Dos de ellas sobran:

- **Búsqueda** (`/admin/customers/search` → `CustomerSearchPage`): página mínima que solo hace `useClientList({ search })` + `DataTable`. `CustomersListPage` (`/admin/customers/list`) ya ofrece búsqueda por texto, filtro por estado, paginado y URL-sync — es un superset estricto.
- **Vouchers** (`/admin/customers/vouchers` → `CustomerVouchersPage`): feature sin uso, con stack propio (`types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`) que nadie más consume.

## Decisiones

### 1. Borrado completo, no "esconder del sidebar" (decisión del usuario, 2026-07-03)

Se elimina el árbol entero: sidebar → ruta → página → CSS → tests → stack de datos huérfano. **Por qué:** dejar la ruta viva pero sin entrada de menú deja código muerto accesible por URL directa (deuda), justo lo que el workflow manda evitar (mismo criterio que `pppoe-sqlippool-cleanup`). Si se quisiera "esconder temporal", sería otra decisión — acá es remoción definitiva.

### 2. `useClientList` se CONSERVA

`CustomerSearchPage` importa `useClientList` de `@/hooks/useCustomers`, pero ese hook lo usa también `CustomersListPage`. Solo se borran los archivos **exclusivos** de Búsqueda (la página + su CSS + su test). El hook compartido queda intacto.

### 3. Stack de Vouchers es 100% removible

Verificado por grep: `voucher`/`Voucher` aparece únicamente en la página, su test, y `types/voucher.ts` + `hooks/useCustomerVouchers.ts` + `api/voucher.api.ts` (más las referencias en Sidebar/App/tests que se editan). No hay consumidores cruzados → se borran los tres archivos de datos.

### 4. Rename por label, no por ruta

"Lista" → "Clientes" es solo el `label` del `SubItem`; la ruta (`/admin/customers/list`) y la página (`CustomersListPage`) **no cambian**. Se evita mover URLs (romper bookmarks) por un cambio cosmético de menú. Nota: el grupo padre ya se llama "Clientes", así que el árbol queda **Clientes › Clientes** — es lo pedido explícitamente por el usuario.

### 5. Sin redirecciones legacy

`/admin/customers/search` y `/admin/customers/vouchers` caen al catch-all del router tras la remoción. No hay enlaces externos conocidos ni bookmarks documentados; no se agrega redirect (YAGNI). Si apareciera un enlace externo, se agrega un redirect puntual después.

## TDD

Red primero: los tests de routing dejan de esperar `[PAGE:CustomerSearch]`/`[PAGE:CustomerVouchers]`; los tests de sidebar dejan de esperar los labels "Búsqueda"/"Vouchers" y esperan "Clientes". Confirmar rojo con el código viejo, luego aplicar sidebar+routing+borrado hasta verde.

## Verificación

- Suite FE completa verde + `tsc` limpio (gate corrido por el orquestador, no por el reporte del agente).
- Grep de cierre: `voucher`, `CustomerSearchPage`, `CustomerVouchersPage` no deben aparecer fuera de `openspec/` (artefactos SDD).
- Review adversarial (1 revisor): imports huérfanos, `lazy` colgado, tests que quedaron con lo viejo, `useClientList`/`CustomersListPage` intactos.
