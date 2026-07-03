# Capability: customers-nav-cleanup

El submenú **CRM › Clientes** del sidebar deja de exponer las páginas **Búsqueda** y **Vouchers**, y la entrada **"Lista"** pasa a llamarse **"Clientes"**. Las páginas `CustomerSearchPage` y `CustomerVouchersPage` (y el stack de datos exclusivo de Vouchers) se eliminan por completo. La búsqueda de clientes queda concentrada en `CustomersListPage`, que ya la provee con filtros y paginado.

## REMOVED Requirements

### Requirement: página dedicada de Búsqueda de clientes

Se ELIMINA la ruta `/admin/customers/search` y su página `CustomerSearchPage`. La capacidad de buscar clientes SHALL quedar provista exclusivamente por `CustomersListPage` (`/admin/customers/list`), que ofrece búsqueda por texto, filtro por estado y paginado.

#### Scenario: la ruta de Búsqueda ya no resuelve a su página

- **GIVEN** la app montada
- **WHEN** se navega a `/admin/customers/search`
- **THEN** NO se renderiza `CustomerSearchPage` (la ruta fue eliminada)

#### Scenario: el sidebar no muestra Búsqueda

- **GIVEN** un usuario con `clients.read`
- **WHEN** se expande el submenú Clientes
- **THEN** no aparece la entrada "Búsqueda"

### Requirement: página de Vouchers

Se ELIMINA la ruta `/admin/customers/vouchers`, su página `CustomerVouchersPage` y su stack de datos exclusivo (`types/voucher.ts`, `hooks/useCustomerVouchers.ts`, `api/voucher.api.ts`). Ningún otro módulo SHALL depender de esos archivos.

#### Scenario: la ruta de Vouchers ya no resuelve a su página

- **GIVEN** la app montada
- **WHEN** se navega a `/admin/customers/vouchers`
- **THEN** NO se renderiza `CustomerVouchersPage` (la ruta fue eliminada)

#### Scenario: el sidebar no muestra Vouchers

- **GIVEN** un usuario con `clients.read`
- **WHEN** se expande el submenú Clientes
- **THEN** no aparece la entrada "Vouchers"

#### Scenario: no quedan imports huérfanos de voucher

- **GIVEN** el código FE tras el borrado
- **WHEN** se compila con `tsc`
- **THEN** el typecheck es limpio (ningún import colgado a `voucher.*` ni a las páginas borradas)

## MODIFIED Requirements

### Requirement: submenú Clientes del sidebar

El submenú **CRM › Clientes** SHALL exponer, para un usuario con `clients.read`, exactamente las entradas: **Añadir, Clientes, Mapas, Contratos, TV, Internet, Recaptación, Mis clientes, Configuración** (con sus gates de permiso ya existentes). La entrada que apunta a `/admin/customers/list` SHALL mostrar el label **"Clientes"** (antes "Lista"). La ruta y la página (`CustomersListPage`) NO cambian.

#### Scenario: la entrada de la Lista se llama "Clientes"

- **GIVEN** un usuario con `clients.read`
- **WHEN** se expande el submenú Clientes
- **THEN** aparece la entrada "Clientes" apuntando a `/admin/customers/list`, y NO aparece "Lista"

#### Scenario: la Lista conserva su búsqueda y filtros

- **GIVEN** la ruta `/admin/customers/list` (menú "Clientes")
- **WHEN** el operador escribe en el buscador y aplica filtros
- **THEN** `CustomersListPage` responde con búsqueda por texto, filtro por estado y paginado (comportamiento intacto)

## Non-functional Requirements

- **Sin backend:** no se toca ninguna ruta, use case ni endpoint del BE. `useClientList` (hook compartido) se conserva.
- **Sin migración:** cambio puramente de UI/routing.
- **Sin URLs movidas:** el rename es de label; `/admin/customers/list` sigue igual (no se rompen bookmarks de la Lista).
