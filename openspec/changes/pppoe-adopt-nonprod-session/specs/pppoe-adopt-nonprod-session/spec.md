# Capability: pppoe-autoinstall-adoption (gate por IP no-producción)

El watcher `AutoMovePppoe` adopta un servicio pendiente (nasId null) cuya sesión ganadora indica un CPE esperando instalación. La decisión "instalación legítima vs username reciclado" se toma por la **IP de la sesión**, NO por el `acctstarttime` — porque el RADIUS HA master-master corrompe ese timestamp (session-id reusado por el NAS + Start/Stop cruzados entre réplicas → `acctstarttime` clavado en el pasado).

> **Contexto (bug de prod 2026-07-03):** un pendiente legítimo se crea SIN Framed-IP → el NAS lo manda a su pool preinstall/temporal (`172.31.255.x`). Un username RECICLADO (cliente viejo con Framed-IP de producción, colgada histórica) tiene la sesión en un pool cgnat/public. El rango preinstall es privado reservado y jamás solapa producción.

## MODIFIED Requirements

### Requirement: la adopción de un pendiente decide reciclado-vs-instalación por la IP de la sesión

En la fase de clasificación de `AutoMovePppoe.run()`, para un servicio con `nasId === null` (adopción) cuya sesión ganadora PRECEDE al alta del servicio (`startedAt(winner) < createdAt(service)`), el sistema SHALL saltar la adopción (fila `skipped_stale_session`, reason `session_predates_service`) SOLO si la `framedIp` de la sesión ganadora es una IP de **producción** (pertenece a algún pool `cgnat` o `public` cargado) **o es desconocida (null)**. Si la `framedIp` es demostrablemente **no-producción** (no pertenece a ningún pool cgnat/public — pool preinstall/temporal), el sistema SHALL adoptar el pendiente igual, ignorando el `acctstarttime`.

El freshness gate de los mismatches NORMALES (servicios con `nasId` no-null) SHALL permanecer sin cambios: una sesión ganadora vieja (> `sessionFreshnessMs`) sigue produciendo `skipped_stale_session`.

**Referencia de implementación:** `productionPools = [...cgnatPools, ...publicPools]`; `winnerIpIsNonProduction = winner.framedIp !== null && !ipInAnyRange(winner.framedIp, productionPools)`; skip sii `precedesAlta && !winnerIpIsNonProduction`.

#### Scenario: pendiente + sesión en pool preinstall que precede al alta → ADOPTA (el bug de Ignacio)

- **GIVEN** un servicio pendiente (nasId null, ipTypePreference cgnat) creado HOY, con una única sesión viva en el NAS B cuya `framedIp` es `172.31.255.254` (pool preinstall, fuera de todo pool de producción) y `startedAt` de hace 3 semanas (anterior al alta — el `acctstarttime` que el HA corrompió)
- **WHEN** corre el tick del watcher
- **THEN** el servicio es adoptado: `nasId = NAS B`, IP del pool cgnat de B, evento `moved` con reason `auto_install`, `skippedStale = 0`

#### Scenario: pendiente + sesión con IP de producción que precede → skip (reciclado protegido)

- **GIVEN** un servicio pendiente creado HOY, con una única sesión viva cuya `framedIp` es `100.64.43.50` (dentro del pool cgnat de producción de B) y `startedAt` de hace 3 semanas
- **WHEN** corre el tick del watcher
- **THEN** el servicio NO se adopta: fila `skipped_stale_session` / reason `session_predates_service`, `skippedStale = 1`, `moved = 0`, sigue pendiente (nasId null); cero writes al plano de control

#### Scenario: pendiente + sesión framedIp null que precede → skip (conservador)

- **GIVEN** un servicio pendiente creado HOY, con una única sesión viva `framedIp = null` y `startedAt` anterior al alta
- **WHEN** corre el tick del watcher
- **THEN** el servicio NO se adopta (no se puede afirmar que la IP sea preinstall): fila `skipped_stale_session`, sigue pendiente

#### Scenario: regresión — adopción con sesión fresca (startedAt >= createdAt) adopta sin importar la IP

- **GIVEN** un servicio pendiente cuya sesión ganadora nació DESPUÉS del alta (fresca), con cualquier `framedIp`
- **WHEN** corre el tick del watcher
- **THEN** el servicio se adopta normalmente (la rama de IP ni se evalúa cuando la sesión no precede al alta)

#### Scenario: regresión — mismatch NORMAL con sesión vieja sigue en skip por freshness

- **GIVEN** un servicio con `nasId` no-null (mismatch normal) cuya única sesión ganadora tiene `startedAt` > `sessionFreshnessMs` de antigüedad
- **WHEN** corre el tick del watcher
- **THEN** el servicio produce `skipped_stale_session` y NO se mueve (la exención por IP es SOLO para adopciones)

## Non-functional Requirements

- **Sin migración de datos ni cambio de schema.** El fix es puramente de comportamiento en la capa application.
- **Cubre todos los NAS:** la señal es "IP no pertenece a producción conocida" → cualquier rango temporal (MikroTik `172.31.255.x`, NE8000 con su propio rango) queda cubierto sin registrar pools.
- **DIP preservado:** `AutoMovePppoe` (application) opera sobre ports + `ipInAnyRange` (domain). Cero infraestructura nueva.
