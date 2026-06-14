# Design — IClass OS Actions (Fases 2 + 3)

> Change: `iclass-os-actions`
> Lee: `proposal.md`. Construye sobre Fase 1 (`iclass-status-sync`).

## 1. Estructura: un change, dos olas

Un único change, implementación en **dos olas dependientes**:

- **Ola A (Fase 2 — Cierre).** Métodos `getServiceOrder` + `closeServiceOrder` en port/adapter, use case `CloseIClassServiceOrder`, ruta, flag `iclass-close-action`, permiso `scheduling.iclass_close`, UI de cierre. **No requiere tabla nueva.** Valida end-to-end el patrón escritura→IClass + flag + prueba-en-vivo.
- **Ola B (Fase 3 — Asignación).** Catálogo `IClassTeam` (tabla + entity + port + adapters + sync), métodos `listTeams` + `updateServiceOrder`, use case `AssignIClassTeam`, rutas, flag `iclass-assign-action`, permiso `scheduling.iclass_assign`, UI de selección de cuadrilla.

**Por qué olas y no dos changes:** ambos comparten el mismo contrato de port, el mismo patrón de error y la misma estrategia de pre-check/flag. Separarlos en changes duplicaría specs. Pero la Ola A debe estar **validada en vivo** (flag flippeado tras prueba real) antes de exponer la Ola B, porque comparten el riesgo de "escritura no probada" — validar una acción reduce la incertidumbre de la otra.

## 2. Decisiones de arquitectura (AD)

### AD-1 — Pre-check híbrido (cache local + IClass en vivo)
El cierre y la asignación corren un pre-check de dos niveles:
1. **Barato (cache local, `getTask`)**: `task.iclassOrderCode != null` (la OS existe) y `task.generalStatus === 'open'`. Si falla → 422 sin tocar IClass.
2. **En vivo (`getServiceOrder`)**: confirma que la OS NO está en estado terminal (`statusCode !== '7'`) ANTES de cerrar/asignar.

**Por qué en vivo y no el cache `iclassStatusCode`:** la Fase 1 captura el estado con hasta 10 min de lag (scheduler). El cierre es **destructivo del lado IClass**; no podemos cerrar a ciegas sobre un estado potencialmente viejo. El costo (1 GET extra por acción manual, no por tick) es aceptable. La asignación reusa el MISMO pre-check por consistencia (no querés asignar cuadrilla a una OS ya cerrada).

### AD-2 — Adapter "dumb transport" (igual que createServiceOrder)
El `IClassClient` NO resuelve catálogos ni reglas de negocio. El use case resuelve el `resultCode` (del catálogo `IClassResultCode`), el `requiredTeam` (del catálogo `IClassTeam`) y la `closeDate`, y se los pasa al adapter ya resueltos. El adapter solo arma el payload IClass, llama, y mapea la respuesta. (Mismo principio que `createServiceOrder` con `soType`.)

### AD-3 — Feature flag como segundo cerrojo de runtime
El permiso (`iclass_close`/`iclass_assign`) decide QUIÉN puede; el flag (`iclass-close-action`/`iclass-assign-action`, default OFF) decide SI la acción está habilitada globalmente. El use case consulta el `FeatureFlagRepository` (ya inyectado en otros use cases IClass) y, si el flag está OFF, lanza un error de dominio `IClassActionDisabledError` → 409. Permite habilitar masivamente con un toggle (página de feature-flags existente) tras la prueba en vivo, sin redeploy.

### AD-4 — Mapeo de errores con detalle visible (riesgo escritura-no-probada)
Toda respuesta de IClass se traduce a errores de dominio existentes:
- IClass responde con `erros` (business rejection) → `IClassRejectedError(detail)` → **422 + `reason`** (el `domainErrorToCode` ya surface `reason`).
- 5xx / timeout / 401 persistente → `IClassUnavailableError` → **502**.
- El adapter NUNCA deja pasar un axios crudo cross-layer (REQ-OS-4 existente).

Como el shape real de `close`/`update`/`teams` es incierto, los parsers son **defensivos** (`?? null`, lectura tolerante de claves pt/en como en `parseServiceOrderSummary`) y cualquier "no encontré el código de éxito esperado" cae en `IClassUnavailableError` con mensaje explícito — nunca un success silencioso.

