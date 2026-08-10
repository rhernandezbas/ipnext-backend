# Design: ipnext-tecnicos — app propia de técnicos + módulo `/api/tech/*`

## Technical Approach

Réplica del patrón `/api/portal/*` (port → adapter JWT → middleware Bearer → router con deps opcionales → un mount point en `app.ts`), sobre el `RbacUser` existente con `aud=tech`. Cero backend nuevo. Los use cases de evidencia y materiales **delegan en los que ya existen** (`AttachPhotosToTask`, `RecordMaterialConsumption`) — la superficie nueva es autorización + scoping, no lógica de negocio.

La Wave 1a es un fix de deuda preexistente y va **primero**: hoy hay 3 escritores de `generalStatus='closed'` sin ningún lock. La app sería el 4°.

---

## Hallazgos que corrigen el proposal / el explore

| # | Afirmación previa | Realidad verificada | Impacto |
|---|---|---|---|
| C1 | La race es `MoveTaskToStage.ts:379-380` (staff mueve a `hecho` en el kanban → auto-cierra) vs ingest | **FALSO**. `MoveTaskToStage.ts` tiene 72 líneas y **nunca toca `generalStatus`**. La línea 379-380 es de `IngestClosedServiceOrders.ts`. Mover una tarjeta a `hecho` sólo setea `completedAt` (`PrismaSchedulingRepository.ts:389-397`) | La race existe, pero **entre otros actores**. Ver Decision 2 |
| C2 | "3 escritores" | Son **cuatro**: `SetTaskGeneralStatus.ts:34` (staff, endpoint dedicado), `IngestClosedServiceOrders.ts:380` (cron IClass), `CloseIClassServiceOrder.ts:101` (staff con push a IClass), y el genérico `UpdateTask` → `repo.updateTask({generalStatus})` | El guard debe cubrir los 4 + la app = 5 |
| C3 | "El mapa vivo lee ambos orígenes sin cambiar las queries" | **Parcialmente falso**. `GetTeamsLiveStatus.ts:59-68` itera el **roster de IClass** (`source.listTeams()`) y le hace join por `teamLogin`. Un punto de la app cuyo técnico no esté mapeado a cuadrilla **no se dibuja nunca** | Ver Decision 5: el union de roster es un cambio de lectura aditivo obligatorio |
| C4 | Los estados de campo pueden ir al workflow de stages | Colisión real: `iclass-intermediate-states` **ya auto-mueve stages** cuando IClass reporta DESLOCAMENTO/ANDAMENTO (`IngestClosedServiceOrders.ts:239-256`, forward-only) | Ver Decision 4: `fieldStatus` va en columna aparte |

Punto a favor no previsto: **todos los cierres pasan por `SchedulingRepository.updateTask`**. Hay un único chokepoint en el port → arreglar la clase es barato.

---

## Architecture Decisions

### Decision 1 — Port de token: `TechTokenService` propio, no parametrizar el del portal

| Opción | Tradeoff | Decisión |
|---|---|---|
| Parametrizar `PortalTokenService` con `audience` inyectable | Menos código, pero **el `aud` deja de ser una constante del tipo**: un wiring equivocado emite tokens `tech` desde el login del portal y la única separación panel↔móvil se vuelve un parámetro de runtime | ❌ |
| Port nuevo `TechTokenService` con claims propios | Duplica ~50 líneas triviales; a cambio `aud='tech'` es una constante del módulo y los claims difieren de verdad (`technicianId`, sin `clientId`) | ✅ |

```ts
// src/domain/ports/TechTokenService.ts
export interface TechAccessTokenClaims { technicianId: string }
export interface TechTokenService {
  signAccessToken(claims: TechAccessTokenClaims): string;
  verifyAccessToken(token: string): TechAccessTokenClaims | null; // null, nunca throw
}
```

Adapter `JwtTechTokenService`: TTL 15 min, `audience: 'tech'`, **`algorithms: ['HS256']` pineado** (calcado de `JwtPortalTokenService.ts:48`), mismo `JWT_SECRET` (lazy `require('../../config')` para no romper tests).

### Decision 2 — Cierre atómico: método NUEVO en el port, y los 5 escritores pasan por él

