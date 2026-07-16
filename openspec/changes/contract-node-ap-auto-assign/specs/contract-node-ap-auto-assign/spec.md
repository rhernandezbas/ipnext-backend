# Spec — contract-node-ap-auto-assign (delta, Fase B)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

**Decisiones LOCKED del proposal/design (no se reabren):**
- Eslabón station→AP = `attributes.apDevice.id` del payload `/devices` existente (verificado en vivo,
  98.8% cobertura) — NO `/data-links`, NO llamadas extra.
- MAC = la llave del join (NUNCA IP). Normalización canónica en ambos lados.
- Resolución de MAC en cascada: `callerId` → último `RadiusEvent` por username (spike: callerId solo
  4.2%). Sin backfill de `callerId`.
- AUTO DURA: deriva ⇒ escribe (pisa manual); NO deriva ⇒ NO toca; ambiguo ⇒ skip + log.
- `AutoAssignContractNetwork` = use case aparte invocado por el scheduler post-sync, flag propio
  (`contract-network-auto-assign`, dark por default), `SyncState` propio.
- Permiso del PATCH manual = `(contracts, assign)` (module y action existentes; solo seed).
- Migraciones aditivas; el paso 9 del sync (catálogo AP) NO se modifica.

---

## Capability: eslabón station→AP en el mirror

### Requirement: MIR-1 — `mapDevice` extrae `apUispDeviceId`
`UispClient.mapDevice` MUST mapear `raw.attributes.apDevice.id` → `UispDevice.apUispDeviceId`, y
MUST devolver `null` cuando `attributes`, `apDevice` o `id` estén ausentes (null-safe, sin throw).

#### Scenario: station con apDevice
- Given un item crudo de `/devices` con `attributes.apDevice.id = 'ap-uuid-1'`
- When se mapea con `mapDevice`
- Then el `UispDevice` resultante tiene `apUispDeviceId = 'ap-uuid-1'`

#### Scenario: device sin apDevice → null
- Given items crudos: uno sin `attributes`, uno con `attributes` sin `apDevice`, y uno con
  `apDevice` sin `id`
- When se mapean
- Then los tres devuelven `apUispDeviceId = null` y ningún mapeo lanza error

### Requirement: MIR-2 — persistencia de `apUispDeviceId` en el mirror
`UispDeviceRepository.upsert` MUST persistir `apUispDeviceId` (create y update) en ambos adapters
(Prisma + in-memory). Un device que cambia de AP entre syncs MUST quedar con el `apUispDeviceId`
nuevo en la MISMA fila.

#### Scenario: upsert persiste y re-linkea
- Given un device upserteado con `apUispDeviceId='ap-1'`
- When se re-upsertea el mismo `uispId` con `apUispDeviceId='ap-2'`
- Then `findByUispId` devuelve UNA fila con `apUispDeviceId='ap-2'`

---

## Capability: normalización de MAC

### Requirement: MAC-1 — `normalizeMac` canónica
`normalizeMac(input)` MUST ser un helper puro de dominio que devuelve la MAC en formato canónico
(12 hex lowercase, sin separadores) aceptando separadores `:`, `-`, `.` y whitespace con case mixto,
y MUST devolver `null` para entradas inválidas (null/vacía/longitud ≠ 12 hex/no-hex).

#### Scenario: formatos válidos convergen
- Given `'AA:BB:CC:DD:EE:FF'`, `'aa-bb-cc-dd-ee-ff'`, `'aabb.ccdd.eeff'`, `'AABBCCDDEEFF'`
- When se normalizan
- Then las cuatro devuelven `'aabbccddeeff'`

#### Scenario: inválidas → null
- Given `null`, `''`, `'aa:bb:cc'` (corta), `'zz:bb:cc:dd:ee:ff'` (no-hex), `'100.64.28.5'`
- When se normalizan
- Then todas devuelven `null`

---

## Capability: resolución de MAC en cascada

