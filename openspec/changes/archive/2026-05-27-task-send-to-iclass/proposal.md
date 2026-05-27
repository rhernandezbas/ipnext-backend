# Proposal: Enviar tarea a IClass (alta de Orden de Servicio)

## Intent

Cuando una tarea de scheduling pasa al stage **"Enviar a IClass"**, hoy no pasa nada automático: alguien copia los datos a mano al panel de IClass. Queremos que ese cambio de stage **cree automáticamente una Orden de Servicio (OS) en IClass** vía su API, con los datos del cliente. La asignación de técnico y fecha la hace una persona en IClass (la OS se crea **sin fecha**). El alta debe poder **deshabilitarse en runtime por API** (feature flag) y, si faltan datos requeridos, el front debe poder mostrar un modal: el backend devuelve qué campos faltan.

## Scope

### In Scope
- Port + adapter HTTP para IClass (`IClassPort` / `IClassClient`), reusando el patrón de `GestionRealClient`.
- Use case `SendTaskToIClass`: valida requeridos, resuelve nodo/tipo, crea la OS sin fecha, guarda el código devuelto.
- Resolución `customerCity → nodeCode` + validación contra nodos reales de IClass; `typeSOSummary` configurable.
- Validación de campos requeridos (nombre, teléfono, dirección, ciudad, descripción) → respuesta **422** estructurada con `missingFields` para el modal.
- Feature flag **persistido en DB** + endpoint admin para togglear en runtime.
- Persistir `iclassOrderCode` en la tarea y mover a stage **"Registrado en IClass"** al éxito.

### Out of Scope
- El modal en sí (frontend) — acá solo el contrato de error 422.
- Cierre/actualización de OS en IClass (bloqueado por encuestas obligatorias — limitación conocida de la API).
- Sincronización inversa IClass → backend.
- Resolver nodo por geocoding/lat-lng (solo por ciudad en esta iteración).

## Capabilities

### New Capabilities
- `iclass-integration`: port/adapter de IClass, creación de OS, resolución de nodo/tipo, validación de requeridos.
- `feature-flags`: flag persistido en DB consultable y toggleable por API (primer flag: `iclass-integration`).

### Modified Capabilities
- `scheduling`: mover una tarea al stage "Enviar a IClass" dispara el alta de OS (si el flag está ON) y exige campos requeridos; devuelve 422 con `missingFields` si faltan.

## Approach

`MoveTaskToStage` detecta el stage destino "Enviar a IClass". Si el flag está OFF → mueve el stage sin llamar a IClass. Si está ON → invoca `SendTaskToIClass`, que: (1) carga la tarea con JOIN extendido a Client (phone, address, city); (2) valida requeridos → 422 si faltan; (3) resuelve `nodeCode = customerCity` validando contra `IClassPort.listNodes()`; (4) crea la OS sin `scheduledDate`; (5) guarda `iclassOrderCode` y mueve a "Registrado en IClass". Credenciales y `typeSOSummary` default en `config.ts`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Modelo `FeatureFlag`; campo `iclassOrderCode` en `ScheduledTask` (opcional) |
| `src/domain/ports/` | New | `IClassPort`, `FeatureFlagRepository` |
| `src/domain/errors/` | New | `MissingRequiredFieldsError`, `IClassNodeNotFoundError` |
| `src/application/use-cases/` | New/Modified | `SendTaskToIClass`; hook en `MoveTaskToStage` |
| `src/infrastructure/adapters/iclass/` | New | `IClassClient` (axios + login Bearer) |
| `src/infrastructure/adapters/prisma/` | New | repos de FeatureFlag |
| `src/infrastructure/http/routes/` | New/Modified | endpoint admin de flags; respuesta 422 en move-to-stage |
| `src/infrastructure/http/app.ts` | Modified | wiring DI (⚠️ God Object — minimizar) |
| `src/infrastructure/config.ts` | Modified | `ICLASS_*` env vars |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ciudad no matchea un nodo de IClass → OS falla | Med | Validar contra `listNodes()` y devolver 422 antes de llamar al alta |
| Token de IClass expira | Med | Re-login una vez ante 401 en el client |
| Acoplar use-case a tipos de infra (DIP) | Med | Depender de `IClassPort`, no del client concreto |
| Inflar más `app.ts` | Med | Wiring mínimo, factory aparte si crece |

## Rollback Plan

Apagar el flag `iclass-integration` por API (deja de crear OS, el move-to-stage sigue funcionando). Revertir migración de `FeatureFlag`/`iclassOrderCode` con `prisma migrate` si hace falta. El código nuevo está aislado en `adapters/iclass` y un use-case; sin tocar flujos existentes salvo el hook en `MoveTaskToStage`.

## Dependencies

- API IClass (`https://api-v2.iclass.com.br`), auth Bearer vía `/auth/login`. Skill `iclass-ipnext` documenta endpoints, formatos y gotchas (nodeCode/microárea, sin DELETE).

## Success Criteria

- [ ] Mover tarea válida a "Enviar a IClass" con flag ON crea la OS (sin fecha) y guarda `iclassOrderCode`.
- [ ] Faltando un requerido → 422 con lista `missingFields`, sin crear OS.
- [ ] Ciudad sin nodo válido → 422/error claro, sin crear OS.
- [ ] Flag OFF → mueve stage sin llamar a IClass.
- [ ] Flag toggleable por API y persistente entre reinicios.
- [ ] Tests (TDD) verdes con adapters in-memory; `tsc --noEmit` limpio.