`updateTask` **no** se toca (lo usan ~30 call sites para campos que no son el cierre). Se agrega un método dedicado, molde exacto de `moveTaskToStageIfForward` (`SchedulingRepository.ts:90`), que ya devuelve `{moved: boolean}`:

```ts
// domain/ports/SchedulingRepository.ts
export type ClosureOrigin = 'app' | 'iclass' | 'staff';
export interface CloseTaskResult {
  /** true = ESTE escritor ganó la race y escribió. */
  closed: boolean;
  /** Estado tras la operación (el ganador previo si closed=false). */
  task: ScheduledTask | null;
  /** Sólo cuando closed=false: quién había cerrado antes y con qué resultado. */
  existingOrigin: ClosureOrigin | null;
  existingResultCode: string | null;
}
closeTaskIfOpen(id: string, input: {
  origin: ClosureOrigin;
  resultCode?: string | null;
  closedByUserId?: string | null;
}): Promise<CloseTaskResult>;
```

Implementación Prisma — **una sola sentencia atómica**, sin read-then-write:

```ts
// FIX-5: guard + relectura en UNA unidad de trabajo (una conexión, un commit).
const { count, row } = await prisma.$transaction(async (tx) => {
  const { count } = await tx.scheduledTask.updateMany({
    where: { id, generalStatus: { not: 'closed' } },   // ← el guard
    data: { generalStatus: 'closed', isClosed: true, closureOrigin: input.origin,
            closureResultCode: input.resultCode ?? null, closedAt: new Date(),
            closedByUserId: input.closedByUserId ?? null },
  });
  const row = await tx.scheduledTask.findUnique({ where: { id }, include: INCLUDE });
  return { count, row };
});
// count===1 → ganamos. count===0 → perdimos (o no existe): la relectura dice cuál.
```

Y la operación **inversa** (FIX-1): toda transición de `generalStatus` a un valor **distinto de `'closed'`** (`open`, `dismissed`, o la vía legacy `isClosed:false`) **limpia las cuatro columnas de cierre** a `null`. Vive en el único punto donde se traduce el update (`_buildUpdateData` en Prisma y su gemelo in-memory), no en un use case, así que la heredan todos los escritores. Sin esto, una tarea reabierta seguía anunciando quién la cerró y cuándo — violando el invariante del spec y dejando al chequeo de discrepancia comparando contra un ganador fantasma.

`updateMany` con el predicado en el `WHERE` toma el row lock de Postgres: el segundo escritor concurrente bloquea, reevalúa el predicado con el valor ya comiteado y matchea 0 filas. **First-writer-wins sin columna de versión.**

Ajuste de la fix wave (FIX-5): el `updateMany` **y la relectura** van dentro de **un `$transaction` interactivo**. El guard siempre fue atómico; el que no lo era es el REPORTE. Con dos round-trips sueltos (potencialmente dos conexiones del pool) el `UPDATE` comiteaba al instante y un tercer escritor podía reabrir + volver a cerrar la tarea antes de que aterrizara nuestra relectura: el método devolvía `closed: true` con el `closureOrigin`/`closedAt` **de otro**. La transacción fija ambas sentencias a una conexión y retiene hasta el commit el row lock que tomó el `UPDATE`, así que al ganar la relectura observa exactamente nuestra escritura. Se prefirió sobre `UPDATE ... RETURNING` vía `$queryRaw` porque RETURNING obligaría a escribir a mano la lista de columnas **y** los `INCLUDE` (stage / customer / contract / assignee / watchers / checklist) que `toTask` necesita, duplicando el mapeo. Residual documentado: al PERDER no hay lock nuestro que fijar (el `UPDATE` no matcheó fila), así que el ganador reportado sigue siendo una lectura READ COMMITTED — inherente e inocuo, es el ganador más reciente.

Qué hace cada escritor cuando pierde (`closed === false`):

