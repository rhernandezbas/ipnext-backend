# Bridge interno de tareas — `/api/internal/*`

> API interna para crear tareas de Prominense, cambiarles el estado, asignar técnico y despacharlas a IClass, pensada para automatización de confianza (agentes, scripts, integraciones internas). Última actualización: 2026-09-16.

## Qué es y por qué existe

Antes de esto, crear una tarea y mandarla a IClass exigía pasar por `/api/scheduling` (JWT + RBAC) o ir directo a la base de datos. Este bridge expone lo mismo, compuesto sobre los mismos casos de uso ya existentes (`CreateTask`, `SetTaskGeneralStatus`, `UpdateTask`, `SendTaskToIClass`, `AssignIClassTeam`, `ListClients`, `GetClientContracts`, `ListProjects`, `ListNetworkSites`), sin auth, para que cualquier proceso interno pueda pegarle directo.

**No agrega auth ni API key. Es una decisión explícita**, no un descuido: se evaluó usar `createApiKeyMiddleware` (el mismo mecanismo de `/api/external/v1`) y se descartó a propósito para que la integración fuera fricción cero. Por eso:

- **Nunca exponer este prefijo a internet.** Solo debe ser alcanzable desde la red interna/VPN.
- Cualquiera que le pegue puede crear tareas reales, cambiarles el estado, y **crear Órdenes de Servicio reales en IClass** (sistema externo de terceros, con técnicos de verdad).

## Dónde vive

- Código: `src/infrastructure/http/routes/internal-tasks.routes.ts` y `src/infrastructure/http/routes/internal-catalogs.routes.ts`.
- Wiring: `src/infrastructure/http/app.ts` (busca `/api/internal/tasks` y `/api/internal/catalogs`).
- Deploy: automático al pushear a `main` (`.github/workflows/deploy.yml`, self-hosted en saturno).
- Base URL prod: `https://app.prometheus-alpha.xyz`

## Endpoints de tareas — `/api/internal/tasks`

### `POST /api/internal/tasks` — crear tarea

Dos formas, según `kind`:

**Tarea de cliente** (`kind: "customer"`) — requiere `customerId` + `contractId` reales:

```json
{
  "kind": "customer",
  "customerId": "76e8b565-74e3-44c3-b57d-22f791d1d09e",
  "contractId": "8c85dc6f-e176-47d1-b9b8-ea85dc922bbf",
  "projectId": "cf3f9488-58c7-493f-b3b0-43d3f5c69de2",
  "title": "Visita técnica",
  "description": "Motivo de la visita",
  "category": "Inspección",
  "priority": "Normal",
  "estimatedHours": 1,
  "address": "CALLE 52 ENTRE 27 Y 29 NRO 661B"
}
```

`customerName`/`phone`/`city` se resuelven SOLOS a partir del `customerId` (no hace falta mandarlos).

**Tarea de nodo/red** (`kind: "network"`) — prohíbe `customerId`/`contractId`, requiere `networkSiteId` (red) o `networkSiteName` + `iclassCityCode` (fibra):

```json
{
  "kind": "network",
  "networkType": "red",
  "networkSiteId": "b4d0d6a4-66f3-4d58-b9a0-655205238bf0",
  "projectId": "d63d2ae9-2b6c-47c8-bc61-bc296d2cf9cd",
  "title": "Mantenimiento de nodo",
  "description": "Motivo",
  "category": "Inspección",
  "priority": "Normal",
  "estimatedHours": 1,
  "address": "Nodo Ocampo, Mercedes"
}
```

> **Gotcha**: en tareas de nodo, `address` es **obligatorio** aunque el sitio elegido ya tenga su propio `address` cargado en el catálogo — `CreateTask` lo exige siempre en el payload.

**Campos comunes**: `title`, `category` (catálogo `TaskCategory`: Instalación/Reparación/Mantenimiento/Inspección/Otro/Relevamiento), `priority` (catálogo `TaskPriority`: Baja/Normal/Alta/Urgente/Crítica), `estimatedHours`, `description`, `notes` (opcionales salvo los marcados). `stageId` es opcional — si se omite, la tarea nace en el stage "Nuevo" por defecto.

`projectId` **es obligatorio si vas a mandar la tarea a IClass** — tiene que ser un proyecto con `iclassSoTypeId` mapeado (ver catálogo `/projects`). Si falta, `send-to-iclass` responde `422 MISSING_PROJECT_FOR_ICLASS`.

Respuesta: `201` + la tarea completa (DTO, nunca la fila cruda de Prisma).

### `PATCH /api/internal/tasks/:id/status` — cambio de estado

```json
{ "status": "closed" }
```

`status` ∈ `open | closed | dismissed`. Idempotente. `404` si la tarea no existe.

### `POST /api/internal/tasks/:id/assign` — asignar técnico local

```json
{ "assigneeId": "<id de un usuario RBAC interno>" }
```

