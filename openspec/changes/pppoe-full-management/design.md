# Design: Gestión FULL de PPPoE (tab en Gestión de Red)

## Contexto

El mapeo de los 3 repos confirmó que el CRUD contra el RADIUS HA está **completamente cableado**:
- Orchestrator (`users.py`): `POST /users`, `/{u}/password`, `/{u}/plan`, `/{u}/framed-ip`, `/{u}/mac`, `/{u}/suspend`, `/{u}/reactivate`, `DELETE /{u}`.
- BE (`HttpRadiusOrchestratorGateway`): espeja esos 1:1 (`createUser`, `changePassword`, `changePlan`, `changeFramedIp`, `setMac`, `suspend`, `reactivate`, `deleteUser`).
- BE rutas PPPoE: `GET /api/pppoe` (paginado, filtro `nasId`), `PATCH /api/pppoe/:id`, `move`, `pin-ip`/`unpin-ip`, `credentials`, `DELETE`.

Las brechas son acotadas: incluir huérfanos en el listado, crear con contrato opcional, y recrear username. El resto es FE.

## Decisiones

### D1 — Fuente de datos: espejo DB, no orchestrator en vivo
La tabla lee de `PppoeService` vía `GET /api/pppoe`. Razón: el orchestrator `GET /users` **no pagina ni filtra por NAS** (el NAS no es atributo del secret; se conoce por la sesión). El `nasId` vive en el espejo. Las **escrituras** sí van directo al HA (orchestrator) y el espejo se actualiza en el plano de control — patrón ya establecido por `UpdatePppoeService`. "Directo al HA" aplica a las mutaciones, no al listado.

### D2 — `includeUnassigned` como flag aditivo (default false)
En vez de un endpoint nuevo o quitar el filtro `contractId IS NOT NULL`, se agrega un parámetro opcional `includeUnassigned` a `ListAllPppoeServices` + `listAllPaginated` (Prisma + in-memory). Default `false` = comportamiento actual ⇒ `InternetServicesPage` no cambia (se pinea con un test). La page nueva pasa `true`. Backward-compatible, sin migración.

### D3 — Create standalone: use case nuevo `CreatePppoeStandalone`
El `CreatePppoeService` actual está atado al flujo de alta-por-contrato (activa `ContractService`, registra evento con actor). Para crear winbox-style **no** se contamina ese flujo con ramas opcionales. Se crea `CreatePppoeStandalone`:
1. Valida username único (espejo + orchestrator).
2. `orchestrator.createUser({ username, password, plan, framedIp? })`.
3. Inserta `PppoeService` con `contractId = input.contractId ?? null`, `nasId`, `ipMode`.
4. Si vino `contractId`: asocia/activa reusando el camino existente de asociación (no se reimplementa la activación de servicio).

**Orden de fallos:** primero el HA, después el espejo. Si el orchestrator falla, no hay fila fantasma. Si el espejo falla tras crear en el HA, se reporta (raro; el HA es la fuente).

### D4 — `RenamePppoeUsername`: create-then-delete (NUNCA delete-first)
El username es la key del RADIUS (`@unique`) y del secret; no hay rename atómico en el orchestrator. Flujo seguro:

```
1. validar newUsername único (espejo + orchestrator)            → si existe, abortar (nada tocado)
2. leer atributos del viejo (password, plan, framedIp, mac, status) desde espejo/orchestrator
3. orchestrator.createUser(newUsername, password, plan, framedIp?)  → crea el nuevo
4. re-aplicar atributos no cubiertos por create:
   - si tenía MAC:        orchestrator.setMac(newUsername, mac)
   - si estaba suspendido: orchestrator.suspend(newUsername, ...)
5. orchestrator.deleteUser(oldUsername)                          → borra el viejo
6. UPDATE PppoeService SET username = newUsername WHERE id = :id  → MISMO row (preserva contractId/id/historial)
```