| Escritor | Comportamiento al perder |
|---|---|
| `CloseTaskFromField` (app, nuevo) | **409 `TASK_ALREADY_CLOSED`** con `{closureOrigin, closedAt}` en el body — la app muestra "ya fue cerrada por IClass/oficina" y refresca. NO reintenta. El push a IClass no se ejecuta |
| ⚠️ `CloseTaskFromField` — **PRE-CHEQUEO OBLIGATORIO de `dismissed` (wave 1b)** | El predicado del guard es `generalStatus != 'closed'`, y eso **incluye `'dismissed'`** (decisión fijada en la wave 1a, ver FIX-8: cerrar a mano una descartada es legítimo para el staff, y los otros escritores ya filtran dismissed por su cuenta antes de llamar). Consecuencia directa para la app: si `CloseTaskFromField` invoca el guard sobre una tarea `dismissed`, **gana** — devuelve `closed:true`, cierra la tarea descartada y el 409 de esta tabla **no dispara nunca**. `CloseTaskFromField` DEBE bailar en `dismissed` **ANTES** de llamar a `closeTaskIfOpen`. El contrato está documentado en el docstring del port (`SchedulingRepository.closeTaskIfOpen`) y pineado en `closeTaskIfOpen.dismissed.test.ts` |
| `SetTaskGeneralStatus` (staff) | Mantiene el D8 actual: devuelve la tarea, sin evento. Si el `resultCode` difiere → discrepancia |
| `IngestClosedServiceOrders` | No-op silencioso (ya era su intención con el `task.generalStatus !== 'closed'`), + discrepancia |
| `CloseIClassServiceOrder` | Ya valida `generalStatus === 'open'` en el step 4 (`:70`); el guard atómico cierra la ventana entre ese check y el `:101` |
| `UpdateTask` (genérico) | Si el patch trae `generalStatus:'closed'` → se redirige a `closeTaskIfOpen(origin:'staff')`. Cualquier otro valor sigue por `updateTask` |

**Log de discrepancia** — un solo lugar, en el helper de aplicación que envuelve al método (no repetido en 5 use cases):

```
[task-closure-conflict] task=<id> winner=<origin>/<resultCode> loser=<origin>/<resultCode> at=<iso>
```

Además emite un `ScheduledTaskActivity` tipo `closure_conflict` (tabla append-only que ya existe) con `metadata: {winnerOrigin, winnerResultCode, loserOrigin, loserResultCode}` — así la discrepancia es **consultable**, no sólo un log que rota.

**Cuándo cuenta como discrepancia** (afinado en la fix wave, FIX-4 — `applyTaskClosure.isRealConflict`):

- El **perdedor sin `resultCode`** (`null`) **NO** es discrepancia: no aportó ningún resultado. Es el caso cotidiano del staff cerrando a mano (`SetTaskGeneralStatus` / `UpdateTask` siempre pasan `null`); reportarlo inundaba la auditoría de `loserResultCode: null`.
- Con **ambos `resultCode` no nulos**, la comparación es **normalizada** (`normalizeResultCode`), no byte a byte: IClass devuelve el mismo código con variaciones cosméticas (`"instalacion completa fibra."`), y el resolver del propio ingest ya normaliza — comparar más estricto acá sería contradecirlo.
- Con la **tarea inexistente** (`task: null`) no hay ni log ni activity: `existingResultCode` es null por ausencia de fila, no por un ganador sin resultado.
- El **perdedor con código sobre un ganador sin código** SÍ es discrepancia (divergencia real).
- **Una sola vez por OS**: el ingest reporta la discrepancia únicamente en la **primera** transición de la OS a cerrada (discriminador: la existencia previa del espejo `IClassServiceOrder`, que sólo se escribe después del guard de estado terminal). Los bumps de `iclassUpdatedAt` sobre una OS ya cerrada re-ejecutan el cierre (idempotente) pero **no** re-reportan.

`closureOrigin` se modela como **`String?` nullable, SIN default a nivel de schema** (`closureOrigin String?` en `schema.prisma`), no enum de Prisma: el repo usa `String` para todo catálogo que pueda crecer (`generalStatus`, `priority`, `category`) y reserva los enums para binarios estructurales (`TicketCommentVisibility`, ver el comentario en `schema.prisma:1652-1663`). Aquí un cuarto origen (p.ej. `'gr'`) es plausible. El tipo cerrado vive en TypeScript (`ClosureOrigin`), que es donde el compilador lo puede exigir.

