# Tasks: ipnext-tecnicos — app propia de técnicos + módulo `/api/tech/*`

TDD estricto en todo el BE: cada task de código va precedida por su test en rojo. Migraciones vía `prisma migrate diff` (nunca SQL a mano); nombre propuesto en cada task de schema. Ver `design.md`/`proposal.md` para paths y decisiones citadas.

---

## Wave 1a — Cierre atómico first-writer-wins (Solo BE)
Spec: `specs/task-general-status/spec.md`. Arregla deuda preexistente (4 escritores sin lock) antes de sumar el 5º (app).

- [x] W1a.1 Migración `add_scheduled_task_closure_tracking` (aditiva): `ScheduledTask.closureOrigin String?`, `closureResultCode String?`, `closedAt DateTime?`, `closedByUserId String?` + FK `RbacUser` `onDelete: SetNull`.
- [x] W1a.2 RED — `InMemorySchedulingRepository.closeTaskIfOpen`: test de concurrencia con hook `beforeWrite` (`Promise.all([closeApp, closeIclass])` → un `closed:true`, un `closed:false` con `existingOrigin` correcto). Debe fallar (método no existe).
- [x] W1a.3 GREEN — Agregar `ClosureOrigin`/`CloseTaskResult`/`closeTaskIfOpen` a `domain/ports/SchedulingRepository.ts`; implementar en `InMemorySchedulingRepository` con el hook de interleaving.
- [x] W1a.4 RED — Test in-memory: cerrar una tarea ya `closed` es no-op (`closed:false`, `existingOrigin` del ganador previo, sin doble escritura).
- [x] W1a.5 GREEN — Ajustar el shape de retorno de `closeTaskIfOpen` in-memory hasta que W1a.4 pase.
- [x] W1a.6 RED — `PrismaSchedulingRepository.closeTaskIfOpen`: test de integración contra Postgres, `updateMany` condicional, `count===1` gana / `count===0` pierde y releé. *(Sin DB real disponible en esta fase — prisma singleton mockeado, mismo convenio que `PrismaSchedulingRepository.methods.test.ts`.)*
- [x] W1a.7 GREEN — Implementar `closeTaskIfOpen` en `PrismaSchedulingRepository.ts` (una sola sentencia `updateMany({where:{id, generalStatus:{not:'closed'}}}`, sin transacción explícita).
- [x] W1a.8 RED — Test del helper de aplicación (`applyTaskClosure` o similar): resultCodes distintos → log `[task-closure-conflict]` + `ScheduledTaskActivity` tipo `closure_conflict`; mismo resultCode → ninguno de los dos.
- [x] W1a.9 GREEN — Implementar el helper único que envuelve `closeTaskIfOpen` (log + activity), consumido por los 5 escritores.
- [x] W1a.10 RED — Test del mapper DTO: `closureOrigin` en la respuesta de `ScheduledTask`, `null` salvo `generalStatus==='closed'`.
- [x] W1a.11 GREEN — Sumar `closureOrigin` al mapper Prisma→DTO existente.
- [x] W1a.12 Rutear `SetTaskGeneralStatus.ts:34` por el helper (origin=`staff`), preservando el no-op D8 sobre tarea ya cerrada; actualizar sus tests.
- [x] W1a.13 Rutear `UpdateTask.ts:34`: si el patch trae `generalStatus:'closed'` → helper (origin=`staff`); cualquier otro valor sigue por `updateTask`; actualizar tests.
- [x] W1a.14 Rutear `IngestClosedServiceOrders.ts:379-380` por el helper (origin=`iclass`), preservando el no-op si `generalStatus!=='closed'` ya no aplica; actualizar tests.
- [x] W1a.15 Rutear `CloseIClassServiceOrder.ts:101` por el helper (origin=`staff`), manteniendo el chequeo `:70`; confirmar que el push a IClass no se ve afectado; actualizar tests.
- [x] W1a.16 RED+GREEN — Test estático `src/__tests__/staticSource/taskClosureGuard.test.ts`: ningún archivo fuera de `PrismaSchedulingRepository`/`InMemorySchedulingRepository` contiene `generalStatus: 'closed'` en un `updateTask` directo (filtrar comentarios antes de matchear).
- [x] W1a.17 Revert-probe: revertir temporalmente `closeTaskIfOpen` a `updateTask` en un escritor y confirmar que W1a.2/W1a.6 se ponen en ROJO; revertir el revert. Documentar el resultado en el commit.
- [x] W1a.18 Matriz spec-compliance Wave 1a: los 8 scenarios de `specs/task-general-status/spec.md` → test file:case (insumo de sdd-verify). *(El spec file tiene 7 scenarios reales, no 8 — ver desvíos en el commit/reporte.)*
- [x] W1a.19 `npm test` + `tsc --noEmit` verdes. 1202/1202 suites, 12238/12238 tests, tsc sin errores.
- [x] W1a.20 Review adversarial COMPLETO (orquestador, 2026-08-10): 2 revisores opus (concurrencia/migración + tests/contrato) → 3 HIGH + 6 MED · fix wave 1 (9 fixes TDD, `0dec6a0a`) · re-review → 2 MED de interacción · fix wave 2 (7 fixes, `3f887c44`) · re-review → 2 MED angostos · fix wave 3 (4 fixes, `9bd2e0a4`) · re-review final → CLEAN GLOBAL (1 LOW doc corregido inline, `4953e2e4`).
- [x] W1a.21 Verificación EN VIVO COMPLETA (2026-08-10, deploy `c6a16602`, run 31407492042 verde, 2 migraciones aplicadas): tarea probe seq 5815 en prod → 2 POST `/status closed` CONCURRENTES → **UN solo `status_changed`**, `closureOrigin='staff'` sellado una vez, **0 `closure_conflict`** (idempotencia) → reopen → `closureOrigin=null` + `metadata.clearedClosure` con el sello completo (quién/cuándo) → probe borrada (204).