### AD-5 — `getServiceOrder` reusa `parseServiceOrderSummary`
`GET /serviceorders/{id}` y el listado comparten el shape de OS (ya documentado en el comentario de `parseServiceOrderSummary`). El nuevo método pasa la respuesta por el MISMO parser → devuelve un `ClosedServiceOrderSummary` (renombre conceptual: es "ServiceOrderSummary", el estado puede no ser terminal). Reuso, no duplicación.

### AD-6 — Idempotencia del cierre
- El pre-check en vivo (OS no terminal) es la primera barrera.
- Tras un cierre exitoso, el use case marca la tarea (`generalStatus`) según el mapeo result-code→stage si existe, o deja que el scheduler de cierre la reconcilie en el próximo tick (ya idempotente por `iclassUpdatedAt`). **No duplicamos la lógica de transición de stage**: el cierre manual SOLO empuja a IClass + setea `generalStatus='closed'` con el guard existente; el mirror/stage lo arma el `IngestClosedServiceOrders` que ya corre. Esto evita divergencia de result-code.
- Si dos `/close` concurrentes llegan (operador + scheduler), el guard `generalStatus !== 'closed'` corta el segundo.

### AD-7 — Catálogo `IClassTeam`, clon de `IClassNode`
Misma forma: `id` (uuid), clave estable de IClass como UNIQUE (`teamLogin`), `name`, `thirdPartyCode`, `active`, `selectable`, `lastSyncedAt`, timestamps. Sync por `upsertByLogin` + `markInactiveExcept`. `GET /teams` requiere al menos un filtro (`thirdPartyCode` o `statuses`) → el sync usa el `thirdPartyId` ya configurado. Agrupadores no-seleccionables si IClass los devuelve (igual que los 3 grouping nodes).

### AD-8 — Rutas de acción en `scheduling.routes.ts`
Las acciones operan sobre una tarea (`/:id`), así que viven en `scheduling.routes.ts`, montadas **ANTES del catch-all `/:id`** (gotcha conocido, ver resend). El catálogo de teams (admin) va en un router propio montado en `/api/admin/iclass` (clon de `iclassStatuses.routes.ts`). Inyectadas vía un `resendDeps`-style bag para no inflar más la firma del router.

## 3. Contrato del IClassPort (nuevos métodos)

```ts
// Pre-check + acción de cierre (Ola A)
getServiceOrder(iclassId: string): Promise<ServiceOrderSnapshot | null>; // null si 404
closeServiceOrder(input: CloseServiceOrderInput): Promise<void>;

// Asignación (Ola B)
listTeams(): Promise<IClassTeamDescriptor[]>;
updateServiceOrder(input: UpdateServiceOrderInput): Promise<void>;
```

```ts
interface CloseServiceOrderInput {
  serviceOrderCode: string;   // = task.iclassOrderCode
  resultCode: string;         // del catálogo IClassResultCode (resuelto por el use case)
  closeDate: Date;            // formateado por el adapter
  commentary: string;
  visibleToCustomer?: boolean; // default true
}

interface UpdateServiceOrderInput {
  serviceOrderCode: string;
  requiredTeam: string;       // teamLogin del catálogo IClassTeam
}

interface IClassTeamDescriptor {
  login: string;              // clave estable (UNIQUE)
  name: string;
  thirdPartyCode: string | null;
}

// ServiceOrderSnapshot: reuso de ClosedServiceOrderSummary (AD-5) — al menos
// { iclassId, iclassCodigo, statusCode, statusDescription }.
```

## 4. Modelo de datos

### Tabla nueva `IClassTeam` (Ola B)
```prisma
model IClassTeam {
  id             String   @id @default(uuid())
  login          String   @unique   // IClass team login — clave estable de upsert
  name           String
  thirdPartyCode String?
  active         Boolean  @default(true)
  selectable     Boolean  @default(true)
  lastSyncedAt   DateTime
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([active])
}
```

### Migración (aditiva, idempotente, sin BEGIN/COMMIT)
`prisma/migrations/20260725000000_iclass_team_catalog/migration.sql`:
- `CREATE TABLE IF NOT EXISTS "IClassTeam" (...)` + `CREATE UNIQUE INDEX ... login` + `CREATE INDEX ... active`.