> Corrección de la fix wave (FIX-9a): una versión anterior de este documento decía "`String` con **default `'staff'`**". Es **incorrecto y sería dañino**: un default a nivel de columna le pondría `'staff'` a toda tarea insertada, incluidas las abiertas, violando el invariante del spec (`closureOrigin` es null salvo `generalStatus === 'closed'`) y falseando el origen de las que cierre el cron. La columna es nullable, sin default, y la escribe únicamente `closeTaskIfOpen`. Las tareas cerradas ANTES de la migración quedan en `null` — sin backfill, tal como estaba decidido (rellenar con un origen inventado falsearía la auditoría).

### Decision 3 — Middleware: `req.technicianId` como única fuente de scoping

`createTechAuthMiddleware(tokenService, rbacUsers, permissions)` — molde literal de `portalAuthMiddleware.ts`:
1. Bearer only (sin cookies).
2. `verifyAccessToken` → `null` = 401 (rechaza un JWT de staff, que no lleva `aud`).
3. **Re-chequea el `RbacUser` en CADA request**: `status === 'active'` y `lockedUntil` vencido → si no, 401.
4. **Doble capa**: re-chequea el permiso RBAC `tech.app_access` en cada request → **401** si lo perdió (no 403: el 401 dispara el flujo de auto-logout que la app clona del skeleton — un 403 dejaría la sesión viva con todo fallando; mismo criterio que el re-chequeo de status del portal). Revocar el permiso desde el panel corta la app **sin esperar** a que expire el token.
5. Setea `req.technicianId = user.id`. Ningún handler `/api/tech/*` lee identidad de body/query.

Guard cruzado (`JWT_SECRET` compartido — el `aud` es la única separación):

| Dirección | Dónde | Cambio |
|---|---|---|
| token `tech` → ruta admin | `JwtAuthAdapter.getSession()` (`:111`) | `if (payload.aud === 'portal' \|\| payload.aud === 'tech') throw` |
| token staff/portal → `/api/tech/*` | `JwtTechTokenService.verifyAccessToken` | `{audience:'tech'}` ya lo rechaza (un token sin `aud` falla el check) |
| token `tech` → `/api/portal/*` | `JwtPortalTokenService` | `{audience:'portal'}` ya lo rechaza |

Mejor aún: reemplazar el `if` encadenado por un **allowlist invertido** — `if (payload.aud !== undefined) throw`. Los tokens de staff **nunca** llevan `aud` (`JwtAuthAdapter` no lo firma), así que cualquier audiencia presente es de otro universo. Esto cierra la clase entera: la próxima audiencia (`aud='partner'`) queda rechazada sin tocar este archivo. **Se elige esta.**

### Decision 4 — Estados de campo: columna `fieldStatus` propia, NO stages

| Opción | Tradeoff | Decisión |
|---|---|---|
| Stages nuevos "En camino"/"En sitio" | Los stages son **configurables por workflow** (el operador los renombra/borra) y `iclass-intermediate-states` ya auto-mueve stages desde DESLOCAMENTO/ANDAMENTO forward-only. Con IClass despachando en paralelo, la app y el cron se pelearían el `stageId` de la misma tarea | ❌ |
| `fieldStatus` en columna aparte + timestamps | Ortogonal al workflow configurable y a `generalStatus`. La lectura del portal ("tu técnico va en camino") sale de un campo estable, no de un nombre de stage que alguien puede renombrar | ✅ |

```
fieldStatus       String?    // null | 'traveling' | 'on_site'  (null = no arrancó)
travelStartedAt   DateTime?
arrivedAt         DateTime?
```

Transiciones válidas (`StartTaskTravel`, `ArriveAtTask`): `null → traveling → on_site`. Idempotentes (repetir la actual = no-op 200, no re-sella el timestamp — misma semántica que el `retriedAt` sellado ANTES del push del guest wifi). No hay vuelta atrás en v1; el cierre no borra `fieldStatus` (es evidencia del recorrido). Ambas transiciones exigen `assigneeId === req.technicianId`.

Alimenta el "en camino" del portal (change aparte): `mapTaskStageToPortalStatus` gana `fieldStatus` como entrada con precedencia sobre el stage, sin tocar el mapeo existente.

