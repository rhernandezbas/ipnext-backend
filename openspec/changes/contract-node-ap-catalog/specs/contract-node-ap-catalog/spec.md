# Spec — contract-node-ap-catalog (delta, Fase A)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

**Decisiones LOCKED del proposal/design (no se reabren):**
- AP = `UispDevice.role === 'ap'`. AP → NetworkSite por `uispSiteId`.
- Catálogo `AccessPoint` DERIVADO del mirror; nunca editable a mano; nunca auto-borrado.
- `Contract.networkSiteId` / `Contract.accessPointId` = manual-only; GR sync NUNCA los escribe.
- Migración aditiva, sin backfill. Fase B (asignación) y Fase C (segment) fuera de alcance.

---

## Capability: catálogo de AccessPoints

### Requirement: AP-1 — port `AccessPointRepository` upsert idempotente por uispDeviceId
`AccessPointRepository` MUST exponer `upsertByUispDeviceId(input)`, `findMany()`,
`findByNetworkSiteId(id)` y `findById(id)`. El upsert MUST keyear por `uispDeviceId`: un segundo upsert
con el mismo `uispDeviceId` MUST actualizar `name`/`mac`/`networkSiteId` de la MISMA fila (mismo `id`),
nunca crear una nueva.

#### Scenario: create asigna id y persiste campos
- Given un repo vacío
- When se hace `upsertByUispDeviceId({ uispDeviceId:'dev-1', networkSiteId:'ns-1', name:'AP Norte', mac:'AA:..' })`
- Then se devuelve un `AccessPoint` con `id` no vacío, `uispDeviceId='dev-1'`, `networkSiteId='ns-1'`,
  `name='AP Norte'`, `mac='AA:..'` y timestamps `createdAt`/`updatedAt`

#### Scenario: update no duplica
- Given un AP ya upserteado con `uispDeviceId='dev-1'`
- When se upsertea de nuevo `dev-1` con `name`/`mac`/`networkSiteId` distintos
- Then el `id` es el mismo, los campos quedan actualizados y `findMany()` devuelve 1 sola fila

#### Scenario: findByNetworkSiteId filtra por nodo
- Given APs en `n1`, `n2`, `n1`
- When `findByNetworkSiteId('n1')`
- Then devuelve exactamente los 2 de `n1`

### Requirement: AP-2 — `SyncUispMirror` siembra APs solo para role='ap'
El paso 9 de `SyncUispMirror.execute()` MUST, cuando se le inyecta un `AccessPointRepository`, upsertear
un `AccessPoint` por cada `UispDevice` con `role === 'ap'`, y MUST NO crear AccessPoints para devices
con `role` `station`/`router`/`null`.

#### Scenario: mezcla de roles
- Given devices `ap-1`(ap), `sta-1`(station), `rtr-1`(router), `nul-1`(null) en un mismo sitio
- When corre `execute()`
- Then el catálogo tiene 1 AccessPoint y es `ap-1`

### Requirement: AP-3 — link del AP a su NetworkSite por uispSiteId
Cada AccessPoint MUST linkearse (`networkSiteId`) al `NetworkSite` cuyo `uispSiteId` coincide con
`device.uispSiteId`. Si NO existe un NetworkSite con ese `uispSiteId`, el AccessPoint MUST quedar con
`networkSiteId = null`.

#### Scenario: link correcto por nodo
- Given sites `site-a`, `site-b` (auto-importados a NetworkSite en paso 8) y devices `ap-1`@site-a,
  `ap-2`@site-b
- When corre `execute()`
- Then `ap-1.networkSiteId` = id del NetworkSite de `site-a` y `ap-2.networkSiteId` = id del de `site-b`

#### Scenario: device sin nodo matching → networkSiteId null
- Given un device `ap-orphan` cuyo `uispSiteId` no corresponde a ningún NetworkSite
- When corre `execute()`
- Then el AccessPoint `ap-orphan` existe con `networkSiteId = null`

#### Scenario: re-link cuando el device se muda de nodo
- Given `ap-1`@site-a ya sembrado y linkeado a `site-a`
- When en un sync posterior el device pasa a `ap-1`@site-b
- Then el AccessPoint (mismo `id`, 1 sola fila) queda linkeado al NetworkSite de `site-b`

### Requirement: AP-4 — idempotencia y no-borrado
Dos `execute()` consecutivos con la misma data MUST NO duplicar AccessPoints. Una respuesta de UISP con
`devices: []` MUST NO borrar AccessPoints existentes. El result MUST reportar `accessPointsCreated` y
`accessPointsUpdated`.

#### Scenario: idempotente
- Given devices `ap-1`, `ap-2` (role ap)
- When corre `execute()` dos veces
- Then el catálogo tiene 2 AccessPoints; `result.accessPointsCreated` = 2 en la 1ª corrida y
  `result.accessPointsUpdated` = 2 en la 2ª (created = 0)

#### Scenario: lista vacía no borra
- Given un AP ya sembrado
- When un sync posterior trae `devices: []`
- Then el AccessPoint sigue existiendo (no se borra)

#### Scenario: dep opcional ausente
- Given un `SyncUispMirror` sin `accessPointRepo`
- When corre `execute()`
- Then no rompe y `result.accessPointsCreated` = `result.accessPointsUpdated` = 0

---

## Capability: campos manual-only en Contract

### Requirement: CN-AP-1 — GR sync NUNCA escribe networkSiteId/accessPointId
El `const data` de `PrismaClientMirrorRepository.upsertContract` MUST NO contener las keys
`networkSiteId` ni `accessPointId` (son manual-only, poblados en Fase B). Un cambio futuro que las
agregue MUST romper el test de pinning del data-block.

#### Scenario: data-block sin los campos manuales
- Given el source de `upsertContract`
- When se extrae el objeto `const data = { ... }`
- Then su set de keys NO incluye `networkSiteId` ni `accessPointId`

---

## Capability: persistencia (schema/migración)

### Requirement: MIG-1 — migración aditiva
La migración MUST crear la tabla `AccessPoint` (con `uispDeviceId` UNIQUE + índice por
`networkSiteId`), agregar `Contract.networkSiteId` y `Contract.accessPointId` (nullable, indexados) y
sus FKs `ON DELETE SET NULL`. MUST NO contener sentencias destructivas (DROP) ni backfill.

#### Scenario: SQL solo aditivo
- Given el archivo `migration.sql`
- When se revisa su contenido
- Then contiene `CREATE TABLE "AccessPoint"`, `ADD COLUMN` para los 2 campos de Contract, los índices y
  3 `ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE SET NULL`, y NO contiene `DROP`
