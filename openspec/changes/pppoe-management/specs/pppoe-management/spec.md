# Capability: pppoe-management

CRUD de PppoeService desde Prominense con aprovisionamiento del `/ppp secret` real en el MikroTik, de forma consistente entre la DB y el router.

## ADDED Requirements

### Requirement: Crear PPPoE con aprovisionamiento consistente

`CreatePppoeService` SHALL persistir el `PppoeService` y crear el `/ppp secret` en el router del `nasId`, sin dejar la DB y el router divergentes en silencio.

#### Scenario: alta exitosa
- **WHEN** se crea un PPPoE para un contrato con un router alcanzable
- **THEN** se persiste el `PppoeService` con `status='enabled'` Y existe el `/ppp secret` en ese router

#### Scenario: router inalcanzable al crear
- **WHEN** el router no responde durante el alta
- **THEN** el `PppoeService` queda `status='pending'` y la operación devuelve `502 ROUTER_UNREACHABLE` (reintentable, sin "OK" mentiroso)

#### Scenario: username ya existente
- **WHEN** se intenta crear un PPPoE con un `username` que ya existe
- **THEN** se rechaza con `409 PPPOE_USERNAME_TAKEN` y NO se toca el router

#### Scenario: reintento idempotente
- **WHEN** se reintenta el alta de un `username` que ya tiene fila `pending`
- **THEN** se completa el aprovisionamiento sin crear una fila duplicada

### Requirement: Editar PPPoE y sincronizar al router

`UpdatePppoeService` SHALL aplicar el cambio en el router antes de confirmarlo en la DB.

#### Scenario: editar profile
- **WHEN** se cambia el `profile` de un PPPoE con router alcanzable
- **THEN** el `/ppp secret` queda con el nuevo profile Y la DB refleja el cambio

#### Scenario: router inalcanzable al editar
- **WHEN** el router no responde durante la edición
- **THEN** la DB NO cambia y se devuelve `502 ROUTER_UNREACHABLE`

### Requirement: Mover PPPoE de router

`MovePppoeServiceToRouter` SHALL crear el secret en el router destino y darlo de baja en el origen, de forma consistente.

#### Scenario: move exitoso
- **WHEN** se mueve un PPPoE a otro router (ambos alcanzables)
- **THEN** el secret existe en el destino, ya no en el origen, y `PppoeService.nasId` = destino

#### Scenario: destino inalcanzable
- **WHEN** el router destino no responde
- **THEN** la operación aborta sin cambios (el origen queda intacto)

### Requirement: Baja soft

`DeactivatePppoeService` SHALL deshabilitar el secret en el router y marcar el PPPoE como `disabled`, sin borrar el inventario.

#### Scenario: baja
- **WHEN** se da de baja un PPPoE
- **THEN** el `/ppp secret` queda `disabled=yes` y `PppoeService.status='disabled'` (la fila se conserva)

### Requirement: Lectura sin credenciales sensibles

Las respuestas de lectura SHALL exponer `PppoeServiceDto` SIN el `password`.

#### Scenario: listar por contrato
- **WHEN** se consulta `GET /api/contracts/:contractId/pppoe`
- **THEN** se devuelven los PppoeServiceDto del contrato y ninguno incluye `password`

### Requirement: Control de acceso

Las rutas SHALL exigir autenticación y el permiso granular correspondiente en backend.

#### Scenario: sin sesión
- **WHEN** se llama cualquier ruta de pppoe sin cookie de auth
- **THEN** responde `401`

#### Scenario: sin permiso de gestión
- **WHEN** un usuario sin `pppoe.manage` intenta crear/editar/mover/dar de baja
- **THEN** responde `403`