> El estándar de migraciones manda aditivas, idempotentes, **sin BEGIN/COMMIT**. (El precedente `iclass_status_catalog` ya lo hace así; el precedente RBAC con BEGIN/COMMIT es la excepción a NO seguir.)

### Seed (permisos + flags) — `prisma/migrations/20260726000000_iclass_actions_rbac_and_flags/migration.sql`
- Permisos `scheduling.iclass_close` y `scheduling.iclass_assign` (idempotente, `ON CONFLICT DO NOTHING`), grant SOLO a `super_admin` (mismo patrón que `iclass_manual_resend`). El operador asigna a otros roles vía la UI de roles.
- Flags `iclass-close-action` y `iclass-assign-action` (`featureFlag.upsert`, **default false**).

> Sin BEGIN/COMMIT, todo idempotente (`ON CONFLICT`, `upsert`). Timestamps posteriores a `20260724000000`.

## 5. Use cases

### `CloseIClassServiceOrder` (Ola A)
Deps (ports): `SchedulingRepository`, `IClassPort`, `IClassResultCodeRepository`, `FeatureFlagRepository`, `TaskActivityRecorder?`.
```
execute({ taskId, resultCode, commentary, closeDate?, actorId }):
  1. flag iclass-close-action enabled? no → IClassActionDisabledError (409)
  2. task = getTask(taskId); no → TaskNotFoundError (404)
  3. task.iclassOrderCode? no → IClassNoServiceOrderError (422)
  4. task.generalStatus === 'open'? no → IClassTaskNotOpenError (409)
  5. resultCode existe en catálogo? no → IClassResultCodeNotFoundError (404)
  6. snapshot = iclass.getServiceOrder(orderCode)
     - null → IClassNoServiceOrderError (422)  // IClass no la conoce
     - statusCode === '7' → IClassAlreadyClosedError (409)  // ya cerrada (técnico en campo)
  7. iclass.closeServiceOrder({ serviceOrderCode, resultCode, closeDate ?? now, commentary })
     - IClassRejectedError → 422 (reason visible)
     - IClassUnavailableError → 502
  8. setear generalStatus='closed' (guard !== 'closed') + record 'status_changed' (actor)
  9. devolver task DTO actualizado
```

### `AssignIClassTeam` (Ola B)
Deps: `SchedulingRepository`, `IClassPort`, `IClassTeamRepository`, `FeatureFlagRepository`, `TaskActivityRecorder?`.
```
execute({ taskId, teamLogin, actorId }):
  1. flag iclass-assign-action enabled? no → IClassActionDisabledError (409)
  2. task = getTask; checks orderCode + generalStatus==='open' (mismo que cierre)
  3. team = teamRepo.getByLogin(teamLogin); no/inactive/!selectable → IClassTeamNotAssignableError (422)
  4. snapshot = getServiceOrder; terminal → IClassAlreadyClosedError (409)
  5. iclass.updateServiceOrder({ serviceOrderCode, requiredTeam: team.login })
  6. record activity 'iclass_team_assigned' (actor, toValue=login)
  7. devolver task DTO
```

### `SyncIClassTeams` + `ListIClassTeams` (Ola B) — clones de `SyncIClassNodes`/`ListIClassNodes`.

## 6. Errores de dominio nuevos (`src/domain/errors/iclass.ts`)

| Clase | code | HTTP |
|---|---|---|
| `IClassActionDisabledError` | `ICLASS_ACTION_DISABLED` | 409 |
| `IClassTaskNotOpenError` | `ICLASS_TASK_NOT_OPEN` | 409 |
| `IClassAlreadyClosedError` | `ICLASS_ALREADY_CLOSED` | 409 |
| `IClassNoServiceOrderError` | `ICLASS_NO_SERVICE_ORDER` | 422 |
| `IClassTeamNotAssignableError` | `ICLASS_TEAM_NOT_ASSIGNABLE` | 422 |

Reusados: `IClassResultCodeNotFoundError` (404), `IClassRejectedError` (422 + reason), `IClassUnavailableError` (502), `TaskNotFoundError` (404). Agregar los 5 códigos nuevos al `statusMap` del `errorHandler`.

## 7. Contrato BE↔FE (DTOs + endpoints)

