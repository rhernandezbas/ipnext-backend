# Design: task-send-to-iclass

## Contexto

Disparar el alta de una OS en IClass cuando una tarea pasa al stage "Enviar a IClass", con feature flag por DB y validación de requeridos que el front usa para un modal. Arquitectura hexagonal estricta, TDD.

## Architecture Decisions

### AD-1: La lógica vive en un use-case dedicado, no en `MoveTaskToStage`
`MoveTaskToStage` queda fino: detecta si el stage destino es "Enviar a IClass" y delega en `SendTaskToIClass`. Esto evita acoplar el flujo genérico de stages con IClass y mantiene un use-case por responsabilidad (convención del repo). `SendTaskToIClass` recibe `IClassPort`, `FeatureFlagRepository`, `SchedulingRepository` y un lookup de `Client`.

### AD-2: Resolución de nodo por ciudad, validada contra `listNodes()`
`nodeCode = customerCity`. Antes de crear, se valida (case-insensitive, trim) contra `IClassPort.listNodes()`. Si no matchea → `IClassNodeNotFoundError` → 422. Se evita así el error real `ICLERR_0014` (microárea obligatoria) descubierto al probar la API. **Optimización**: cachear `listNodes()` en memoria del adapter con TTL corto (ej. 5 min) para no pegarle a IClass en cada move.

### AD-3: Feature flag en DB + repo, no en `config.ts`
La decisión del usuario es toggle por API persistente. `config.ts` sigue fail-fast solo para credenciales (`ICLASS_*`). El estado on/off vive en `FeatureFlag` (DB). El use-case consulta `FeatureFlagRepository.get('iclass-integration')`. Seed lo crea en `false`.

### AD-4: `typeSOSummary` fijo por config
Un único `ICLASS_DEFAULT_SO_TYPE` en `config.ts` (decisión del usuario). El adapter lo usa para todas las OS. Si más adelante se necesita por-tipo, se agrega un campo a la tarea (out of scope ahora).

### AD-5: Sin fecha en el alta
El adapter NO envía `scheduledDate`. La OS cae en IClass para que una persona asigne técnico+fecha. Esto coincide con el flujo real verificado (status "Agendada"/sin equipo).

### AD-6: Mapeo de campos requeridos
| Requerido | Origen |
|-----------|--------|
| `customerName` | `Client.name` vía `customerId` |
| `phone` | `Client.phone` |
| `city` | `Client.city` (= `customerCity`, usado como nodeCode) |
| `address` | `ScheduledTask.address` |
| `description` | `ScheduledTask.description` |
`PrismaSchedulingRepository` hoy solo selecciona `{id,name,city}` del Client — se extiende el JOIN para traer `phone` (y `address` del client si se decide fallback). Se prefiere un lookup explícito de Client en el use-case para no inflar el `toTask()` general.

### AD-7: Idempotencia básica
Si la tarea ya tiene `iclassOrderCode` no nulo, `SendTaskToIClass` MUST no crear una segunda OS (evita duplicados ante reintentos). Devuelve el código existente y mueve el stage si aún no avanzó.

## Sequence (flag ON, happy path)

```
PATCH /api/scheduling/:id/stage { stageId: <Enviar a IClass> }
  → MoveTaskToStage
     ├─ stage destino == "Enviar a IClass"?  no → mover normal (200)
     └─ sí → SendTaskToIClass.execute(taskId)
              ├─ flag get('iclass-integration')  OFF → mover normal (200), fin
              ├─ task.iclassOrderCode != null → (idempotencia) mover a "Registrado", fin
              ├─ cargar Client(customerId) + task
              ├─ validar requeridos → faltan → throw MissingRequiredFieldsError (422)
              ├─ listNodes() (cache) → city no matchea → throw IClassNodeNotFoundError (422)
              ├─ createServiceOrder({...}) → IClass 200 { orderCode }
              │     └─ falla → throw IClassUnavailableError (502)
              ├─ tasks.setIClassOrderCode(taskId, orderCode)
              └─ tasks.moveTaskToStage(taskId, <Registrado en IClass>)  → 200
```

## Error mapping (HTTP middleware)

| Error de dominio | HTTP | code |
|------------------|------|------|
| `MissingRequiredFieldsError` (lleva `missingFields[]`) | 422 | `MISSING_REQUIRED_FIELDS` |
| `IClassNodeNotFoundError` | 422 | `ICLASS_NODE_NOT_FOUND` |
| `IClassUnavailableError` | 502 | `ICLASS_UNAVAILABLE` |
| `FeatureFlagNotFoundError` | 404 | `FLAG_NOT_FOUND` |

## Adapter IClass (`IClassClient`)

Reusa el patrón de `GestionRealClient` (axios, mapError). Auth: `POST /auth/login {username,password}` → `access_token` (Bearer). Maneja re-login ante 401 (una vez). Construye `ServiceOrderV1In` con bloques `serviceOrder`+`customer`+`address`, `address.nodeCode = city`, sin `scheduledDate`. `listNodes()` → `GET /thirdparties/{id}/nodes` (thirdPartyId desde config) mapeando `{codigo→code, descricao→description}`. Credenciales y `ICLASS_THIRD_PARTY_ID` desde `config.ts`.

## Stage lookup

Los stages "Enviar a IClass" y "Registrado en IClass" se identifican por nombre (no por id hardcodeado — los ids son uuid del seed). `SendTaskToIClass` necesita un modo de resolver el stageId de "Registrado en IClass": vía `SchedulingRepository.getStageByName(name)` (método nuevo). Decisión: agregar `getStageByName` al port de scheduling.

## Testing strategy (TDD)

- `IClassPort` → `InMemoryIClassClient` (configurable: nodos disponibles, simular fallo/401, registrar OS creadas).
- `FeatureFlagRepository` → `InMemoryFeatureFlagRepository`.
- Use-case `SendTaskToIClass` testeado con in-memory (flag on/off, faltan campos, ciudad inválida, idempotencia, fallo IClass).
- Routes con supertest sobre app Express + repos in-memory.
- El adapter `IClassClient` se testea con mock de axios (mapeo payload + re-login 401).

## Rollback

Apagar flag por API. Revertir migración (`FeatureFlag` table + `ScheduledTask.iclassOrderCode`). Código aislado: nuevo use-case + adapter + repos; el único punto de contacto con lo existente es el branch en `MoveTaskToStage` (protegido por el flag, default OFF).

## Riesgos / notas

- `app.ts` (God Object) crece con el wiring. Mitigar: agrupar el wiring de IClass en una pequeña factory si supera ~15 líneas.
- IClass no tiene DELETE: una OS creada por error queda en la cola real. El flag default OFF y la idempotencia (AD-7) reducen el riesgo de duplicados.
- `customerCity` puede no coincidir exactamente con el nombre del nodo (acentos, mayúsculas) → normalizar en la comparación.