---

## Wave 1b — Contrato `/api/tech/*`: auth + tareas + estados (Contrato compartido)
Specs: `specs/tech-api-auth/spec.md`, `specs/tech-tasks-worklist/spec.md`, `specs/rbac-permission-catalog-extension/spec.md`. Bloquea Waves 2b/3/4 (repo de la app y router base).

### BE — Foundation

- [ ] W1b.1 Migración `seed_rbac_tech_module` (aditiva, idempotente `ON CONFLICT DO NOTHING`): `RbacModule(code='tech')` + `RbacPermission(app_access)`, `RbacPermission(task_close)`.
- [ ] W1b.2 Migración `add_scheduled_task_field_status` (aditiva): `fieldStatus String?`, `travelStartedAt DateTime?`, `arrivedAt DateTime?` en `ScheduledTask` + índice `@@index([assigneeId, startDate])`.
- [ ] W1b.3 Migración `add_tech_session` (aditiva): tabla de sesión/refresh (molde `PortalSession`) — `technicianId`, `tokenHash`, `expiresAt`, `rotatedAt`, `revokedAt`. Nombre de tabla es detalle de implementación (spec lo deja abierto); proponer `TechSession`.
- [ ] W1b.4 RED — `src/__tests__/infrastructure/adapters/jwt/JwtTechTokenService.test.ts`: firma/verifica `aud='tech'`, HS256 pineado, TTL 900s, `verifyAccessToken` devuelve `null` (nunca throw) ante `aud` distinto.
- [ ] W1b.5 GREEN — Crear `domain/ports/TechTokenService.ts` + `infrastructure/adapters/jwt/JwtTechTokenService.ts` (molde `JwtPortalTokenService.ts`).
- [ ] W1b.6 RED — Test `domain/services/techRefreshToken.ts` (molde `portalRefreshToken.ts`): genera 32 bytes base64url, hashea sha256.
- [ ] W1b.7 GREEN — Implementar `domain/services/techRefreshToken.ts`.
- [ ] W1b.8 RED — Test de contrato `TechSessionRepository` sobre `InMemoryTechSessionRepository`: `create`/`findByTokenHash`/`markRotated` (CAS atómico, `false`=ya rotado)/`revoke`/`revokeAllForTechnician`.
- [ ] W1b.9 GREEN — Crear `domain/ports/TechSessionRepository.ts` + `InMemoryTechSessionRepository.ts` + `PrismaTechSessionRepository.ts`.

### BE — Use cases de sesión