### Decision 5 — GPS: `teamLogin` siempre poblado + union de roster en la lectura

El unique natural `(teamLogin, recordedAt, latitude, longitude)` (`schema.prisma:4309`) **da idempotencia gratis** a los breadcrumbs de la app: reenviar un batch por timeout no duplica. Para no romperlo, `teamLogin` sigue **NOT NULL**; el ingest lo resuelve así:

```
teamLogin = rbacUser.iclassTeamLogin ?? `tech:${rbacUser.id}`
```

El fallback sintético existe para que **un técnico sin mapeo a cuadrilla no pierda su rastro** (perder el dato es peor que un login feo). Pero por C3 el mapa vivo es roster-driven, así que `GetTeamsLiveStatus` gana un paso aditivo: al roster de IClass se le **unen** los `teamLogin` que tengan puntos `source='app'` y no estén en el roster, marcados con `name` derivado del `RbacUser`. Sin esto la feature queda **inerte** para justo los técnicos que sólo usan la app propia — exactamente el modo de falla "feature sin perilla".

Batch de breadcrumbs:

```
POST /api/tech/location
{ "points": [ { "recordedAt": "2026-08-10T14:03:11.000Z",   // ISO 8601 UTC, obligatorio
                "latitude": -34.65, "longitude": -59.43,
                "accuracyM": 12.4 } ] }                      // nullable a propósito
→ 200 { "accepted": 47, "duplicates": 3, "dropped": 1 }
```

- Máx **200 puntos** por request. Se reusa `TeamLocationRepository.saveMany`, que ya deduplica y devuelve `{inserted, duplicates}`.
- Validación por punto, **drop individual** (nunca 400 del batch entero): lat/lng en rango, `recordedAt` no futuro (>5 min de skew) ni anterior a 7 días. Un punto malo no puede tirar el rastro de la jornada.
- `sources: []` para el origen app (el array es la lista de `origem` de IClass; vacío = no aplica). El discriminador es `source`, no `sources` — nombres peligrosamente parecidos, **documentar en el schema**.
- Retención: la purga existente (`purgeOlderThan`, 12 meses) ya cubre ambos orígenes sin cambios. La ventaja propia es real: IClass retiene ~30 días.

### Decision 6 — Evidencia: delegación en `AttachPhotosToTask`, cero adapter nuevo

`AttachClosureEvidence` es un **wrapper de autorización**: valida `assigneeId === req.technicianId` + tarea no cerrada, y delega en el `AttachPhotosToTask` ya wireado (que valida mimetype, 0 bytes, cupo 15, genera thumbnail y hace rollback de las keys si falla). Bucket: el mismo de MinIO; prefijo **`tasks/{taskId}/{uuid}.{ext}`** ya existente (`AttachPhotosToTask.ts:136`) — **no** se inventa un prefijo `tech/`: la evidencia es de la tarea, y meterla en otro prefijo la escondería de la galería que el staff ya usa. La firma se sube como un PNG más, distinguida por `filename` (`signature.png`); no hay modelo nuevo. Multipart: `createTechEvidenceUploadMiddleware` clonando `ticketMessageUpload.ts` (precheck de `Content-Length` + `createBoundedBatchStorage`, ambas líneas de defensa). Sin `MINIO_*` → 503 `STORAGE_NOT_CONFIGURED`, contrato ya establecido.

### Decision 7 — Materiales: `DeclareMaterialConsumption` delega en `RecordMaterialConsumption`

Éste ya recibe el hook opcional de staging y dispara `StageMaterialDeduction` (`RecordMaterialConsumption.ts:24-27`), que resuelve la ubicación TECNICO y marca `needs_review` si no alcanza el stock. El use case nuevo sólo fija `recordedByUserId = req.technicianId` (nunca del body) y valida la asignación. **Cero lógica de inventario nueva.**

---

## Data Flow

Cierre concurrente (el corazón de la Wave 1a):