### Endpoints nuevos
| Método | Ruta | Gate (perm) | Flag | Body | Resp |
|---|---|---|---|---|---|
| POST | `/api/scheduling/:id/iclass/close` | `scheduling.iclass_close` | `iclass-close-action` | `{ resultCode, commentary, closeDate? }` | task DTO (200) |
| POST | `/api/scheduling/:id/iclass/assign-team` | `scheduling.iclass_assign` | `iclass-assign-action` | `{ teamLogin }` | task DTO (200) |
| GET | `/api/admin/iclass/teams` | `iclass.read` | — | — | `{ items: TeamDTO[] }` |
| POST | `/api/admin/iclass/teams/sync` | `iclass.manage` | — | — | `SyncResult` |

### DTOs (whitelist)
- `CloseActionSchema = z.object({ resultCode: z.string().min(1), commentary: z.string().min(1), closeDate: z.string().datetime().optional() })`
- `AssignTeamSchema = z.object({ teamLogin: z.string().min(1) })`
- `IClassTeamDTO = { login, name, thirdPartyCode, active, selectable, lastSyncedAt }` (clon de node DTO).
- Errores devuelven `{ error, code, reason? }` — el FE muestra `reason` (detail de IClass) en el toast/modal.

### UI (FE, vitest)
- Detalle de tarea: si `iclassOrderCode != null` && `generalStatus === 'open'` → botón "Cerrar/Validar OS" (modal: select result-code, textarea comentario, date) y selector de cuadrilla (dropdown de `GET /teams` `selectable && active`). Botones ocultos/disabled por permiso Y por flag (el FE lee el estado del flag o degrada por el 409).
- Página admin de teams: clon de la de status (`GET/POST sync`), gate `iclass.read`/`iclass.manage`.

## 8. Wiring (`app.ts`) — God Object, a mano + composition-root test
- Construir `CloseIClassServiceOrder`, `AssignIClassTeam`, `SyncIClassTeams`, `ListIClassTeams` con `buildIClassClient()`, `schedulingRepo`, `iclassResultCodeRepo`, nuevo `PrismaIClassTeamRepository`, `featureFlagRepo`, `taskActivityRecorder`.
- Inyectar las 2 acciones a `createSchedulingRouter` vía el bag de deps IClass (extender `resendDeps` o agregar `iclassActionDeps`).
- Montar el router de teams en `/api/admin/iclass` (clon del status router).
- El composition-root test verifica que la app levanta con todo wireado (sin romper el contrato existente).

## 9. Matriz scenario → test (STRICT TDD: red → green → refactor)

> Use cases con adapters **in-memory** (`InMemoryIClassClient`, `InMemory*Repository`). Rutas con **supertest** + repos in-memory. FE con **vitest**. NUNCA mockear Prisma.

### Adapter `IClassClient` (`IClassClient.test.ts`, http inyectado)
| # | Scenario | Espera |
|---|---|---|
| A1 | `getServiceOrder` 200 → parsea snapshot (statusCode/descricao) | snapshot mapeado |
| A2 | `getServiceOrder` 404/204 | `null` |
| A3 | `closeServiceOrder` 200 ok | resuelve void; payload `{serviceOrderCode,resultCode,closeDate,commentary}` correcto |
| A4 | `closeServiceOrder` responde `erros` | `IClassRejectedError` con detail |
| A5 | `closeServiceOrder` 5xx/timeout | `IClassUnavailableError` |
| A6 | close/update/get pasan por `withAuthRetry` (429 → reintenta) | reintenta y resuelve (ver `IClassClient.429.test.ts`) |
| A7 | `listTeams` 200 → mapea login/name/thirdPartyCode; filtro thirdParty presente | descriptores |
| A8 | `updateServiceOrder` arma payload con `requiredTeam` | payload correcto |
| A9 | `closeDate` formateada al formato IClass | string esperado |