- [ ] W1b.10 RED — Test `LoginTechnician`: login válido con `tech.app_access` → tokens; sin el permiso, inactivo, o password mala → MISMO error genérico `INVALID_TECH_CREDENTIALS`.
- [ ] W1b.11 GREEN — Implementar `application/use-cases/tech/LoginTechnician.ts`.
- [ ] W1b.12 RED — Test `RefreshTechnicianSession`: rotación single-use + detección de reuso (molde `RefreshPortalSession.test.ts`), CAS atómico.
- [ ] W1b.13 GREEN — Implementar `application/use-cases/tech/RefreshTechnicianSession.ts`.
- [ ] W1b.14 RED — Test `LogoutTechnician`: `204` idempotente, best-effort, nunca falla ruidosamente.
- [ ] W1b.15 GREEN — Implementar `application/use-cases/tech/LogoutTechnician.ts`.
- [ ] W1b.16 RED — Test `GetTechnicianMe`: shape `{id, name, login, iclassTeamLogin}`.
- [ ] W1b.17 GREEN — Implementar `application/use-cases/tech/GetTechnicianMe.ts`.

### BE — Middleware y guard cruzado

- [ ] W1b.18 RED — Test `techAuthMiddleware`: Bearer-only (rechaza cookies), re-chequea `status==='active'` Y `tech.app_access` en CADA request, setea `req.technicianId`, 401 con permiso perdido a mitad de sesión aunque el JWT siga válido (doble capa).
- [ ] W1b.19 GREEN — Implementar `infrastructure/http/middleware/techAuthMiddleware.ts`; agregar `req.technicianId?: string` a `src/types/express.d.ts` con docblock anti-IDOR.
- [ ] W1b.20 RED — Test bidireccional: token `aud=tech` → `/api/admin/*` 401; token staff (sin `aud`) → `/api/tech/*` 401; token `aud=portal` → `/api/tech/*` 401. Assert de PRESENCIA primero (ruta responde 200 con el token correcto) antes del rechazo.
- [ ] W1b.21 GREEN — En `JwtAuthAdapter.getSession()` (`:111`), reemplazar el `if` encadenado por el allowlist invertido `if (payload.aud !== undefined) throw`.
- [ ] W1b.22 RED — Test RBAC: tras la migración W1b.1, `RbacModule(code='tech')` + los 2 permisos existen; re-correr la migración es no-op.
- [ ] W1b.23 GREEN — Confirmar contenido de W1b.1 + extender `RbacModuleCode`/`PermissionAction` en `domain/entities/rbac.ts` con `'tech'`/`'app_access'`/`'task_close'`.

### BE — Worklist y transiciones

- [ ] W1b.24 RED — Test `ListTechnicianDayTasks`: filtra `assigneeId=req.technicianId`, `date` default hoy (America/Argentina/Buenos_Aires), `generalStatus IN ('open')`, DTO incluye `customerName` (join a `Client`, nuevo).
- [ ] W1b.25 GREEN — Implementar `application/use-cases/tech/ListTechnicianDayTasks.ts` + `TechTaskListItemDto`.
- [ ] W1b.26 RED — Test `GetTechnicianTaskDetail`: 404 `TASK_NOT_FOUND` en tarea ajena (indistinguible de inexistente); shape `TechTaskDetailDto`.
- [ ] W1b.27 GREEN — Implementar `application/use-cases/tech/GetTechnicianTaskDetail.ts`.
- [ ] W1b.28 RED — Test `StartTaskTravel`: `null→traveling` sella `travelStartedAt`; idempotente sobre `traveling` (no re-sella); 409 sobre `on_site`; 409 `TASK_ALREADY_CLOSED`; anti-IDOR 404.
- [ ] W1b.29 GREEN — Implementar `application/use-cases/tech/StartTaskTravel.ts`.
- [ ] W1b.30 RED — Test `ArriveAtTask`: `traveling→on_site` sella `arrivedAt`; idempotente sobre `on_site`; 409 sobre `null` (skip); 409 `TASK_ALREADY_CLOSED`; anti-IDOR.
- [ ] W1b.31 GREEN — Implementar `application/use-cases/tech/ArriveAtTask.ts`.
- [ ] W1b.32 RED — Test `CloseTaskFromField`: valida `resultCode` contra `IClassResultCodeRepository.findByCode` (404 si no existe); usa el helper de W1a con `origin='app'`; 409 con `{closureOrigin}` si pierde la carrera; exige `tech.task_close` (403 `PERMISSION_DENIED` si falta, aunque la tarea sea propia); anti-IDOR.
- [ ] W1b.33 GREEN — Implementar `application/use-cases/tech/CloseTaskFromField.ts`.

### BE — Rutas y wiring