- **Si el paso 3 falla:** abortar; el viejo intacto.
- **Si los pasos 4/5 fallan tras crear el nuevo:** el viejo SOBREVIVE (no se borró). Se reporta `partial` para reintento manual; el cliente puede conectar por cualquiera de los dos hasta resolver. Nunca queda sin secret.
- **Downtime inherente:** cambiar el username obliga a reconfigurar el CPE (el cliente autentica con ese username). La UI lo advierte explícitamente. No es un bug del flujo, es la naturaleza de cambiar el username en RADIUS (winbox igual).
- **Idempotencia / colisión transitoria:** entre el paso 3 y 5 conviven dos secrets (usernames distintos, no colisionan). El nuevo no acepta sesión hasta que el CPE se reconfigure.

### D5 — Password reveal on-demand
Reuso `GET /api/pppoe/:id/credentials` (gate `pppoe.manage`) + hook `usePppoeCredentials` (lazy). El listado sigue sin password (el `select` del repo lo omite). El botón "ojo" dispara la query solo para esa fila. Cero passwords en la respuesta paginada.

### D6 — Ubicación: tab en `GestionRedPage` + permisos
Tab aditivo: una entrada `{ key: 'pppoe', label: 'PPPoE' }` en el array `TABS` + un render condicional `{activeTab === 'pppoe' && <PppoeManagementTab />}`. No se tocan los demás tabs. El tab se gatea con `pppoe.read`; las acciones con `pppoe.manage` (FE `Can` + BE guard). Ambos permisos ya los recibe el front (los usan `InternetServicesPage`/`InternetPanel`).

### D7 — Status de negocio: reuso `pppoeDisplayStatus`
El DTO ya expone el status de negocio computado (`active|reduced|blocked|baja|inactive`) vía `pppoeDisplayStatus(status, enforcedState)`. La tabla y el filtro lo reusan (mismo vocabulario que `InternetServicesPage`), sin reintroducir el bug del status crudo.

### D8 — Mover de NAS e IP
`move` cambia `nasId` en el espejo. Para PPPoE con IP fija (`ipMode='fixed'`, `remoteAddress`), la IP se mantiene (Framed-IP en el HA no depende del NAS). El modo pool (`ipMode='pool'`, sqlippool) está DORMANT en prod (ningún NAS con `poolName`), así que en V1 no hay reasignación automática de IP al mover; se documenta como follow-up ligado al go-live del sqlippool.

### D9 — Wiring (anti-W6)
Los use cases nuevos (`CreatePppoeStandalone`, `RenamePppoeUsername`) se inyectan en `app.ts` y se montan en `pppoe.routes.ts`. Se verifica el wiring a mano contra este design y, si aplica el patrón del repo, con assertions de composition-root. Las rutas de sub-recurso (`/:id/rename`) se montan respetando el orden vs el catch-all `/:id`.

## Contrato BE↔FE (campo por campo)

**`GET /api/pppoe?includeUnassigned=true&nasId=&search=&status=&page=&limit=`** → `{ data: PppoeRow[], total, page, limit }`
`PppoeRow`: `{ id, username, displayStatus, plan, remoteAddress, ipMode, nasId, nasName, nasType, clientId|null, customerName|null, contractId|null, createdBy|null, createdAt }` — **sin password**.

**`POST /api/pppoe`** body: `{ username, password, plan, nasId, framedIp?, ipMode?, contractId? }` → `PppoeRow`.

**`POST /api/pppoe/:id/rename`** body: `{ newUsername }` → `{ id, username, status: 'ok'|'partial', message? }`.

(Reuso) **`PATCH /api/pppoe/:id`**: `{ profile?, password?, remoteAddress?, status?, reason?, actorId?, actorName? }`. **`POST /api/pppoe/:id/move`**: `{ nasId }`. **`GET /api/pppoe/:id/credentials`** → `{ username, password }`.

## Testing

- **BE (Jest + in-memory):** `includeUnassigned` (incluye/excluye/default); `CreatePppoeStandalone` (con/sin contrato, dup, falla orchestrator → sin fila); `RenamePppoeUsername` (happy, dup destino, delete-old-falla → viejo vive, preserva atributos). Reuso del in-memory orchestrator gateway.
- **FE (Vitest):** render tabla + paginación; filtro NAS round-trip; acciones llaman al hook correcto; reveal lazy; warning del rename; gate de permisos. Test que pinea `InternetServicesPage` sin cambios.
- **Anti-seam:** un test que recorra search/nasId desde el hook → query → endpoint (no solo las puntas).