### Use case `CloseIClassServiceOrder` (`CloseIClassServiceOrder.test.ts`)
| # | Scenario | Espera |
|---|---|---|
| C1 | flag OFF | `IClassActionDisabledError` (409); IClass NO llamado |
| C2 | task no existe | `TaskNotFoundError` (404) |
| C3 | task sin `iclassOrderCode` | `IClassNoServiceOrderError` (422) |
| C4 | task `generalStatus !== 'open'` | `IClassTaskNotOpenError` (409) |
| C5 | resultCode no en catálogo | `IClassResultCodeNotFoundError` (404) |
| C6 | pre-check: OS ya terminal ('7') | `IClassAlreadyClosedError` (409); close NO llamado |
| C7 | pre-check: `getServiceOrder` null | `IClassNoServiceOrderError` (422) |
| C8 | happy path | close llamado con payload correcto; `generalStatus='closed'`; activity 'status_changed' grabada |
| C9 | IClass rechaza (`IClassRejectedError`) | propaga; task NO se cierra localmente |
| C10 | IClass unavailable | propaga 502; task NO se cierra |
| C11 | race: task ya `closed` al re-ejecutar | guard `!== 'closed'`, no re-cierra (idempotente) |

### Use case `AssignIClassTeam` (`AssignIClassTeam.test.ts`)
| # | Scenario | Espera |
|---|---|---|
| T1 | flag OFF | `IClassActionDisabledError` (409) |
| T2 | task sin orderCode / no-open | 422 / 409 (mismos pre-checks que cierre) |
| T3 | team no existe / inactive / !selectable | `IClassTeamNotAssignableError` (422) |
| T4 | OS terminal | `IClassAlreadyClosedError` (409) |
| T5 | happy path | `updateServiceOrder({requiredTeam})` llamado; activity grabada |
| T6 | IClass rechaza/unavailable | propaga 422/502 |

### Use case `SyncIClassTeams` (`SyncIClassTeams.test.ts`) — clon de `SyncIClassNodes`
| # | Scenario | Espera |
|---|---|---|
| S1 | upsert por login, descarta login vacío | counts created |
| S2 | reactiva un team inactivo | reactivated++ |
| S3 | `markInactiveExcept` desactiva los ausentes | deactivated++ |
| S4 | grouping teams (si los hay) → selectable=false | selectable=false |

### Rutas (supertest)
| # | Scenario | Espera |
|---|---|---|
| R1 | POST close sin permiso `iclass_close` | 403 |
| R2 | POST close body inválido (zod) | 400 VALIDATION_ERROR |
| R3 | POST close happy → 200 task DTO | 200 |
| R4 | POST close con OS terminal → 409 `ICLASS_ALREADY_CLOSED` | 409 |
| R5 | POST close IClass rechaza → 422 + `reason` visible | 422 |
| R6 | POST close IClass unavailable → 502 | 502 |
| R7 | POST close flag OFF → 409 `ICLASS_ACTION_DISABLED` | 409 |
| R8 | POST assign-team sin permiso → 403 | 403 |
| R9 | POST assign-team happy → 200 | 200 |
| R10 | GET /admin/iclass/teams sin `iclass.read` → 403 | 403 |
| R11 | POST /teams/sync sin `iclass.manage` → 403 | 403 |
| R12 | errorHandler mapea los 5 códigos nuevos al status correcto | map test |

### Composition root
| # | Scenario | Espera |
|---|---|---|
| CR1 | la app levanta con los nuevos use cases/rutas wireados | no throw |

### FE (vitest)
| # | Scenario | Espera |
|---|---|---|
| FE1 | botón Cerrar visible solo si orderCode && open && permiso && flag | render condicional |
| FE2 | modal de cierre envía resultCode+commentary+closeDate | POST correcto |
| FE3 | error 422 con `reason` → muestra el detalle de IClass | toast con reason |
| FE4 | selector de cuadrilla lista teams selectable+active | dropdown |
| FE5 | assign envía teamLogin | POST correcto |

## 10. Plan de prueba en vivo (mitigación del riesgo escritura-no-probada)

1. Deploy con AMBOS flags OFF. El código está pero inerte.
2. Con una OS/cliente de **prueba** en IClass (no productiva), un super_admin (único con el permiso por default) ejecuta UN cierre → capturar el shape EXACTO de la respuesta y de cualquier `erros`. Ajustar parsers si difiere del spec.
3. Repetir con `assign-team` y `getServiceOrder` (verificar shape del snapshot y el 404).
4. Validado el shape → flippear `iclass-close-action` ON (luego `iclass-assign-action`), asignar los permisos a los roles operativos vía la UI de roles.
5. Monitorear los primeros cierres reales (logs de `IClassRejected`/`Unavailable`).

> Este plan es el "cinturón de seguridad" frente a las 3 mentiras documentadas de IClass. NADA se habilita masivamente sin paso 2-3.
