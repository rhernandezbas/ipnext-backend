# Proposal: iclass-manual-node-resend

## Intent

Cuando una tarea se mueve al stage `send_to_iclass`, `SendTaskToIClass` resuelve un
"nodo" (microarea) matcheando `task.customerCity` contra `IClassPort.listNodes()`
(case- y accent-insensitive). Si la ciudad NO matchea ningun nodo, lanza
`IClassNodeNotFoundError` -> HTTP 422 `ICLASS_NODE_NOT_FOUND`, la tarea NO avanza y
el error NO se persiste en ningun lado (no hay trazabilidad del fallo).

Hoy el unico camino de recuperacion es manual y opaco: alguien corrige la
localidad del cliente (o crea el nodo en IClass) y reintenta. No hay forma de que
un operador VEA que nodos existen ni de elegir uno explicitamente.

Este cambio permite que un usuario con permiso elevado (super-admin), ante el
fallo de nodo no encontrado, vea un dropdown con los nodos disponibles de IClass,
elija el correcto y REENVIE la tarea a IClass con ese nodo (override del nodeCode).
Ademas introduce un modelo auditable minimo (`IClassDispatchAttempt`) que registra
los intentos de envio a IClass (fallos y resoluciones) para tener historial.

Scope ACOTADO: resuelve EXCLUSIVAMENTE el caso `IClassNodeNotFoundError` via
override del nodeCode. NO es un editor general de campos de la OS.

## Scope

### In Scope

- Modelo Prisma `IClassDispatchAttempt` (tabla nueva, FK a `ScheduledTask`) +
  migration aditiva (CREATE TABLE + FK + indices). Timestamp posterior a
  `20260603000000`.
- Entidad de dominio `IClassDispatchAttempt` + port de persistencia
  `IClassDispatchAttemptRepository` (`save`, `listByTask`), con adapters Prisma +
  in-memory.
- Use case nuevo `ResendTaskToIClassWithNode(taskId, nodeCode, actorId)`: valida
  que `nodeCode` exista en `listNodes()`, reusa la logica de creacion de OS de
  `SendTaskToIClass` con OVERRIDE del nodo (no del resto de campos), persiste un
  `IClassDispatchAttempt` tanto en exito como en fallo, y al exito avanza la tarea
  al stage `registered_in_iclass` (mismo comportamiento que el envio normal).
- Override del nodo en el contrato del port: agregar `nodeCode?: string` a
  `CreateServiceOrderInput`; cuando viene, el adapter lo usa como `address.nodeCode`
  en vez de derivarlo de `city` (default actual). Cambio aditivo y backward-compatible.
- Endpoint GET de nodos de IClass para alimentar el dropdown del FE.
- Endpoint POST de reenvio con override de nodo.
- Permiso granular NUEVO `scheduling.iclass_manual_resend`: agregar la action a
  `KNOWN_ACTIONS`, sembrarla como `RbacPermission` (modulo scheduling) en migration
  idempotente, y concederla a `super_admin` (CROSS JOIN, mismo patron que
  `20260529200000`). Guard `requirePerm('scheduling', 'iclass_manual_resend')` en
  ambas rutas.
- Registrar un `IClassDispatchAttempt` de FALLO tambien en el envio normal
  (`SendTaskToIClass`) cuando este lanza `IClassNodeNotFoundError` (ver Approach y
  Open Q4): asi el historial arranca desde el fallo original, no recien desde el
  reenvio.
- Tests (Strict TDD): use case con adapters in-memory; rutas con supertest
  (401/403/200); contrato del adapter para el override de nodeCode.

### Out of Scope (EXPLICITO)

- Override de cualquier OTRO campo de la OS (customerName, address, soType, etc.).
  SOLO el nodeCode. Corregir esos campos sigue siendo edicion de la tarea via los
  endpoints existentes.
- Resolver otros errores de IClass (`MISSING_REQUIRED_FIELDS`,
  `MISSING_ICLASS_MAPPING`, `ICLASS_REJECTED`, `ICLASS_UNAVAILABLE`) por esta via.
  Solo `ICLASS_NODE_NOT_FOUND`.
- Flujo asincrono / cola de reintentos. El reenvio es SINCRONO (el modal del FE
  aparece al fallar el envio y dispara el POST de reenvio en el momento).