### Requirement: CAS-1 — `latestMacByUsernames` batch
`RadiusEventRepository.latestMacByUsernames(usernames)` MUST devolver, por username, la `macAddress`
del evento preferido: entre eventos con `macAddress != null`, primero los `status='online'`; si no
hay online, el de `startedAt` más reciente. MUST resolver TODO el lote sin N+1 y MUST omitir del Map
los usernames sin ningún evento con MAC.

#### Scenario: online gana sobre más reciente
- Given user `u1` con evento closed (startedAt ayer, mac `M1`) y evento online (startedAt anteayer, mac `M2`)
- When `latestMacByUsernames(['u1'])`
- Then devuelve `u1 → M2`

#### Scenario: sin online, gana el más reciente con mac
- Given user `u2` con eventos closed: (hoy, mac null), (ayer, mac `M3`), (anteayer, mac `M4`)
- When se consulta
- Then devuelve `u2 → M3` (el de hoy se ignora por mac null)

#### Scenario: username sin eventos con mac
- Given user `u3` sin eventos (o solo con mac null)
- When se consulta `['u1','u3']`
- Then el Map NO contiene `u3`

### Requirement: CAS-2 — cascada callerId → RadiusEvent
`AutoAssignContractNetwork` MUST usar `normalizeMac(callerId)` como fuente primaria de MAC del
pppoe; cuando el callerId sea null/inválido MUST caer al resultado de `latestMacByUsernames`. El
result MUST contar `macFromCallerId` y `macFromRadiusEvent` por separado.

#### Scenario: callerId válido gana
- Given un pppoe con `callerId` válido que matchea la station S1 y un RadiusEvent cuya mac matchea S2
- When corre el auto-assign
- Then el contrato queda derivado vía S1 y `macFromCallerId` se incrementa

#### Scenario: fallback a RadiusEvent
- Given un pppoe con `callerId = null` y un RadiusEvent online con mac que matchea una station
- When corre el auto-assign
- Then el contrato se deriva vía esa station y `macFromRadiusEvent` se incrementa

---

## Capability: auto-assign AUTO DURA

### Requirement: AA-1 — deriva ⇒ escribe (pisa), no deriva ⇒ no toca
Cuando la derivación resuelve un AP, el use case MUST escribir `Contract.networkSiteId` (=
`ap.networkSiteId`) y `Contract.accessPointId` (= `ap.id`), INCLUSO pisando una asignación previa
distinta (manual o automática). Cuando la derivación NO resuelve (cualquier eslabón roto), MUST NO
modificar los valores existentes del contrato.

#### Scenario: asigna contrato virgen
- Given contrato C1 sin asignación, con pppoe enabled cuyo callerId matchea la station S1 viva con
  `apUispDeviceId` del AP A1 (linkeado al nodo N1)
- When corre el auto-assign
- Then C1 queda `networkSiteId = N1.id`, `accessPointId = A1.id` y `assigned` = 1

#### Scenario: pisa asignación manual previa
- Given C2 asignado a mano a (N9, A9) y una derivación que resuelve (N1, A1)
- When corre
- Then C2 queda (N1, A1) — AUTO DURA

#### Scenario: no-match no nullea lo manual
- Given C3 asignado a mano a (N9, A9) y un pppoe cuya MAC no matchea ninguna station
- When corre
- Then C3 sigue (N9, A9) intacto y `unresolved` se incrementa

### Requirement: AA-2 — ambiguo: skip + log, jamás asignar
Cuando tras aplicar la política de candidatos (stations vivas) y el desempate por `lastSeenAt` quedan
2+ stations con la misma MAC normalizada, el use case MUST saltear el contrato sin escribir, MUST
loguear un warning con la MAC y MUST contarlo en `ambiguous`.

#### Scenario: duplicado vivo sin desempate
- Given dos stations VIVAS con la misma mac normalizada y el mismo `lastSeenAt`
- When corre
- Then el contrato no se toca, `ambiguous` = 1 y se emite `console.warn`

#### Scenario: missing pierde contra viva
- Given dos stations con la misma mac: una `missingSince != null` y una viva
- When corre
- Then se deriva por la VIVA (no es ambiguo)

