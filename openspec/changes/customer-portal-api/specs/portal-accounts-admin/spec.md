# Portal Accounts Admin Specification

## Purpose

CRUD **administrativo** (staff de Prominense) de las cuentas del portal de clientes. El
provisioning es **100% manual** (decisión del usuario): no hay self-registration; el operador
crea la cuenta eligiendo el cliente, el sistema autogenera la password y el operador la entrega
por el canal que corresponda. Beta inicial: una sola cuenta (Ronald Hernández), creada por este
CRUD en prod — **jamás por seed**.

**Fuera de alcance:** la page del FE de Prominense (change aparte en el repo FE) y el envío
automático de la password (canal a decidir por el usuario).

## Requirements

### Requirement: Crear cuenta con password autogenerada
`POST /api/admin/portal-accounts` con `{clientId, dni?}` DEBE (MUST) crear un `PortalAccount`
para ese cliente con una password **autogenerada** (aleatoria criptográfica, ≥ 12 caracteres,
legible para dictado), guardar SOLO el hash bcrypt, marcar `mustChangePassword = true` y
devolver la password **en texto plano UNA ÚNICA vez** en esa respuesta. El `dni` por defecto se
toma del espejo del cliente (`customAttributes` de GR, campo documento); el operador puede
overridearlo. Nunca se loguea la password.

#### Scenario: Alta del beta
- **WHEN** el operador crea la cuenta para el cliente Ronald Hernández
- **THEN** la respuesta trae la password generada una vez, la cuenta queda `active` y con
  `mustChangePassword = true`

#### Scenario: DNI ya usado por otra cuenta
- **WHEN** se intenta crear una cuenta con un `dni` que ya tiene cuenta
- **THEN** 409 — `PortalAccount.dni` es único (1 DNI = 1 cuenta = 1 cliente en v1)

#### Scenario: Cliente ya tiene cuenta
- **WHEN** se intenta crear una segunda cuenta para el mismo `clientId`
- **THEN** 409 — `PortalAccount.clientId` es único

#### Scenario: Cliente sin documento en el espejo y sin override
- **WHEN** el cliente no tiene documento en `customAttributes` y el operador no pasó `dni`
- **THEN** 422 pidiendo el DNI explícito — jamás se crea una cuenta sin DNI

### Requirement: Regenerar password
`POST /api/admin/portal-accounts/:id/regenerate-password` DEBE (MUST) generar una password
nueva (mismas reglas), invalidar TODAS las sesiones activas de la cuenta, marcar
`mustChangePassword = true` y devolverla una única vez.

#### Scenario: Cliente olvidó su password
- **WHEN** el operador regenera la password
- **THEN** la anterior deja de servir, las sesiones activas se revocan y la nueva se muestra una vez

### Requirement: Habilitar / deshabilitar / borrar / listar
`PATCH /api/admin/portal-accounts/:id` DEBE (MUST) permitir `status: active|disabled`
(deshabilitar revoca las sesiones activas). `DELETE` elimina la credencial y sus sesiones (el
`Client` queda intacto). `GET /api/admin/portal-accounts` lista con el nombre del cliente,
`dni`, `status`, `lastLoginAt` y paginado.

#### Scenario: Deshabilitar corta el acceso ya emitido
- **WHEN** se deshabilita una cuenta con una sesión activa
- **THEN** su refresh deja de rotar (401) y el próximo login devuelve el genérico 401

### Requirement: Guard granular en las dos capas
TODAS las rutas del CRUD DEBEN (MUST) exigir un permiso granular nuevo (`portal.manage`),
agregado al catálogo RBAC del backend Y expuesto al `/me` para que el FE lo reciba (regla de
las dos capas del WORKFLOW). "Solo autenticado" NO alcanza.

#### Scenario: Operador sin el permiso
- **WHEN** un admin autenticado sin `portal.manage` llama a cualquier ruta del CRUD
- **THEN** 403
