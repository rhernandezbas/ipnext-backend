# Spec — TV RBAC granular permissions

## ADDED Requirements

### Requirement: Granular TV action permissions
El módulo RBAC `tv` SHALL exponer permisos por acción de negocio: `tv.read`, `tv.link`, `tv.register`, `tv.packs`, `tv.ott`, `tv.cancel`, `tv.manage`. Las claves SHALL llegar al frontend vía `/me` en formato punto.

#### Scenario: link route requires tv.link
- **WHEN** un usuario sin `tv.link` hace POST `/api/gigared/customers/:id/link`
- **THEN** el server responde 403 `PERMISSION_DENIED` con `action: 'link'`

#### Scenario: register route requires tv.register
- **WHEN** un usuario sin `tv.register` hace POST `/api/gigared/customers/:id/register`
- **THEN** 403 `PERMISSION_DENIED`

#### Scenario: packs routes require tv.packs
- **WHEN** un usuario sin `tv.packs` hace POST o DELETE en `/api/gigared/customers/:id/services[/:serviceId]`
- **THEN** 403 `PERMISSION_DENIED`

#### Scenario: ott route requires tv.ott
- **WHEN** un usuario sin `tv.ott` hace PUT `/api/gigared/customers/:id/ott`
- **THEN** 403 `PERMISSION_DENIED`

#### Scenario: cancel route requires tv.cancel
- **WHEN** un usuario sin `tv.cancel` hace POST `/api/gigared/customers/:id/cancel`
- **THEN** 403 `PERMISSION_DENIED`

#### Scenario: granular permission appears in /me with dot
- **WHEN** un usuario con `tv.packs` consulta GET `/auth/me`
- **THEN** `permissions` incluye el string `"tv.packs"`

### Requirement: Back-compat for existing TV operators
Ningún rol que hoy puede operar TV SHALL perder capacidad.

#### Scenario: administrador retains full TV operation
- **WHEN** se aplica la migración granular
- **THEN** el rol `administrador` posee `tv.link`, `tv.register`, `tv.packs`, `tv.ott`, `tv.cancel` (equivalente a su `tv.write` previo)

#### Scenario: super_admin unaffected
- **WHEN** super_admin consulta /me
- **THEN** recibe `["*"]` y puede ejecutar toda ruta TV