- [ ] W1b.34 RED — `src/__tests__/infrastructure/tech.routes.test.ts` (supertest, repos in-memory): contrato HTTP completo de auth + tasks (todos los status codes de las tablas de error de ambos specs).
- [ ] W1b.35 GREEN — Implementar `infrastructure/http/routes/tech.routes.ts` (deps opcionales — el router no se monta si faltan).
- [ ] W1b.36 RED — `src/__tests__/app-composition.tech.test.ts` (molde `app-composition.technicianLocation.test.ts`): mount exactamente una vez, repos Prisma reales, `techAuthMiddleware` aplicado a todo salvo `/auth/login` y `/auth/refresh`.
- [ ] W1b.37 GREEN — Montar el router en `infrastructure/http/app.ts`, UN solo bloque al final del wiring.

### App — Bootstrap del repo (bloqueado) + pantallas base

- [x] W1b.38 Repo `ipnext-tecnicos` creado en GitHub (`github.com/rhernandezbas/ipnext-tecnicos`, privado, aún sin push — lo decide el orquestador tras el review) y bootstrapeado en `C:\Users\ronald\projects\ipnext\ipnext-tecnicos`: esqueleto clonado de `ipnext-customer-app` (package.json, tsconfig, jest.config, eslint, app.json con identidad propia — nombre "IPNEXT Técnicos", slug `ipnext-tecnicos`, scheme `ipnextecnicos`, package Android `com.ipnext.tecnicos`, distintos de Mi IPNEXT —, expo-router con grupos `(auth)`/`(tabs)`, design tokens, UI primitives Screen/Button/Card/EmptyState/ErrorState/Skeleton, `git init` + `origin` + `main`, `npm install` real sin junction). Sin pantallas de negocio del cliente, sin push/biometría, sin `openspec/`. Desvíos documentados en el commit `chore(bootstrap)`: sin fuentes custom (Lexend/Source Sans 3 — usa fuente de sistema), sin `react-native-keyboard-controller` (Screen usa `KeyboardAvoidingView` nativo, dos formularios cortos no lo necesitan), sin experiment `reactCompiler`.
- [x] W1b.39 `src/lib/api.ts` adaptado: `resolveBaseUrl()` vía `EXPO_PUBLIC_API_URL` (paths embeben `/api/tech/...`, mismo patrón que `/api/portal/...` de la customer app); `src/lib/types.ts` con el contrato EXACTO de `tech-api-auth`/`tech-tasks-worklist` (incl. `PERMISSION_DENIED` de W1b.32). Suite `api.test.ts` (17 tests) verde.
- [x] W1b.40 `(auth)/login` (usuario+password, error genérico `INVALID_TECH_CREDENTIALS` anti-enumeración, rate-limit/network/timeout) + `TechSessionManager` (`src/lib/session.ts`, clonado del refresh-on-401 single-flight de la customer app — access en memoria, refresh en SecureStore, rotación single-use — sin `mustChangePassword`/`portal_disabled`, no aplican a este contrato). `session.test.ts` (24 tests) + `login.test.tsx` (10 tests) verdes.
- [x] W1b.41 `(tabs)/agenda` (lista del día, 4 ramas de estado, pull-to-refresh, nombre del técnico vía `/me`, logout) + `(tabs)/tarea/[id]` (detalle, link a mapa, botones travel/start · travel/arrive · close). Estados de botón forward-only via `resolveFieldStatusButtons` (TDD, pura, testeada antes de la pantalla). Cierre con doble confirmación (revelar formulario + `Alert` nativo) y manejo explícito del 409 `TASK_ALREADY_CLOSED` con `closureOrigin` (nunca 200 silencioso). Desvío: sin endpoint de catálogo de `resultCode` en el spec — el input queda como texto libre con nota "código del catálogo IClass"; si se agrega un `GET` de catálogo, cambiar a selector. `fieldStatusActions.test.ts`/`closureOrigin.test.ts`/`taskFormat.test.ts` + `agenda.test.tsx`/`tarea-detail.test.tsx` verdes.

  **Gates del bootstrap (2026-08-11, repo `ipnext-tecnicos`)**: `npm test` → 12/12 suites, 125/125 tests verdes. `npx tsc --noEmit` → limpio. `npx expo export --platform android --no-bytecode` → OK (1367 módulos, bundle 2.4MB) + `rg "@testing-library|describe\(|jest\.mock" dist/` → 0 matches. 3 commits locales conventional (`chore(bootstrap)`, `feat(auth)`, `feat(agenda)`), sin push (lo decide el orquestador tras el review).