#### Scenario: desempate por lastSeenAt
- Given dos stations vivas con la misma mac y `lastSeenAt` distintos
- When corre
- Then se deriva por la de `lastSeenAt` más reciente

### Requirement: AA-3 — selección de pppoe por contrato
Para un contrato con N `PppoeService`, el use case MUST evaluar SOLO el de `status='enabled'` con
`createdAt` más reciente. Un contrato sin ningún pppoe enabled MUST contar como no-derivable (no se
toca). Los pppoe con `contractId = null` MUST quedar fuera del universo.

#### Scenario: gana el enabled más reciente
- Given C1 con pppoe P1 (enabled, viejo, deriva a A1) y P2 (enabled, nuevo, deriva a A2)
- When corre
- Then C1 queda asignado según P2 (A2)

#### Scenario: disabled no deriva
- Given C2 cuyo único pppoe está `status='disabled'` con callerId matcheable
- When corre
- Then C2 no se toca y cuenta como `unresolved`

### Requirement: AA-4 — idempotencia y sin-cambio
Dos corridas consecutivas con la misma data MUST producir en la segunda 0 escrituras: los contratos
ya alineados MUST contarse como `unchanged` y MUST NO generar write.

#### Scenario: segunda corrida sin writes
- Given una corrida que asignó C1 y C2
- When corre de nuevo sin cambios en la data
- Then `assigned` = 0, `unchanged` = 2 y no hubo llamadas de escritura al repo de contratos

### Requirement: AA-5 — aislamiento, flag y métricas
El scheduler MUST invocar el auto-assign SOLO tras un sync exitoso y SOLO con el feature flag
`contract-network-auto-assign` habilitado (ausente = deshabilitado). Un throw del auto-assign MUST NO
afectar el resultado del sync (warning + continuar). El use case MUST persistir sus métricas
(`contractsEvaluated`, `assigned`, `unchanged`, `unresolved`, `ambiguous`, `macFromCallerId`,
`macFromRadiusEvent`, `durationMs`) en `SyncState` `entity='contract-network-auto-assign'`.

#### Scenario: flag apagado → no corre
- Given el flag ausente o disabled
- When el scheduler completa un sync exitoso
- Then el auto-assign NO se ejecuta y el run del sync termina normal

#### Scenario: fallo aislado
- Given el flag enabled y un auto-assign que lanza
- When corre el tick
- Then el summary del sync se reporta igual (sites/devices) y se loguea el warning del auto-assign

#### Scenario: métricas persistidas
- Given un run con 2 asignados y 1 ambiguo
- When termina
- Then `SyncState('contract-network-auto-assign').lastResult` empieza con `ok:` y su JSON contiene
  `assigned: 2` y `ambiguous: 1`

---

## Capability: picker manual (BE)

### Requirement: PICK-1 — `SetContractNetworkAssignment` valida y mantiene coherencia
El use case MUST: devolver not-found tipado si el contrato no existe; validar existencia de
`networkSiteId`/`accessPointId` non-null (errores tipados); rechazar APs con
`missingSince != null` (`AccessPointRetiredError`); rechazar AP+site non-null incoherentes
(`AccessPointNotInSiteError`); y garantizar el invariante del par persistido
(`accessPointId != null ⇒ networkSiteId === ap.networkSiteId`), autocompletando el site desde el AP
cuando se omite y limpiando el AP cuando el site nuevo no lo contiene. `networkSiteId: null`
explícito MUST limpiar ambos campos. MUST devolver un DTO (nunca entidad Prisma cruda).

#### Scenario: asignar AP autocompleta el nodo
- Given AP A1 vivo linkeado al nodo N1 y un contrato sin asignación
- When se ejecuta con `{ accessPointId: A1.id }` (sin networkSiteId)
- Then el contrato queda `(N1.id, A1.id)` y el result es `{ id, networkSiteId, accessPointId }`

#### Scenario: AP de otro nodo → error tipado
- Given AP A1 ∈ N1
- When se ejecuta con `{ networkSiteId: N2.id, accessPointId: A1.id }`
- Then lanza `AccessPointNotInSiteError` y el contrato no cambia