Esto asigna el **responsable interno** (`assigneeId`, un usuario del backend), NO el técnico de campo de IClass — para eso está `send-to-iclass` (abajo). `assigneeId: null` desasigna.

### `POST /api/internal/tasks/:id/send-to-iclass` — crear OS en IClass + asignar técnico + horario

Este es el endpoint que hace todo el trabajo pesado: **persiste el horario en la tarea → crea la Orden de Servicio en IClass → asigna el técnico y el horario a esa OS**, en un solo llamado.

```json
{
  "targetStageId": "b00b5999-63cd-4c3f-b789-dd4a2a6167a0",
  "workflowId": "761d6039-cc98-4652-b7bb-307e84d3347e",
  "teamLogin": "IPNXANDYM",
  "scheduleStart": "2026-09-17T09:00:00-03:00",
  "scheduleEnd": "2026-09-17T11:00:00-03:00"
}
```

- `targetStageId` / `workflowId`: el stage "Enviar a IClass" de tu workflow de scheduling (valores de prod arriba — son fijos salvo que se reconfigure el workflow).
- `teamLogin`: login del técnico, sale del catálogo `/teams` (ej. `IPNXANDYM` = Andy Medina).
- `scheduleStart` / `scheduleEnd`: **ISO 8601 con offset** (`-03:00` para Argentina). El horario que IClass realmente necesita (`yyyy-MM-dd HH:mm:ss -0300`) lo arma el adapter — nunca lo construyas vos mismo.
- `scheduleEnd` debe ser posterior a `scheduleStart`.

Si algo falla DESPUÉS de crear la OS (ej. el técnico no está asignable), la OS ya quedó creada en IClass y `iclassOrderCode` ya quedó persistido — no hay rollback, es información válida igual.

Respuesta: `200` + la tarea con `iclassOrderCode` seteado.

## Catálogos — `/api/internal/catalogs`

Para armar los payloads de arriba sin ir a la base de datos a mano:

| Endpoint | Para qué sirve |
|---|---|
| `GET /clients?search=&page=&limit=&status=` | Buscar cliente por nombre/email/teléfono → `customerId` |
| `GET /clients/:id/contracts` | Todos los contratos de un cliente (`id, code, status, address, technology, plan, startDate`) — clave cuando tiene varios: se distinguen por `address` (domicilio) y `technology` |
| `GET /projects?visible=` | Catálogo de proyectos, con `isNetworkProject` e `iclassSoTypeId` — para elegir el `projectId` correcto según el tipo de tarea |
| `GET /network-sites` | Catálogo de nodos (`id, name, city, address, iclassNodeCode, coordinates, ...`) — para `networkSiteId` en tareas de nodo |
| `GET /cities?active=true` | Catálogo de ciudades/nodos de IClass (sincronizado) |
| `GET /teams` | Catálogo de técnicos/cuadrillas de IClass (`login`, `name`, `active`, `selectable`) → `teamLogin` |

Todos devuelven `{ "items": [...] }` (o con `total/page/limit` en `/clients`, que pagina).

## Ejemplos reales (probados en producción, 2026-09-16)

### 1. Tarea de cliente completa

```bash
# 1) Buscar cliente
curl "https://app.prometheus-alpha.xyz/api/internal/catalogs/clients?search=hernandez"
# → {"items":[{"id":"76e8b565-...","name":"HERNANDEZ RONALD","city":"Mercedes",...}]}

# 2) Ver sus contratos (por si tiene varios)
curl "https://app.prometheus-alpha.xyz/api/internal/catalogs/clients/76e8b565-.../contracts"
# → {"items":[{"id":"8c85dc6f-...","code":"10944","status":"active","address":"CALLE 52...","plan":"300MB"}]}

# 3) Elegir proyecto
curl "https://app.prometheus-alpha.xyz/api/internal/catalogs/projects"
# → ... {"id":"cf3f9488-...","title":"VISITA TECNICA WIRELESS","iclassSoTypeId":"3a860c97-..."} ...

# 4) Elegir técnico
curl "https://app.prometheus-alpha.xyz/api/internal/catalogs/teams"
# → ... {"login":"IPNXANDYM","name":"Andy Medina","active":true,"selectable":true} ...

# 5) Crear la tarea
curl -X POST "https://app.prometheus-alpha.xyz/api/internal/tasks" \
  -H "Content-Type: application/json" \
  -d '{"kind":"customer","customerId":"76e8b565-...","contractId":"8c85dc6f-...",
       "projectId":"cf3f9488-...","title":"Visita técnica","description":"...",
       "category":"Inspección","priority":"Normal","estimatedHours":1,
       "address":"CALLE 52 ENTRE 27 Y 29 NRO 661B"}'
# → 201, id "93d730fc-...", sequenceNumber 6423

# 6) Despachar a IClass
curl -X POST "https://app.prometheus-alpha.xyz/api/internal/tasks/93d730fc-.../send-to-iclass" \
  -H "Content-Type: application/json" \
  -d '{"targetStageId":"b00b5999-63cd-4c3f-b789-dd4a2a6167a0",
       "workflowId":"761d6039-cc98-4652-b7bb-307e84d3347e",
       "teamLogin":"IPNXANDYM",
       "scheduleStart":"2026-09-17T13:00:00-03:00","scheduleEnd":"2026-09-17T15:00:00-03:00"}'
# → 200, iclassOrderCode "6423"
```