```
  App (tech)          Cron IClass         Staff (panel)
      │                    │                    │
 CloseTaskFromField  IngestClosedSO      SetTaskGeneralStatus
      │                    │                    │
      └────────────┬───────┴────────────────────┘
                   ▼
          closeTaskIfOpen(id, {origin, resultCode})
                   │
          UPDATE ... WHERE generalStatus != 'closed'   ← row lock
                   │
        ┌──────────┴───────────┐
     count=1                count=0
   (ganó, escribe)      (perdió, no pisa)
        │                      │
   activity                activity 'closure_conflict'
   'status_changed'        (sólo si resultCode difiere)
```

GPS dual-source:

```
IClass API ──► IngestTeamLocations ──┐
                                     ├─► TeamLocationPoint ──► GetTeamsLiveStatus
App (expo-task-manager) ─────────────┘   (source, technicianId)   (roster ∪ app logins)
  POST /api/tech/location                                    └──► GetTeamDailyJourney
                                                             └──► AuditServiceOrderPresence
```

---

## File Changes

| Archivo | Acción | Descripción |
|---|---|---|
| `src/domain/ports/TechTokenService.ts` | Create | Port de firma/verificación `aud=tech` |
| `src/domain/ports/SchedulingRepository.ts` | Modify | `closeTaskIfOpen` + tipos `ClosureOrigin`/`CloseTaskResult` |
| `src/infrastructure/adapters/jwt/JwtTechTokenService.ts` | Create | HS256 pineado, TTL 15 min |
| `src/infrastructure/adapters/jwt/JwtAuthAdapter.ts` | Modify | `getSession`: rechazar **cualquier** `aud` presente |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modify | `closeTaskIfOpen` vía `updateMany` condicional |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modify | `closeTaskIfOpen` + hook de concurrencia para tests |
| `src/infrastructure/http/middleware/techAuthMiddleware.ts` | Create | Bearer + status + `tech.app_access` + `req.technicianId` |
| `src/infrastructure/http/routes/tech.routes.ts` | Create | Superficie `/api/tech/*`, deps opcionales |
| `src/infrastructure/http/routes/techEvidenceUpload.ts` | Create | Multipart acotado (molde `ticketMessageUpload.ts`) |
| `src/infrastructure/http/app.ts` | Modify | **UN** bloque de mount, al final del wiring |
| `src/types/express.d.ts` | Modify | `req.technicianId?: string` con el docblock anti-IDOR |
| `src/domain/entities/rbac.ts` | Modify | Módulo `tech` + acciones `app_access`, `task_close` |
| `src/application/use-cases/tech/*.ts` | Create | 9 use cases (abajo) |
| `src/application/use-cases/{SetTaskGeneralStatus,IngestClosedServiceOrders,CloseIClassServiceOrder,UpdateTask}.ts` | Modify | Ruteados por `closeTaskIfOpen` |
| `src/application/use-cases/GetTeamsLiveStatus.ts` | Modify | Union roster IClass ∪ logins con puntos `source='app'` |
| `src/__tests__/app-composition.tech.test.ts` | Create | Pin estático del wiring (molde `app-composition.technicianLocation.test.ts`) |

Use cases (`src/application/use-cases/tech/`), uno por archivo: `LoginTechnician`, `RefreshTechnicianSession`, `LogoutTechnician`, `GetTechnicianMe`, `ListTechnicianDayTasks`, `GetTechnicianTaskDetail`, `StartTaskTravel`, `ArriveAtTask`, `CloseTaskFromField`, `IngestTechnicianBreadcrumbs`, `AttachClosureEvidence`, `DeclareMaterialConsumption`.

---

## Migraciones (todas aditivas, con default)

