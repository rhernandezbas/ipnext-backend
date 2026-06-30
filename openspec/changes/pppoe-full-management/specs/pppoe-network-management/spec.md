# Spec (delta): PPPoE Network Management

> Capability NUEVA (FE) + cambios aditivos a PPPoE Management (BE). Vista operativa de red estilo winbox `/ppp secret`, directo al RADIUS HA, leyendo del espejo DB.

## ADDED Requirement: Listar todos los PPPoE con filtro por NAS, search, status y paginado

El listado global (`GET /api/pppoe`, `ListAllPppoeServices`) DEBE poder incluir los PPPoE **sin contrato** (huérfanos) mediante un flag `includeUnassigned`, manteniendo el comportamiento actual por default.

#### Scenario: Incluir huérfanos cuando se pide
- **WHEN** se llama `GET /api/pppoe?includeUnassigned=true`
- **THEN** la respuesta incluye PPPoE con `contractId = null` (marcados con `clientId/customerName = null`) además de los que tienen contrato
- **AND** la paginación y el `total` cuentan ambos

#### Scenario: Default no rompe la page vieja
- **WHEN** se llama `GET /api/pppoe` sin `includeUnassigned` (o `=false`)
- **THEN** se aplica `contractId IS NOT NULL` (comportamiento actual), de modo que `InternetServicesPage` queda idéntica

#### Scenario: Filtro por NAS
- **WHEN** se llama con `nasId=<id>`
- **THEN** solo se devuelven los PPPoE de ese NAS (con o sin contrato según `includeUnassigned`)

#### Scenario: Search por username o cliente
- **WHEN** se llama con `search=<texto>`
- **THEN** matchea (case-insensitive) por `username` o por nombre del cliente asociado

#### Scenario: Paginación server-side
- **WHEN** se llama con `page` y `limit`
- **THEN** devuelve `{ data, total, page, limit }` con orden estable (`username ASC`), `limit` default 20 y max 100

## ADDED Requirement: Crear PPPoE con contrato OPCIONAL directo al HA

DEBE existir `POST /api/pppoe` (gate `pppoe.manage`) que cree un PPPoE en el RADIUS HA y su espejo, con `contractId` opcional.

#### Scenario: Crear con contrato
- **WHEN** se crea con username, password, plan, nasId, framedIp? y un `contractId` válido
- **THEN** se crea el secret en el orchestrator (`POST /users`) y el espejo `PppoeService` con ese `contractId`, y queda asociado al contrato

#### Scenario: Crear sin contrato (huérfano)
- **WHEN** se crea sin `contractId`
- **THEN** se crea el secret en el orchestrator y el espejo con `contractId = null` (huérfano, ⚠), sin fallar

#### Scenario: Username duplicado
- **WHEN** el username ya existe en el espejo o el orchestrator
- **THEN** se rechaza con error claro (409/422), sin crear nada

#### Scenario: Falla del orchestrator no deja espejo fantasma
- **WHEN** el `POST /users` del orchestrator falla
- **THEN** NO se inserta la fila en el espejo (el control de plano sigue al HA, no al revés)

## ADDED Requirement: Cambiar username (recrear) de forma segura

DEBE existir `POST /api/pppoe/:id/rename` (gate `pppoe.manage`) que cambie el username recreando el secret en el HA, sin perder el secret existente ante fallos.

#### Scenario: Happy path
- **WHEN** se renombra a un username nuevo válido y único
- **THEN** se crea el secret nuevo en el orchestrator preservando password, plan, framedIp, MAC y status del viejo
- **AND** se borra el secret viejo del orchestrator
- **AND** se actualiza `PppoeService.username` en el MISMO row (preserva `contractId`, `id`, historial)

#### Scenario: Username nuevo ya existe
- **WHEN** el username destino ya está tomado
- **THEN** se rechaza antes de tocar nada (no se crea ni se borra)

#### Scenario: Falla al borrar el viejo tras crear el nuevo
- **WHEN** el secret nuevo se creó OK pero el `DELETE` del viejo falla
- **THEN** el secret VIEJO sobrevive (no se pierde conectividad por la vía vieja) y la operación reporta el estado para reintento — NUNCA se borra el viejo antes de confirmar el nuevo

#### Scenario: Preserva atributos
- **WHEN** el PPPoE viejo tenía IP fija / MAC lock / estado suspendido
- **THEN** el secret nuevo replica esos atributos (framedIp, MAC, suspend)

## ADDED Requirement: Operar PPPoE por fila (reuso de capacidades existentes)

La page DEBE permitir, por fila, las operaciones ya soportadas, todas impactando el HA.

#### Scenario: Cambiar password / plan / IP / status
- **WHEN** se edita un PPPoE (password, plan, remoteAddress/IP, status)
- **THEN** se enruta vía `PATCH /api/pppoe/:id` → `UpdatePppoeService` → orchestrator (changePassword/changePlan/changeFramedIp/suspend-reactivate)

#### Scenario: Mover de NAS
- **WHEN** se mueve un PPPoE a otro NAS
- **THEN** `POST /api/pppoe/:id/move` actualiza el `nasId` del espejo

#### Scenario: Baja
- **WHEN** se da de baja un PPPoE
- **THEN** `DELETE /api/pppoe/:id` ejecuta el flujo de terminación existente

#### Scenario: Revelar password on-demand
- **WHEN** el operador (con `pppoe.manage`) pide ver el password de una fila
- **THEN** se llama `GET /api/pppoe/:id/credentials` SOLO en ese momento; el password NUNCA viaja en el listado

## ADDED Requirement: Tab "PPPoE" en Gestión de Red protegido por permiso

#### Scenario: Usuario con permiso ve el tab
- **WHEN** un usuario con `pppoe.read` abre Gestión de Red
- **THEN** ve el tab "PPPoE" junto a los existentes (NAS/Redes/Pools/Asignaciones/IPv6/Sesiones)

#### Scenario: Sin permiso no ve el tab ni opera
- **WHEN** un usuario sin `pppoe.read` abre Gestión de Red
- **THEN** el tab "PPPoE" no se muestra
- **AND** las acciones de escritura están gateadas por `pppoe.manage` en FE (`Can`) Y en BE (guard de ruta)

#### Scenario: Los tabs existentes no se alteran
- **WHEN** se agrega el tab "PPPoE"
- **THEN** los tabs NAS/Redes IP/Pools/Asignaciones/IPv6/Sesiones activas siguen funcionando igual (cambio aditivo)