### Cierre de wave

- [ ] W1b.42 Matriz spec-compliance Wave 1b: scenarios de `tech-api-auth`, `tech-tasks-worklist`, `rbac-permission-catalog-extension` → test file:case.
- [ ] W1b.43 `npm test` + `tsc --noEmit` verdes (BE). Si W1b.38-41 desbloqueadas: build de desarrollo Expo levanta sin errores.
- [ ] W1b.44 Review adversarial del diff BE completo de la wave.
- [ ] W1b.45 Verificación EN VIVO: `curl` del contrato completo `/api/tech/*` en el entorno real (login → me → tasks list → detail → travel/start → travel/arrive → close) con un `RbacUser` técnico real (`tech.app_access`+`tech.task_close`); confirmar el guard cruzado bidireccional contra rutas reales (`/api/admin/*`, `/api/portal/*`).

---

## Wave 2a — Migración GPS + lecturas dual-source (Solo BE)
Specs: `specs/iclass-team-location-ingest/spec.md` + `specs/iclass-team-live-map/spec.md`.
**Nota de reconciliación**: el header del segundo spec dice "(Wave 2b)", pero `proposal.md` (tabla de waves) y la Testing Strategy de `design.md` ubican las lecturas dual-source (`live`/`journey`/`audit`) en 2a — solo-BE, sin contrato nuevo de app. Se sigue esa fuente (más específica y consistente entre sí).

- [ ] W2a.1 Migración `add_team_location_point_source_technician` (aditiva): `TeamLocationPoint.source String @default("iclass")`, `technicianId String?` + FK `RbacUser` `onDelete: SetNull`, índice `@@index([source, recordedAt])`. El default cubre el backfill implícito — cero cambio de código en el ingest IClass.
- [ ] W2a.2 RED — Test `InMemoryTeamLocationRepository`: puntos `source='iclass'` con `technicianId=null`; puntos `source='app'` con `technicianId` no-nulo.
- [ ] W2a.3 GREEN — Extender `InMemoryTeamLocationRepository.ts` (`saveMany`) con `source`/`technicianId`.
- [ ] W2a.4 RED+GREEN — Test de regresión `PrismaTeamLocationRepository.test.ts`: el ingest IClass (`IngestTeamLocations.ts`) sigue escribiendo `source='iclass'`/`technicianId=null` sin ningún cambio de su código.
- [ ] W2a.5 RED — Test `GetTeamsLiveStatus.ts`: la última posición es el MÁS RECIENTE entre `source='iclass'` y `source='app'` para la misma cuadrilla.
- [ ] W2a.6 GREEN — Implementar la resolución "último punto" en `GetTeamsLiveStatus.ts` (misma tabla, filtro por `source` transparente al consumidor).
- [ ] W2a.7 RED — Test: técnico sin `iclassTeamLogin` (`teamLogin` sintético `tech:{id}`) con puntos `source='app'` aparece en el mapa vivo aunque NO esté en `source.listTeams()` de IClass.
- [ ] W2a.8 GREEN — Implementar en `GetTeamsLiveStatus.ts` el paso aditivo: unión del roster IClass con los `teamLogin` de puntos `source='app'` ausentes, `name` derivado del `RbacUser`.
- [ ] W2a.9 RED — Test `GetTeamDailyJourney.ts`: conteo y distribución horaria incluyen AMBOS orígenes sin exponer desglose por origen en la respuesta.
- [ ] W2a.10 GREEN — Implementar el merge dual-source en `GetTeamDailyJourney.ts`.
- [ ] W2a.11 RED — Test `AuditServiceOrderPresence.ts`: la ventana de auditoría incluye puntos `source='app'` junto a `source='iclass'`, mismo shape de respuesta.
- [ ] W2a.12 GREEN — Implementar el include dual-source en `AuditServiceOrderPresence.ts`.
- [ ] W2a.13 RED+GREEN — Test de regresión: cuadrilla con último punto >24h sigue marcada `stale` (sin importar el origen del punto más reciente).
- [ ] W2a.14 Matriz spec-compliance Wave 2a: scenarios de ambos specs → test file:case.
- [ ] W2a.15 `npm test` + `tsc --noEmit` verdes.
- [ ] W2a.16 Review adversarial del diff.
- [ ] W2a.17 Verificación EN VIVO: insertar (SQL/script) un `TeamLocationPoint` real `source='app'` para una cuadrilla mapeada Y otro con `teamLogin` sintético `tech:{id}` fuera del roster; confirmar ambos visibles vía el endpoint `/live` real, sin afectar el ingest IClass en curso.

