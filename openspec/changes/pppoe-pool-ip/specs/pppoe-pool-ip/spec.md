# Capability: pppoe-pool-ip

Asignación automática de IP por **pool del NAS** (vía FreeRADIUS `sqlippool`) y **pin/unpin de IP fija** (bypass de Framed-IP), para servicios PPPoE sobre el RADIUS HA. Fase 1: NE8000 / Acceso Sur.

## ADDED Requirements

### Requirement: Modo de asignación de IP por servicio

Cada `PppoeService` SHALL tener un modo de asignación `ipMode` ∈ {`pool`, `fixed`}. `fixed` = IP pineada (radreply `Framed-IP-Address`); `pool` = FreeRADIUS asigna la IP del pool del NAS en el auth. El default SHALL ser `fixed` para no alterar la semántica de los servicios existentes.

#### Scenario: servicio fijo (default legacy)
- **WHEN** se lee un `PppoeService` existente sin `ipMode` explícito
- **THEN** se interpreta como `fixed` y su `remoteAddress` es la IP pineada (radreply `Framed-IP`)

#### Scenario: servicio en modo pool
- **WHEN** un servicio tiene `ipMode = pool`
- **THEN** NO tiene Framed-IP fija en el RADIUS (radreply sin `Framed-IP-Address`) y la IP la asigna el pool del NAS

### Requirement: Alta en modo pool no pre-elige IP

Al crear un `PppoeService` en un NAS marcado en modo pool, el sistema SHALL NO pre-elegir una IP (NO invocar el allocator `FindFreeIp`) y SHALL crear el usuario RADIUS con `framedIp = null`, para que FreeRADIUS asigne la IP del pool del NAS en el auth.

#### Scenario: alta en NAS pool-mode
- **WHEN** se da de alta un PPPoE en un NAS con `poolName` no nulo y sin pedir IP fija
- **THEN** el servicio queda `ipMode = pool`, el alta llama `orchestrator.createUser({ …, framedIp: null })` y NO se consulta `FindFreeIp`

#### Scenario: alta en NAS legacy (no pool)
- **WHEN** se da de alta un PPPoE en un NAS con `poolName` nulo
- **THEN** se preserva el comportamiento actual (el caller pre-elige la IP, `ipMode = fixed`, `framedIp = remoteAddress`)

### Requirement: Pin de IP fija (override sobre pool)

El sistema SHALL permitir pinear una IP fija a un servicio (incluso en un NAS pool-mode) vía un caso de uso `PinPppoeIp`, que escribe la Framed-IP en el RADIUS (`changeFramedIp(username, ip)`), setea `ipMode = fixed` y `remoteAddress = ip`. La IP SHALL validarse: formato, dentro de un rango gestionado, y no asignada a otro usuario.

#### Scenario: pinear IP a un servicio pool
- **WHEN** un operador pinea la IP `X` a un servicio `ipMode = pool`
- **THEN** se llama `changeFramedIp(username, X)`, el servicio pasa a `ipMode = fixed` / `remoteAddress = X`, y en el próximo auth mantiene `X` (bypass del pool)

#### Scenario: IP inválida o ya tomada
- **WHEN** la IP a pinear no es válida o ya está asignada a otro usuario
- **THEN** el pin se rechaza (error de dominio) y NADA cambia en el RADIUS ni en la DB

### Requirement: Unpin → vuelve al pool

El sistema SHALL permitir despinear un servicio vía `UnpinPppoeIp`, que libera la Framed-IP (`changeFramedIp(username, null)`), setea `ipMode = pool` y `remoteAddress = null`. SHALL rechazarse si el NAS del servicio NO está en modo pool (no habría pool de dónde tomar IP).

#### Scenario: despinear en NAS pool-mode
- **WHEN** un operador despina un servicio `fixed` en un NAS con `poolName` no nulo
- **THEN** se llama `changeFramedIp(username, null)`, el servicio pasa a `ipMode = pool` / `remoteAddress = null`, y en el próximo auth toma IP del pool

#### Scenario: despinear en NAS legacy se rechaza
- **WHEN** se intenta despinear un servicio en un NAS con `poolName` nulo
- **THEN** la operación se rechaza (no hay pool de respaldo; el cliente quedaría sin IP)

### Requirement: NAS en modo pool con pre-check de pools poblados

Un NAS SHALL poder marcarse en modo pool asignándole un `poolName`. El sistema SHALL rechazar marcar un NAS en modo pool si el pool correspondiente en el RADIUS (`radippool`, consultado vía el orchestrator) está vacío o sin IPs libres.

#### Scenario: marcar NAS pool-mode con pool poblado
- **WHEN** se asigna `poolName` a un NAS y ese pool tiene IPs libres en el RADIUS
- **THEN** la operación se acepta y las altas nuevas en ese NAS default a `ipMode = pool`

#### Scenario: marcar NAS pool-mode sin pool poblado
- **WHEN** se asigna `poolName` a un NAS pero el pool está vacío en el RADIUS
- **THEN** la operación se rechaza con un error claro (evita dejar clientes sin IP)

### Requirement: Servicios fijos legacy intactos

Los servicios `fixed` existentes (los ~2287 con Framed-IP) SHALL conservar su IP sin cambios. La activación de `sqlippool` SHALL incluir un bypass que respete cualquier `Framed-IP-Address` presente (los pinneados NO toman del pool). NO SHALL haber migración ni backfill de data sobre esos servicios.

#### Scenario: cliente fijo con sqlippool activo
- **WHEN** un cliente con Framed-IP fija se autentica con `sqlippool` activo
- **THEN** mantiene su IP fija (el módulo no le asigna una del pool)

### Requirement: Asignación sticky por el pool del NAS (FreeRADIUS)

Con `sqlippool` activo, FreeRADIUS SHALL asignar a un servicio en modo pool una IP del pool correspondiente al **NAS por el que entra**, y SHALL mantener esa IP (sticky) a través de reconexiones dentro de la ventana de lease (~2 semanas). Si el cliente cambia de NAS, SHALL recibir una IP del pool del nuevo NAS.

#### Scenario: misma IP tras reconexión
- **WHEN** un servicio pool se desconecta y re-autentica dentro de la ventana de lease
- **THEN** recibe la misma IP del pool (sticky)

#### Scenario: cambio de NAS → IP del nuevo pool
- **WHEN** un servicio pool se mueve a otro NAS y se autentica
- **THEN** recibe una IP del pool del nuevo NAS (la IP "sigue al NAS")