### 2. Tarea de nodo

```bash
curl "https://app.prometheus-alpha.xyz/api/internal/catalogs/network-sites"
# → ... {"id":"b4d0d6a4-...","name":"[5] Nodo Ocampo","city":"Mercedes","iclassNodeCode":"Mercedes"} ...

curl -X POST "https://app.prometheus-alpha.xyz/api/internal/tasks" \
  -H "Content-Type: application/json" \
  -d '{"kind":"network","networkType":"red","networkSiteId":"b4d0d6a4-...",
       "projectId":"d63d2ae9-2b6c-47c8-bc61-bc296d2cf9cd","title":"Mantenimiento de nodo",
       "description":"...","category":"Inspección","priority":"Normal","estimatedHours":1,
       "address":"Nodo Ocampo, Mercedes"}'
# → 201, sequenceNumber 6424

curl -X POST "https://app.prometheus-alpha.xyz/api/internal/tasks/3c5e0c98-.../send-to-iclass" \
  -H "Content-Type: application/json" \
  -d '{"targetStageId":"b00b5999-63cd-4c3f-b789-dd4a2a6167a0",
       "workflowId":"761d6039-cc98-4652-b7bb-307e84d3347e",
       "teamLogin":"IPNXANDYM",
       "scheduleStart":"2026-09-17T16:00:00-03:00","scheduleEnd":"2026-09-17T18:00:00-03:00"}'
# → 200, iclassOrderCode "6424"
```

## Proyectos de referencia en prod (para elegir `projectId`)

| Proyecto | id | Tipo |
|---|---|---|
| VISITA TECNICA WIRELESS | `cf3f9488-58c7-493f-b3b0-43d3f5c69de2` | cliente |
| VISITA TECNICA - FIBRA | `9ffa5d40-03ab-48ed-be44-1a10622297bb` | cliente |
| VISITA TECNICA - CAMARAS | `0d703010-796d-472c-8105-99a87eab89fb` | cliente |
| INSTALACION FIBRA | `9c3cc4e9-2ce3-418c-a7dc-dae0e58dab92` | cliente |
| INSTALACION WIRELESS | `010b7fea-0b4f-40ab-9b9f-e9e33637473d` | cliente |
| RETIROS DE EQUIPOS | `e06dda2d-f168-4c7c-b692-5771958b0423` | cliente |
| Red - Fibra | `a29b2b8e-8810-437a-9b5d-d4b3fcab1e5a` | nodo/red |
| RED - Wireless | `d63d2ae9-2b6c-47c8-bc61-bc296d2cf9cd` | nodo/red |

(Lista completa y actualizada: `GET /api/internal/catalogs/projects`.)

## Errores comunes

| Código HTTP | `code` | Causa | Solución |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Body inválido (falta campo, tipo incorrecto) | Ver `details` en la respuesta |
| 404 | `CUSTOMER_NOT_FOUND` / `CONTRACT_NOT_FOUND` / etc. | FK inexistente | Verificar el id contra el catálogo correspondiente |
| 422 | `NETWORK_TASK_ADDRESS_REQUIRED` | Tarea de nodo sin `address` | Mandar `address` siempre en tareas `kind:"network"` |
| 422 | `MISSING_PROJECT_FOR_ICLASS` | `send-to-iclass` sobre una tarea sin `projectId` mapeado | Crear/actualizar la tarea con un `projectId` válido (ver catálogo `/projects`) |
| 422 | `ICLASS_TEAM_NOT_ASSIGNABLE` | `teamLogin` no existe o no está `selectable` | Verificar contra `GET /catalogs/teams` |
| 422 | `ICLASS_NO_SERVICE_ORDER` | Intentar asignar equipo sin que la OS exista todavía | No debería pasar usando `send-to-iclass` (ya lo orquesta) |

## Feature flags relevantes (prod)

`iclass-integration` y `iclass-assign-action` deben estar **ON** para que `send-to-iclass` funcione de punta a punta (si están OFF, la tarea igual se crea/mueve de stage, pero no se crea nada en IClass). Confirmado ON en prod al 2026-09-16.

## Nota sobre las pruebas de este documento

Las tareas `#6421` (dismissed), `#6422`, `#6423` y `#6424` de este documento son **datos reales de prueba** creados en producción, con Órdenes de Servicio reales en IClass asignadas a Andy Medina para 2026-09-17. Si todavía existen al leer esto, conviene cerrarlas/cancelarlas en IClass para que no aparezcan como visitas reales.