- Persistir el cuerpo completo del payload de la OS de forma estructurada
  (mapearemos una referencia + un JSON minimo; ver Open Q2).
- UI del modal y del dropdown (vive en el FE; este change solo prepara el contrato
  BE: GET de nodos + POST de reenvio + permiso).
- Cache/invalidacion de `listNodes()` mas alla del TTL que el adapter ya tiene.

## Capabilities

### New Capabilities

- `iclass-manual-node-resend`: un super-admin puede listar los nodos de IClass y
  reenviar una tarea fallida por nodo-no-encontrado eligiendo un nodo explicito.
  El reenvio crea la OS con ese nodeCode y avanza la tarea a `registered_in_iclass`.
- `iclass-dispatch-audit`: cada intento de envio a IClass (fallo o exito) queda
  registrado en `IClassDispatchAttempt` con actor, nodo intentado/elegido,
  errorCode/errorMessage, resultado y timestamp. Historial consultable por tarea.

### Modified Capabilities

- `scheduling` / integracion IClass (spec existente): se agrega un camino de
  recuperacion para `ICLASS_NODE_NOT_FOUND`. El `CreateServiceOrderInput` admite
  `nodeCode` opcional de override; el comportamiento por defecto (nodo = city) no
  cambia.
- RBAC (`src/domain/entities/rbac.ts`): nueva action `iclass_manual_resend` en el
  modulo `scheduling`, asignada a `super_admin`.

## Approach

Estrategia: **6 commits atomicos**, dependencias hacia adelante, cada uno
reversible via `git revert`. Strict TDD por archivo (rojo -> verde -> refactor).

1. **Commit 1 - Schema + migration `IClassDispatchAttempt`**: `schema.prisma`
   agrega `model IClassDispatchAttempt` con FK a `ScheduledTask` (onDelete:
   Cascade). Migration aditiva (`CREATE TABLE` + FK + indices por `taskId` y
   `createdAt`). NO toca tablas existentes. `migrate deploy` en prod (NUNCA
   `migrate dev`); SQL generado sin DB. Bloquea los commits que persisten.

2. **Commit 2 - Dominio: entidad + port + adapters (TDD)**: entidad de dominio
   `IClassDispatchAttempt`; port `IClassDispatchAttemptRepository` (`save`,
   `listByTask`); `InMemoryIClassDispatchAttemptRepository` (tests primero) y
   `PrismaIClassDispatchAttemptRepository`.

3. **Commit 3 - Override de nodo en el port + adapter (TDD)**: agregar
   `nodeCode?: string` a `CreateServiceOrderInput` (`IClassPort.ts`).
   `IClassClient.buildServiceOrderPayload` usa `input.nodeCode ?? input.city` para
   `address.nodeCode` (default identico al de hoy). Test de contrato del adapter:
   con override el nodeCode viaja distinto de la city; sin override, igual que hoy.

4. **Commit 4 - Use case `ResendTaskToIClassWithNode` (TDD)**: recibe
   `taskId`, `nodeCode`, `actorId`. Logica:
   - carga la task (TaskNotFound -> 404);
   - valida flag iclass ON; si la task ya tiene `iclassOrderCode` -> idempotente
     (no recrea);
   - resuelve mapping/required fields igual que `SendTaskToIClass` (reusa la misma
     validacion — ver nota de reuso abajo);
   - valida que `nodeCode` exista en `listNodes()` (si no, `IClassNodeNotFoundError`
     con la city/el code y se persiste un attempt de fallo);
   - llama `createServiceOrder({ ...campos, nodeCode })`;
   - en exito: `setIClassOrderCode`, mueve a `registered_in_iclass`, persiste
     attempt `success`;
   - en fallo (rejected/unavailable): persiste attempt `failed` y re-lanza el error
     de dominio (el errorHandler ya mapea ICLASS_REJECTED/UNAVAILABLE).
   Reuso: extraer la validacion mapping+required-fields de `SendTaskToIClass` a un
   metodo/colaborador compartido para no duplicar (decision de implementacion; el
   use case sigue dependiendo solo de ports).