---

## Wave 2b — Breadcrumbs batch + background location (Contrato compartido)
Spec: `specs/tech-location-ingest/spec.md`. Depende de Wave 1b (router/middleware) y Wave 2a (schema).

- [ ] W2b.1 **[SPIKE, BLOQUEANTE, depende de W1b.38]** Verificar compat `expo-location`+`expo-task-manager` con el skeleton SDK 57 (`expo ~57.0.9`, RN 0.86.2) del repo `ipnext-tecnicos`: `npx expo install expo-location expo-task-manager` + build de desarrollo que arranque `TaskManager`. Si falla: replantear a foreground-only, documentar, SIN arrastrar a Waves 1/3/4.
- [ ] W2b.2 RED — Test `IngestTechnicianBreadcrumbs`: validación por punto (lat/lng fuera de rango, `recordedAt` futuro >5min o >7 días atrás → `dropped` individual); `points` vacío → 400 `VALIDATION_ERROR`; batch >200 → 400 `BATCH_TOO_LARGE` sin persistir nada.
- [ ] W2b.3 GREEN — Implementar `application/use-cases/tech/IngestTechnicianBreadcrumbs.ts` (`teamLogin = iclassTeamLogin ?? 'tech:'+id`, `source='app'`, `technicianId=req.technicianId`).
- [ ] W2b.4 RED — Test idempotencia: reenviar el mismo batch → `accepted:0, duplicates:N` (unique natural `(teamLogin, recordedAt, latitude, longitude)`).
- [ ] W2b.5 GREEN — Confirmar el mapeo `{accepted,duplicates,dropped}` sobre `TeamLocationRepository.saveMany` (`{inserted,duplicates}`); ajustar si no calza 1:1.
- [ ] W2b.6 RED — Route test `POST /api/tech/location` (supertest): 201 con el shape completo; técnico sin mapeo nunca rechazado (`teamLogin` sintético).
- [ ] W2b.7 GREEN — Montar la ruta en `tech.routes.ts` + wiring en `app.ts` (mismo bloque de mount de Wave 1b).
- [ ] W2b.8 Actualizar `app-composition.tech.test.ts` para pinnear también `/api/tech/location`.
- [ ] W2b.9 **[App, depende de W2b.1]** `src/features/location/location-task.ts`: `TaskManager.defineTask` + `Location.startLocationUpdatesAsync` (accuracy Balanced, timeInterval 5min, distanceInterval 100m, `deferredUpdatesInterval`).
- [ ] W2b.10 **[App]** Batching offline: cola en `AsyncStorage`, drenado a `POST /api/tech/location` (máx 200) al recuperar red.
- [ ] W2b.11 **[App]** Corte fuera de jornada: `stopLocationUpdatesAsync` al logout y al cerrar la última tarea del día.
- [ ] W2b.12 **[App]** Android manifest: `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION`, notificación persistente (requisito Android 14).
- [ ] W2b.13 **[BLOQUEADO — acción del usuario]** Play Console: declaración de uso prominente + video demostrativo para el permiso de background location (ronda de revisión adicional — *Mi IPNEXT* no lo tenía).
- [ ] W2b.14 Matriz spec-compliance Wave 2b: scenarios de `tech-location-ingest` → test file:case.
- [ ] W2b.15 `npm test` + `tsc --noEmit` verdes (BE).
- [ ] W2b.16 Review adversarial del diff BE.
- [ ] W2b.17 Verificación EN VIVO: build de desarrollo de la app envía un batch real de breadcrumbs (foreground-only si el spike W2b.1 tumbó background) contra el backend real; confirmar `{accepted,duplicates,dropped}` y el punto visible en `/live` (encadenado con W2a.17).

---

## Wave 3 — Evidencia de cierre (Contrato compartido)
Spec: `specs/tech-closure-evidence/spec.md`. Depende de Wave 1b.