#### Scenario: AP retirado → error tipado
- Given AP A9 con `missingSince != null`
- When se ejecuta con `{ accessPointId: A9.id }`
- Then lanza `AccessPointRetiredError`

#### Scenario: mover el site limpia un AP incompatible
- Given contrato asignado a `(N1, A1)` con A1 ∈ N1
- When se ejecuta con `{ networkSiteId: N2.id }` (AP omitido)
- Then el contrato queda `(N2.id, null)`

#### Scenario: desasignar nodo limpia todo
- Given contrato asignado a `(N1, A1)`
- When se ejecuta con `{ networkSiteId: null }`
- Then el contrato queda `(null, null)`

### Requirement: PICK-2 — catálogo de APs asignables
`ListAssignableAccessPoints` MUST devolver SOLO APs con `missingSince === null`, filtrables por
`networkSiteId`, ordenados por `name` asc, mapeados a DTO `{ id, name, mac, networkSiteId }`.

#### Scenario: filtra retirados y por nodo
- Given APs: A1 (N1, vivo), A2 (N1, missing), A3 (N2, vivo)
- When se lista con `networkSiteId = N1`
- Then devuelve exactamente [A1]

### Requirement: PICK-3 — rutas y permisos
`GET /api/access-points` MUST exigir auth + `network.read` y devolver `{ data: AccessPointOptionDto[] }`.
`PATCH /api/contracts/:id/network-assignment` MUST exigir auth + `contracts.assign`, validar el body
por whitelist zod (al menos una key; 400 si vacío/desconocido), y mapear errores tipados:
contrato → 404; site/AP inexistente, AP retirado, AP∉site → 422. Sin permiso MUST responder 403.

#### Scenario: PATCH feliz
- Given un usuario con `contracts.assign` y body `{ "accessPointId": "<A1>" }`
- When llama al PATCH
- Then 200 con `{ id, networkSiteId, accessPointId }`

#### Scenario: sin permiso → 403
- Given un usuario autenticado SIN `contracts.assign` (y no super_admin)
- When llama al PATCH
- Then 403 `PERMISSION_DENIED`

#### Scenario: body inválido → 400
- Given body `{}` (ninguna key)
- When llama al PATCH
- Then 400 `VALIDATION_ERROR`

#### Scenario: AP inexistente → 422
- Given body con un `accessPointId` que no existe
- When llama al PATCH
- Then 422 con el code del error tipado

---

## Capability: persistencia (schema/migraciones/permiso)

### Requirement: MIG-1 — migración aditiva del mirror
La migración MUST agregar `UispDevice.apUispDeviceId` (TEXT, nullable) y MUST NO contener sentencias
destructivas (DROP) ni backfill.

#### Scenario: SQL solo aditivo
- Given el archivo `migration.sql`
- When se revisa su contenido
- Then contiene `ADD COLUMN "apUispDeviceId"` sobre `"UispDevice"` y NO contiene `DROP`

### Requirement: MIG-2 — seed idempotente del permiso
La migración de permisos MUST insertar `RbacPermission (contracts, assign)` y su grant a
`super_admin` y a `administrador` con `ON CONFLICT DO NOTHING` (re-ejecutable sin error).

#### Scenario: seed presente e idempotente
- Given el archivo de la migración de permisos
- When se revisa su contenido
- Then contiene el INSERT del permiso `(contracts, 'assign')`, el grant a `super_admin`, el grant a
  `administrador` y todos los INSERT usan `ON CONFLICT DO NOTHING`

### Requirement: MIG-3 — GR sync sigue sin escribir los campos manuales
El data-block de `PrismaClientMirrorRepository.upsertContract` MUST seguir SIN las keys
`networkSiteId`/`accessPointId` (pin de Fase A intacto — este change escribe SOLO via
`updateNetworkAssignment`).

#### Scenario: pin del data-block intacto
- Given el source de `upsertContract`
- When se extrae el `const data`
- Then su set de keys NO incluye `networkSiteId` ni `accessPointId`