5. **Commit 5 - HTTP: GET nodos + POST reenvio + wiring**:
   - `GET /api/scheduling/iclass/nodes` -> 200 `{ nodes: [{ code, description }] }`.
     Guard `auth` + `requirePerm('scheduling', 'iclass_manual_resend')`. Reusa un
     use case fino `ListIClassNodes` (envuelve `iclass.listNodes()` y mapea a DTO;
     NO devuelve el tipo del port crudo si difiere).
   - `POST /api/scheduling/:id/iclass/resend` body `{ nodeCode }` ->
     200 con la task DTO. Guard `auth` + `requirePerm('scheduling',
     'iclass_manual_resend')`. Mapea `IClassNodeNotFoundError` -> 422,
     `TaskNotFoundError` -> 404; ICLASS_REJECTED/UNAVAILABLE burbujean al
     errorHandler. `actorId` = `req.user.id`. Registrar la ruta ANTES del
     catch-all `/:id` de `scheduling.routes.ts` (gotcha conocido del router).
   - Wiring en `app.ts`: construir el repo de attempts, el use case y pasarlos al
     router; inyectar `requirePerm` (el router ya importa `buildIClassClient`-based
     deps via los use cases). Tests de integracion 401/403/200/422.

6. **Commit 6 - RBAC: action `iclass_manual_resend` (catalogo + seed)**:
   - `src/domain/entities/rbac.ts`: agregar `'iclass_manual_resend'` a
     `KNOWN_ACTIONS` (seccion scheduling sub-actions).
   - Migration idempotente: `INSERT` de la fila `RbacPermission` (modulo
     `scheduling`, action `iclass_manual_resend`) `ON CONFLICT DO NOTHING`, y
     `INSERT ... CROSS JOIN` para concedersela a `super_admin` `ON CONFLICT DO
     NOTHING` (mismo patron que pasos 5-6 de `20260529200000`).
   - `seed.ts`: opcionalmente reflejar el insert para entornos limpios (super_admin
     ya recibe todo en la foundation por CROSS JOIN; ver nota seed).

Justificacion del orden: schema bloquea persistencia; dominio/port bloquean el use
case; el override del nodo es prerequisito del reenvio; HTTP cierra el flujo;
RBAC va al final (ortogonal) para no mezclar con el core. El attempt de fallo en
`SendTaskToIClass` (Open Q4) se mete en el commit 4 si se aprueba.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `model IClassDispatchAttempt` + back-relation en `ScheduledTask` |
| `prisma/migrations/<ts>_iclass_dispatch_attempt/` | New | CREATE TABLE + FK(taskId) + indices |
| `prisma/migrations/<ts>_rbac_iclass_manual_resend/` | New | seed permission + grant super_admin (idempotente) |
| `src/domain/entities/iclass-dispatch-attempt.ts` | New | entidad de dominio del intento |
| `src/domain/ports/IClassDispatchAttemptRepository.ts` | New | `save`, `listByTask` |
| `src/domain/ports/IClassPort.ts` | Modified | `CreateServiceOrderInput.nodeCode?: string` (override) |
| `src/domain/entities/rbac.ts` | Modified | `'iclass_manual_resend'` en `KNOWN_ACTIONS` |
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modified | `buildServiceOrderPayload`: `nodeCode ?? city` |
| `src/infrastructure/adapters/prisma/PrismaIClassDispatchAttemptRepository.ts` | New | impl Prisma |
| `src/infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository.ts` | New | impl in-memory (tests) |
| `src/application/use-cases/ResendTaskToIClassWithNode.ts` | New | reenvio con override + audit |
| `src/application/use-cases/ListIClassNodes.ts` | New | use case fino para el dropdown |
| `src/application/use-cases/SendTaskToIClass.ts` | Modified | (Open Q4) persistir attempt de fallo en NodeNotFound |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | GET nodes + POST resend, antes del catch-all `/:id` |
| `src/infrastructure/http/app.ts` | Modified | wiring del repo + use cases + `requirePerm` |
| `prisma/seed.ts` | Modified (opt) | reflejar permission para entornos limpios |
| `src/__tests__/application/ResendTaskToIClassWithNode.test.ts` | New | in-memory: exito/fallo/idempotencia/node-invalido |
| `src/__tests__/infrastructure/iclassResend.routes.test.ts` | New | supertest 401/403/200/422 |
| `src/__tests__/infrastructure/IClassClient.*.test.ts` | Modified | contrato del override de nodeCode |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| El reenvio crea una OS DUPLICADA si el envio original ya creo una | Low | Guard de idempotencia: si `task.iclassOrderCode != null` el reenvio NO recrea (mismo check que `SendTaskToIClass`). El caso de uso real es justamente que la OS NO se creo (fallo en validacion de nodo, antes del `createServiceOrder`). |
| El override de nodeCode rompe el flujo normal (default por city) | Low | `nodeCode` es OPCIONAL; `buildServiceOrderPayload` usa `input.nodeCode ?? input.city`. Test de contrato cubre ambos caminos. Cambio aditivo. |
| Persistir el payload completo filtra datos sensibles / pesa | Med | Guardar referencia (taskId) + un JSON minimo (nodos intentado/elegido, errorCode, errorMessage), NO el payload crudo de IClass. Decision final en Open Q2. |
| La action nueva queda sin asignar y nadie puede reenviar | Med | La migration concede `iclass_manual_resend` a `super_admin` por CROSS JOIN idempotente (patron probado en `20260529200000`). super_admin tambien pasa por short-circuit de `requirePermission`, pero la fila igual se siembra para consistencia del catalogo. |
| Conflicto de ruta con el catch-all `/:id` de scheduling.routes | Med | Registrar GET `/iclass/nodes` y POST `/:id/iclass/resend` ANTES del `/:id` (gotcha ya documentado en el router para checklist/bulk/inventory). |
| Caer en `InMemoryIClassClient` inerte (sin secrets `ICLASS_*`) -> `listNodes()` vacio -> dropdown vacio / todo falla | Med | Mismo riesgo que el envio normal (documentado en docs/iclass-integration.md). El GET de nodos devuelve la lista real solo con secrets cargados; el FE muestra estado vacio. Fuera de scope arreglar el factory. |
| Romper tests existentes de SendTaskToIClass al inyectar el repo de attempts | Med | El attempt-repo se inyecta como dependencia (constructor); en tests existentes se pasa el in-memory. TDD por archivo, suite completa al final de commit 4. |