| Wave | Modelo | Columna | Tipo / default |
|---|---|---|---|
| 1a | `ScheduledTask` | `closureOrigin` | `String?` — null en las históricas (**origen desconocido ≠ `'staff'`**: rellenar con un origen inventado falsea la auditoría) |
| 1a | `ScheduledTask` | `closureResultCode` | `String?` |
| 1a | `ScheduledTask` | `closedAt` | `DateTime?` (distinto de `completedAt`, que es del stage `hecho`) |
| 1a | `ScheduledTask` | `closedByUserId` | `String?` + FK `RbacUser` `onDelete: SetNull` |
| 1b | `ScheduledTask` | `fieldStatus`, `travelStartedAt`, `arrivedAt` | `String?`, `DateTime?`, `DateTime?` |
| 1b | — | índice | `@@index([assigneeId, startDate])` — la query de la lista del día |
| 2a | `TeamLocationPoint` | `source` | `String @default("iclass")` — **backfill implícito por el default**, las filas existentes quedan correctas |
| 2a | `TeamLocationPoint` | `technicianId` | `String?` + FK `RbacUser` `onDelete: SetNull` |
| 2a | — | índice | `@@index([source, recordedAt])` |
| 4 | — | — | Ninguna (reusa `TaskMaterialConsumption`) |
| 3 | — | — | Ninguna (reusa `ScheduledTaskAttachment`) |

Todas por `prisma migrate diff`. El seed del catálogo RBAC (módulo `tech`) va como migración idempotente `ON CONFLICT DO NOTHING`.

---

## Testing Strategy

| Wave | Qué | Cómo |
|---|---|---|
| 1a | **Concurrencia del guard** | `InMemorySchedulingRepository.closeTaskIfOpen` con hook `beforeWrite` para intercalar un segundo cierre: `Promise.all([closeApp, closeIclass])` → exactamente un `closed:true`, un `closed:false` con `existingOrigin` correcto |
| 1a | Los 5 escritores usan el guard | Test estático sobre el fuente: ningún archivo fuera del repo Prisma contiene `generalStatus: 'closed'` en un `updateTask`. **Filtrar comentarios antes de matchear** |
| 1a | Discrepancia | resultCodes distintos → activity `closure_conflict`; **mismo** resultCode → NO la emite |
| 1a | Revert-probe | Revertir `closeTaskIfOpen` a `updateTask` debe poner el test de concurrencia en **rojo**. Si pasa igual, el test no prueba nada |
| 1b | Guard cruzado (bidireccional) | Token `aud=tech` contra `/api/admin/*` → 401; token de staff (sin `aud`) contra `/api/tech/*` → 401; token `portal` contra `/api/tech/*` → 401. **Assert de PRESENCIA primero** (que la ruta responda 200 con el token correcto) antes de assertear el rechazo — si no, el probe da verde contra una ruta inexistente |
| 1b | Anti-IDOR | Tarea de OTRO técnico por id directo → 404 (no 403: no filtrar existencia). `assigneeId` del body ignorado |
| 1b | Doble capa | Usuario `active` sin `tech.app_access` → 401 en el middleware, aunque el token sea válido |
| 1b | Composition-root | `app-composition.tech.test.ts`: mount exactamente una vez, repos Prisma reales (no in-memory), `techAuthMiddleware` aplicado a todo salvo `/auth/login` |
| 2a | Dual-source | Repo in-memory con puntos `iclass` + `app`; live map devuelve **ambos**, incluido un `tech:{id}` sintético fuera del roster |
| 2b | Idempotencia | Reenviar el mismo batch → `accepted:0, duplicates:N`. Punto futuro/fuera de rango → `dropped`, el resto se acepta |
| 3 | Evidencia | Multipart con supertest; sin MinIO → 503; tarea ajena → 404 |
| 4 | Materiales | `recordedByUserId` sale del token aunque el body mande otro |

In-memory nuevos: ninguna clase nueva — se extienden `InMemorySchedulingRepository` (`closeTaskIfOpen`) e `InMemoryTeamLocationRepository` (`source`/`technicianId`). Un `InMemoryRbacUserRepository` sólo si el existente no expone `findById` con `status`.

---

## App mobile — diseño de alto nivel

**Se clona de `ipnext-customer-app`**: `src/lib/api.ts` completo (`apiRequest` con `AbortController` + timeout 15 s, `ApiError` tipado con `kind`/`code`/`status`, `KIND_BY_CODE` extensible, `apiRequestMultipart` con timeout propio de 300 s, `resolveBaseUrl()` por `EXPO_PUBLIC_API_URL`), el refresh-on-401 single-flight de `(auth)/session.tsx`, `query-client.ts`, y el design-system.