- [ ] W3.1 RED — Test `AttachClosureEvidence`: 404 tarea ajena; delega en `AttachPhotosToTask` (mimetype por magic bytes, cupo 15 compartido con staff, 50MP anti-bomb); 503 `STORAGE_NOT_CONFIGURED` sin MinIO.
- [ ] W3.2 GREEN — Implementar `application/use-cases/tech/AttachClosureEvidence.ts` (wrapper de autorización, cero storage nuevo).
- [ ] W3.3 RED — Route test multipart `POST /api/tech/tasks/:id/evidence` (supertest): 201 `TechAttachmentDto[]`, `fileUrl`/`thumbUrl` bajo la base `/api/tech/tasks/attachments/{id}/file`.
- [ ] W3.4 GREEN — Implementar `infrastructure/http/routes/techEvidenceUpload.ts` (molde `ticketMessageUpload.ts`: precheck `Content-Length` + `createBoundedBatchStorage`) + montar en `tech.routes.ts`.
- [ ] W3.5 RED — Test `GET /api/tech/tasks/:id/evidence` (scoped, 404 ajena) y `GET /api/tech/tasks/attachments/:id/file?variant=thumb|original` (binario, 404 `ATTACHMENT_NOT_FOUND` para adjunto de otro técnico).
- [ ] W3.6 GREEN — Implementar ambos endpoints reusando `MinioFileStorage`/`ScheduledTaskAttachment` existentes.
- [ ] W3.7 Actualizar `app-composition.tech.test.ts` para pinnear la superficie de evidencia (incl. middleware multipart).
- [ ] W3.8 **[App]** Captura: cámara/galería para fotos + canvas de firma → PNG `signature.png`, en el flujo de cierre.
- [ ] W3.9 **[App]** Subida multipart contra `POST /api/tech/tasks/:id/evidence` con progreso y reintento simple (sin cola offline).
- [ ] W3.10 Matriz spec-compliance Wave 3: scenarios de `tech-closure-evidence` → test file:case.
- [ ] W3.11 `npm test` + `tsc --noEmit` verdes.
- [ ] W3.12 Review adversarial del diff.
- [ ] W3.13 Verificación EN VIVO: subir una foto y una firma reales desde un build de la app contra el backend real; confirmar el adjunto en la galería del panel admin (mismo prefijo `tasks/{taskId}/`) y `fileUrl`/`thumbUrl` accesibles.

---

## Wave 4 — Consumo de materiales (Contrato compartido)
Spec: `specs/tech-material-consumption/spec.md`. Depende de Wave 1b. Sin migraciones (reusa `TaskMaterialConsumption`).

- [ ] W4.1 RED — Test `DeclareMaterialConsumption`: 404 tarea ajena; `recordedByUserId` SIEMPRE del token (nunca del body); delega en `RecordMaterialConsumption` (dispara `StageMaterialDeduction`); rechaza `quantity<=0` y material inexistente ANTES de escribir.
- [ ] W4.2 GREEN — Implementar `application/use-cases/tech/DeclareMaterialConsumption.ts`.
- [ ] W4.3 RED — Test `GET /api/tech/stock`: `{technicianId, locationId:null, assets:[], materials:[]}` sin ubicación TECNICO resuelta; shape completo cuando sí.
- [ ] W4.4 GREEN — Implementar ruta `GET /api/tech/stock` delegando en `GetTechnicianStock.execute(req.technicianId)` (ya existente).
- [ ] W4.5 RED — Route tests `POST /api/tech/tasks/:id/materials` + `GET /api/tech/tasks/:id/materials` (supertest): códigos 400/404, 201 `MaterialConsumptionDto`.
- [ ] W4.6 GREEN — Montar ambas rutas en `tech.routes.ts` + wiring `app.ts`.
- [ ] W4.7 Actualizar `app-composition.tech.test.ts` para pinnear la superficie de materiales.
- [ ] W4.8 **[App]** Pantalla de declaración de consumo: selector de material (`GET /api/tech/stock`) + cantidad, en el flujo de la tarea.
- [ ] W4.9 Matriz spec-compliance Wave 4: scenarios de `tech-material-consumption` → test file:case.
- [ ] W4.10 `npm test` + `tsc --noEmit` verdes.
- [ ] W4.11 Review adversarial del diff.
- [ ] W4.12 Verificación EN VIVO: declarar un consumo real desde un build de la app contra el backend real; confirmar `TaskMaterialConsumption` con `recordedByUserId` correcto y el staging de deducción disparado (visible en el flujo operador existente).