## Rollback Plan

- Cada commit es revertible via `git revert <sha>` de forma independiente.
- Migration de tabla: `IClassDispatchAttempt` es aditiva; rollback = `prisma
  migrate resolve --rolled-back <migration>` + `DROP TABLE` si fuese imprescindible.
  Dejar la tabla no rompe codigo viejo (es ignorada).
- Migration de RBAC: la fila de permission y el grant son aditivos e idempotentes;
  dejarlos no afecta a roles que no la tienen.
- Si el commit 5 (HTTP) o el guard deja a alguien fuera (403), revertir solo ese
  commit devuelve scheduling.routes a su estado previo sin tocar dominio/migrations.
- En prod se usa `migrate deploy`; los seeds de RBAC usan `ON CONFLICT DO NOTHING`,
  re-correr no duplica.

## Dependencies

- **BE-1 (`scheduling-stage-code`)**: ESTE change apila sobre la rama
  `feat/iclass-manual-node-resend`, que a su vez esta sobre BE-1 (ya implementado).
  El reenvio avanza la tarea a `registered_in_iclass` resolviendo el stage por
  `code` (`getStageByCode`), API introducida por BE-1. NO usar nombres de stage.
- Prisma 7 + `model ScheduledTask` (PK `id String @default(uuid())`) ya existen.
- `IClassPort` + `IClassClient` (`listNodes`, `createServiceOrder`) ya existen.
- RBAC: modulo `scheduling`, `requirePermission` + factory `requirePerm` (export de
  `app.ts`), y el patron de seed de actions (CROSS JOIN a super_admin) ya existen.
- `errorHandler` ya mapea `ICLASS_NODE_NOT_FOUND` -> 422, `ICLASS_REJECTED` -> 422,
  `ICLASS_UNAVAILABLE` -> 502, `TASK_NOT_FOUND` -> 404.
- FE: depende de consumir el GET de nodos para el dropdown y el POST de reenvio. La
  forma de obtener la lista de nodos al fallar se define en Open Q1.

## Success Criteria

- [ ] `GET /api/scheduling/iclass/nodes` con permiso -> 200 `{ nodes: [...] }`; sin
      token -> 401; sin permiso -> 403.