```
src/
├── app/            (auth)/login · (tabs)/agenda|tarea/[id]|perfil
├── features/       tasks/ · location/ · evidence/ · materials/
├── lib/            api.ts (clonado) · types.ts (contrato /api/tech/*) · location-task.ts
├── hooks/
└── components/ui/
```

Background location:
- `expo-location` + `expo-task-manager`, `startLocationUpdatesAsync` con `accuracy: Balanced`, `timeInterval: 5 min`, `distanceInterval: 100 m`, `deferredUpdatesInterval` para batchear. ~1 punto cada 5-10 min = paridad con el rastro de IClass, sin quemar batería.
- **Batching offline**: los fixes se acumulan en `AsyncStorage` y se drenan al `POST /api/tech/location` (máx 200) cuando hay red. Esto **no** es el offline-first que el proposal deja fuera de scope: es una cola de un solo endpoint idempotente, que el unique natural vuelve segura ante reenvíos.
- **Corte fuera de jornada**: `stopLocationUpdatesAsync` al cerrar sesión y al cerrar la última tarea del día. Trackear a un técnico fuera de horario es un problema legal, no sólo de batería.
- Android: `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` (+ `FOREGROUND_SERVICE_LOCATION`, con notificación persistente visible — requisito de Android 14). Play Console: el permiso de background es **sensible** y exige declaración de uso prominente + video demostrativo. Justificación: verificación de presencia en domicilio del cliente para órdenes de servicio, con consentimiento laboral. La cuenta org ya publicó *Mi IPNEXT*, así que el flujo de revisión es conocido — pero el permiso de background **no** lo tenía esa app: presupuestar una ronda de revisión extra.
- **PRIMERA tarea del Wave 2b, bloqueante**: `npx expo install expo-location expo-task-manager` sobre el skeleton SDK 57 (`expo ~57.0.9`, RN 0.86.2) + build de desarrollo que arranque el task manager. Si falla, el Wave 2 se replantea (fallback: foreground-only mientras la app está abierta en la tarea) **sin arrastrar** a las Waves 1/3/4.

---

## Riesgos y respuesta de diseño

| Riesgo | Respuesta de diseño |
|---|---|
| Race de cierre (4°/5° escritor) | `closeTaskIfOpen` como **único** camino de cierre; test de concurrencia + revert-probe + test estático que prohíbe el path viejo |
| Contrato congelado con apps instaladas | Errores tipados con `code` estable; sólo aditivo; el contrato campo por campo vive en la delta spec de cada wave marcada "contrato compartido" |
| `expo-location` en SDK 57 no confirmado | Verificación bloqueante como primera tarea del 2b; fallback foreground-only acotado a esa wave |
| Background location / Play Console | Notificación persistente, muestreo adaptativo, corte fuera de jornada; el permiso **no** bloquea las Waves 1/3/4 |
| `JWT_SECRET` compartido | Allowlist invertido (`aud !== undefined` → rechazo) en `JwtAuthAdapter` — cierra la clase, no la instancia. Test bidireccional |
| Colisión de merge en `app.ts` (God Object, 3326 líneas) | Un solo bloque al final + composition-root test que pina el resultado |
| Técnico sin mapeo a cuadrilla → GPS invisible | `teamLogin` sintético `tech:{id}` + union de roster en `GetTeamsLiveStatus` (Decision 5) |
| Un `resultCode` de la app que IClass no conoce | El cierre local gana igual (first-writer-wins); el push a IClass es best-effort y su fallo queda en `IClassDispatchAttempt`, no revierte el cierre |

## Open Questions

- [ ] TTL del refresh token de la app: el portal usa rotación con detección de reuso. ¿Se clona tal cual (tabla `TechRefreshToken`) o el técnico re-loguea cada 15 min? **Recomendación**: clonar la rotación del portal — un técnico re-logueándose con guantes en un techo es inaceptable.
- [ ] ¿`tech.task_close` se exige además de `tech.app_access`, o basta con la asignación de la tarea? El proposal pide ambos permisos; el diseño los soporta, falta confirmar si algún técnico piloto debe entrar **sin** poder cerrar.
- [ ] Retención propia del GPS: se hereda la purga de 12 meses. ¿El rastro de la app propia merece una ventana distinta (más larga, ahora que el dato es nuestro)?
