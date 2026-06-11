# Exploration: nodes-city-mapper (#45)

## Goal

Reemplazar la carga manual de `city` en NetworkSites por un **mapper contra el catálogo real de nodos IClass**, análogo al mapper iclass-proyectos (`IClassSoType → Project`). Hoy los 73 NetworkSites tienen `city` nulo o cargado a mano a ciegas; el campo viaja a IClass como `address.city` y como `address.nodeCode` fallback cuando se crea una OS de RED. El badge "Faltan datos IClass" (FE #76) ya marca los incompletos.

---

## Patrón iclass-proyectos — diseccionado

El patrón `SoType → Project` es el blueprint a clonar. Sus piezas:

| Pieza | Archivo | Rol |
|-------|---------|-----|
| Entidad de catálogo | `src/domain/entities/iclass-so-type.ts` | `{ id, code, description, active, lastSyncedAt }` |
| Port del catálogo | `src/domain/ports/IClassSoTypeRepository.ts` | `list()`, `getById()`, `getByCode()`, `upsertByCode()`, `markInactiveExcept()` |
| Sync desde IClass | `src/application/use-cases/SyncIClassSoTypes.ts` | `iclass.listServiceOrderTypes()` → `repo.upsertByCode()` → `repo.markInactiveExcept()` |
| Listar catálogo | `src/application/use-cases/ListIClassSoTypes.ts` | thin wrapper sobre `repo.list({ active })` |
| Asignar a entidad | `src/application/use-cases/AssignIClassSoTypeToProject.ts` | valida `exists + active`, escribe `project.iclassSoTypeId` |
| Adapter Prisma | `src/infrastructure/adapters/prisma/PrismaIClassSoTypeRepository.ts` | upsert por `code` (unique), soft-delete vía `active` |
| Adapter In-Memory | `src/infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository.ts` | para tests |
| Routes admin | `src/infrastructure/http/routes/iclass-admin.routes.ts` | `POST /so-types/sync` + `GET /so-types` (auth requerida) |
| Wiring en Project | `src/infrastructure/http/routes/projects.routes.ts:93-97` | `PATCH /projects/:id` con `iclassSoTypeId` delega a `AssignIClassSoTypeToProject` |

**Flujo de sync**: manual (no cron). Un operador llama `POST /api/admin/iclass/so-types/sync`; el BE fetcha el catálogo de IClass, upserta en la DB, y marca inactive lo que desapareció. Catálogo persistido en DB — no on-demand.

**Flujo de uso en dispatch**: `SendTaskToIClass` (`src/application/use-cases/SendTaskToIClass.ts:101-104`) lee `project.iclassSoType.code` vía `tasks.getTaskProjectMapping(taskId)` y falla con `MissingIClassMappingError` si no está asignado o está inactivo.

---

## Endpoint de ciudades IClass — shape real

El IClass skill documenta **dos** endpoints de nodos:

1. **`GET /thirdparties/{thirdPartyId}/nodes`** — ya en uso. Devuelve `{ codigo, descricao }` → mapeado a `IClassNode { code, description }`. El `code` (= `codigo`) ES el valor que va como `address.nodeCode` en la OS. Usado en `IClassClient.listNodes()` (`src/infrastructure/adapters/iclass/IClassClient.ts:137-150`), cacheado 5 min in-memory.

2. **`GET /nodes`** — endpoint independiente del thirdParty. Según el skill: filtros `code`, `description`, `thirdPartyCode`, **`city`**, `clusterName`. Devuelve entidades con campo `city`. **Este endpoint da el catálogo de nodos con su ciudad asociada** — es la fuente de verdad para el mapper.

**Hipótesis sobre la shape de `/nodes`** (verificar contra el OpenAPI live):
```json
{
  "objects": [
    { "codigo": "TN-001", "descricao": "Torre Norte", "cidade": "Mercedes", ... }
  ]
}
```
El campo ciudad probablemente se llama `cidade` (PT) en el JSON de IClass. El valor exacto hay que bajarlo del spec (`curl https://api-v2.iclass.com.br/q/openapi?format=json`).

**¿El BE ya tiene `listIClassCities`?** No. `IClassPort` solo tiene:
- `listNodes()` → `GET /thirdparties/{thirdPartyId}/nodes` — no incluye `city` en el shape
- No existe método para `GET /nodes` con city

**Conclusión**: hay que agregar un método al `IClassPort` (o extender `listNodes`) para exponer las ciudades del catálogo.

---

## Estado actual de NetworkSite

### Entidad de dominio
`src/domain/entities/networkSite.ts`:
```ts
interface NetworkSite {
  city: string;            // cargado manualmente hoy, UISP no lo expone
  iclassNodeCode: string | null;  // #29 — nodeCode para OS de RED
  uispSiteId: string | null;      // link al mirror UISP
  // ... name, address, coordinates, type, status, etc.
}
```

### Schema Prisma
`prisma/schema.prisma:1504-1534`:
```
model NetworkSite {
  city           String?
  iclassNodeCode String?
  uispSiteId     String?
  ...
}
```

### Cómo viaja `city` a IClass
`src/application/use-cases/dispatchTaskToIClass.ts:119`:
```ts
const effectiveCity = isNet ? (networkSite?.city ?? '') : task.customerCity!;
```
Y en `IClassClient.buildServiceOrderPayload` (`src/infrastructure/adapters/iclass/IClassClient.ts:326`):
```ts
nodeCode: input.nodeCode ?? input.city,
```
**El `city` del NetworkSite se usa como `address.city` en la OS IClass Y como `address.nodeCode` fallback si no hay `nodeCode` explícito.** Por eso "valores correctos" — hay que poner exactamente lo que IClass conoce como código de nodo.

### Dónde se edita `city` hoy
`PUT /api/network-sites/:id` → `UpdateNetworkSite.execute(id, data)` (`src/application/use-cases/UpdateNetworkSite.ts`) — escribe directamente al repo. Sin validación contra catálogo IClass.

### Readiness badge (FE #76)
El FE ya marca sitios "Faltan datos IClass" cuando `city` o `iclassNodeCode` están vacíos. El mapper resolvería el campo `city` con un valor validado del catálogo.

---

## Relación city / nodeCode en el dispatch

Cuando `task.kind === 'network'`:
1. `resolvedNodeCode = networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE` (línea 137 de `SendTaskToIClass`)
2. `effectiveCity = networkSite?.city ?? ''` (línea 122)
3. En el payload IClass: `city = effectiveCity`, `nodeCode = input.nodeCode ?? input.city` (fallback)

**Implicación**: `city` debe ser el string exacto que IClass espera en `address.city`. Los nodos IClass tienen un `city`/`cidade` asociado — ese es el valor correcto. El mapper asegura que `NetworkSite.city` tenga ese valor en lugar de uno libre/tipado a mano.

---

## Opciones de implementación

### Opción A — Catálogo persistido (mirror de SoTypes) ★ RECOMENDADA
Clonar el patrón `IClassSoType` para ciudades:

1. **Nuevo método en `IClassPort`**: `listNodeCities(): Promise<IClassCityDescriptor[]>` que llama a `GET /nodes?clusterName=IPNEXT INTERNET&pagesize=200` y extrae `{ nodeCode: codigo, city: cidade, description: descricao }`.
2. **Tabla `IClassCity`** (`id`, `nodeCode`, `city`, `description`, `active`, `lastSyncedAt`).
3. **`IClassCityRepository`** port con `list()`, `upsertByNodeCode()`, `markInactiveExcept()`.
4. **`SyncIClassCities`** use case: fetcha, upserta, deactiva desaparecidos.
5. **`AssignIClassCityToNetworkSite`** use case: valida exists+active, escribe `NetworkSite.city`.
6. **`GET /api/admin/iclass/cities`** (listado) + **`POST /api/admin/iclass/cities/sync`** (sync manual).
7. **`PATCH /api/network-sites/:id`** acepta `iclassCityCode` → delega a `AssignIClassCityToNetworkSite`.

- **Pros**: FE puede mostrar un select con los valores reales de IClass; validación en dispatch; catálogo offline disponible; patrón probado.
- **Contras**: nueva tabla en DB + migration; más código.
- **Effort**: Medio.

### Opción B — On-demand (sin persistir)
El endpoint `GET /api/network-sites/iclass-cities` llama directamente a IClass en el momento y devuelve la lista. El FE lo usa para el select en la pantalla de nodos. No hay tabla DB.

- **Pros**: sin migration; más simple de implementar.
- **Contras**: lentitud / dependencia de disponibilidad IClass en cada render del selector; sin validación en dispatch (no hay catálogo para comparar); no detecta ciudades inactivas.
- **Effort**: Bajo.

### Opción C — Extender `listNodes` existente con campo `city`
Añadir `city` al shape de `IClassNode` y al resultado de `IClassClient.listNodes()` (`GET /thirdparties/{id}/nodes`). Si ese endpoint devuelve `cidade`, se puede reusar sin nuevo endpoint.

- **Pros**: reutiliza infraestructura existente, caché 5 min ya funciona.
- **Contras**: `/thirdparties/{id}/nodes` puede NO incluir `cidade` (a verificar). Mezcla la responsabilidad del "listado para dropdown de reenvío" con el "catálogo de ciudades para el mapper". Breaking change en `IClassNode`.
- **Effort**: Bajo/Medio (depende del shape del endpoint).

---

## Recommendation

**Opción A — catálogo persistido**, clonando el patrón SoType.

Razones:
1. **Consistencia**: el proyecto ya tiene este patrón establecido y probado. El equipo lo entiende. Menos sorpresas.
2. **Validación en dispatch**: con catálogo en DB, `SendTaskToIClass` puede validar que `networkSite.city` matchea un nodo real sin llamar a IClass en el momento del despacho (mismo mecanismo que `iclassSoType.active`).
3. **FE experiencia**: `GET /api/admin/iclass/cities` da el select con valores reales para el catálogo de nodos (pantallas #75/#77).
4. **Offline**: si IClass está caído, el catálogo sigue disponible para asignar ciudades.

**Scope exacto del BE** (se puede confirmar en specs):
- 1 migration: tabla `IClassCity`.
- 1 port: `IClassCityRepository`.
- 3 use cases: `SyncIClassCities`, `ListIClassCities`, `AssignIClassCityToNetworkSite`.
- 1 extensión al `IClassPort`: método `listNodeCities()`.
- 1 extensión al `IClassClient`: implementar `listNodeCities()`.
- 1 extensión al `InMemoryIClassClient`: stub `listNodeCities()`.
- 2 routes admin: `POST /cities/sync`, `GET /cities`.
- 1 extensión a `networkSite.routes.ts` o `PATCH /network-sites/:id`: aceptar `iclassCityCode` → `AssignIClassCityToNetworkSite`.

**Verificar antes de specs**: bajar el OpenAPI de IClass y confirmar que `GET /nodes` devuelve `cidade` (o el nombre real del campo ciudad) en su response shape.

---

## Open Questions

1. **Shape exacta de `GET /nodes`**: ¿el campo se llama `cidade`, `city`, `municipio`? ¿Incluye `nodeCode` (`codigo`)? Verificar en el spec live: `curl https://api-v2.iclass.com.br/q/openapi?format=json | node -e 'const s=require("fs").readFileSync(0,"utf8"); const j=JSON.parse(s); console.log(JSON.stringify(j.components.schemas["Node"],null,2))'`.

2. **¿`GET /thirdparties/{id}/nodes` ya incluye `cidade`?** Si sí, la Opción C se vuelve más atractiva y ahorra una tabla. Verificar en el mismo spec.

3. **¿El FE quiere un campo separado `iclassCityCode` o simplemente sobrescribir `city` via el mapper?** La propuesta es que el mapper llene `NetworkSite.city` directamente (sin columna nueva). Si el FE necesita trackear "cuál nodo IClass está asignado" con más metadata, conviene una FK a `IClassCity`.

4. **Permisos**: ¿el sync de ciudades requiere el mismo permiso que el sync de SoTypes (`admin`)? ¿La asignación en el catálogo de nodos requiere `uisp.manage` o `network.manage`?

5. **Cron o manual**: ¿el sync de ciudades es manual como SoTypes, o se agrega al cron de UISP sync? Mantener manual por consistencia es lo más simple.

---

## Ready for Proposal

**Sí**. La exploración es suficientemente conclusiva:
- El patrón a clonar está identificado y diseccionado (`IClassSoType → Project`).
- El endpoint IClass a usar (`GET /nodes`) está identificado; shape a verificar.
- Las piezas BE están claras (tabla + port + 3 use cases + 2 routes + extensiones).
- La pregunta abierta más importante (shape del campo `cidade`) es un punto de verificación, no un bloqueante conceptual.
- Se recomienda Opción A (catálogo persistido).