- [ ] `POST /api/scheduling/:id/iclass/resend` con `nodeCode` valido -> 200, crea la
      OS con ese nodeCode, persiste `iclassOrderCode` y mueve la tarea a
      `registered_in_iclass`.
- [ ] `nodeCode` que no existe en `listNodes()` -> 422 `ICLASS_NODE_NOT_FOUND`, sin
      crear OS, y se persiste un `IClassDispatchAttempt` de fallo.
- [ ] Reenviar una task que YA tiene `iclassOrderCode` es idempotente (no recrea OS).
- [ ] Cada intento (exito/fallo) queda en `IClassDispatchAttempt` con actorId,
      attemptedNodeCode/resolvedNodeCode, errorCode/errorMessage, status y createdAt.
- [ ] El envio normal con `nodeCode` ausente sigue derivando el nodo de la city
      (comportamiento previo intacto).
- [ ] `super_admin` puede reenviar (catalogo siembra la action + grant).
- [ ] Application no importa de `@infrastructure/*` ni de Prisma (DIP intacto).
- [ ] Migrations aditivas; `tsc --noEmit` 0 errores; suite de tests verde.

## Open Questions

1. **Como obtiene el FE la lista de nodos al fallar.** Opciones:
   (a) el 422 de `IClassNodeNotFoundError` incluye `availableNodes: [{code,
   description}]` en el body (extender `domainErrorToCode` + errorHandler, igual
   que ya se hace con `missingFields`/`reason`);
   (b) el FE, al recibir el 422, llama al GET `/iclass/nodes` para poblar el
   dropdown.
   **Recomendacion -> (b)**. Justificacion: separa responsabilidades (el error
   reporta el fallo; el catalogo de nodos es un recurso propio reusable, y el FE lo
   necesita igual para refrescar el dropdown). Mete la lista de nodos en el body
   del error acopla el contrato de error a un caso de uso especifico y engorda
   todos los 422 de NodeNotFound (incluido el de envio masivo). El GET es ademas
   cacheable. Confirmas (b), o preferis (a) para ahorrarle un round-trip al FE?

2. **Como referenciar el payload en `IClassDispatchAttempt`.** Recomendacion ->
   **campos tipados minimos + un `Json?` opcional acotado**, NO el payload crudo de
   IClass. Campos propuestos: `id`, `taskId` (FK), `status` (`failed` | `success`),
   `errorCode String?`, `errorMessage String?`, `attemptedNodeCode String?`
   (el que se intento / null en el fallo original por city), `resolvedNodeCode
   String?` (el elegido en el reenvio), `actorId String?` (FK a RbacUser, null para
   el fallo automatico del envio normal), `createdAt`. Confirmas este set, o
   queres un `Json` con el snapshot de campos de la OS?

3. **Trigger del reenvio: stage automatico vs accion explicita.** El envio normal se
   dispara al MOVER al stage `send_to_iclass`. El reenvio NO deberia depender de
   re-mover el stage (la tarea quedo en `send_to_iclass`). **Recomendacion ->
   accion explicita** via `POST /:id/iclass/resend` (no re-disparar por move). Asi
   el override de nodo es intencional y auditable. Confirmas endpoint dedicado (vs
   reusar el move-stage con un body especial)?

4. **Registrar attempt de FALLO tambien en el envio normal (`SendTaskToIClass`).**
   Recomendacion -> **SI**, registrar el attempt de fallo cuando `SendTaskToIClass`
   lanza `IClassNodeNotFoundError` (actorId = el usuario que movio el stage). Asi el
   historial arranca desde el fallo original y el reenvio queda como resolucion del
   mismo hilo. Costo: inyectar el attempt-repo en `SendTaskToIClass` (toca su
   constructor y sus tests). Alternativa: registrar SOLO el reenvio manual (menos
   cambios, pero el fallo original no queda en el historial). Confirmas registrar
   ambos?

5. **Nombre de la action RBAC.** Confirmado por el usuario:
   `scheduling.iclass_manual_resend`. Solo se documenta aca para cerrar: la action
   vive en el modulo `scheduling` (no en `iclass`, que agrupa sync/catalogo). Ok
   mantenerla en `scheduling`?
