# Proposal: Mapeo Project → IClass SO Type

## Intent

Hoy todas las tareas que se envían a IClass se dan de alta como **"VISITA TECNICA WIRELESS"**, sin importar el tipo de trabajo real (instalación, reparación, retiro, cableado, fibra, etc.). Queremos que el tipo de Orden de Servicio en IClass se derive **deterministamente del Project** al que pertenece la tarea, con un mapeo 1:1 `Project → IClassSoType`. Para eso introducimos un catálogo cacheado de tipos de SO sincronizado desde la API de IClass, ligamos cada Project a un tipo de ese catálogo, y eliminamos el fallback por env var (`ICLASS_DEFAULT_SO_TYPE`) — si un Project no tiene mapeo, el envío falla con error claro.

## Why now

`IClassClient.createServiceOrder` envía `typeSOSummary = config.iclassDefaultSoType` (= `"VISITA TECNICA WIRELESS"`) en **todas** las OS creadas. Esto rompe los reportes y la asignación de cuadrillas del lado de IClass: en el panel real existen **26 tipos distintos** de SO para el thirdParty IPNX (id `6808841`) y todos los trabajos terminan clasificados como el mismo. La operación reclama esta diferenciación y, a la vez, el equipo decidió eliminar el fallback silencioso por env var para evitar más mal-clasificación.

## Scope

### In Scope
- Modelo `IClassSoType` en DB (catálogo cacheado: `id`, `code`, `description`, `active`, `syncedAt`, `thirdPartyId`).
- Endpoint admin `POST /api/admin/iclass/so-types/sync` que llama a `GET /thirdparties/{thirdPartyId}/serviceorders/types`, hace upsert por `code` y marca `active: false` los que no vienen.
- Endpoint admin `GET /api/admin/iclass/so-types?active=true` para consumir desde el FE (dropdown).
- FK opcional `iclassSoTypeId` en `Project`, expuesta vía `PATCH /api/projects/:id`.
- `SendTaskToIClass` resuelve `soType` desde `task.project.iclassSoType.code` — fail-fast si Project no existe o no tiene mapeo.
- Nuevos errores de dominio: `MissingProjectForIClassError`, `MissingIClassMappingError(projectTitle)`.
- Eliminación de `ICLASS_DEFAULT_SO_TYPE` del config, env.example, workflow de deploy y del campo `defaultSoType` en `IClassClient`.
- Extensión del port `IClassPort.listSoTypes(thirdPartyId)` y firma de `createServiceOrder` aceptando `soType` explícito.

### Out of Scope
- Auto-sync periódico del catálogo (sync es **manual** vía endpoint admin; cron queda para otra iteración).
- Override del tipo de SO en el modal "Enviar a IClass" — decisión cerrada: 100% determinístico desde el Project.
- Reverso: editar tipos de SO desde el backend (IClass es source of truth, solo se cachea).
- UI del admin de sync ni del dropdown en Project — esta change habilita el contrato; el FE va aparte.
- Backfill automático de Projects existentes — el equipo decide manualmente qué mapeo aplicar a cada uno.

## Capabilities

### New Capabilities
- `iclass-so-type-catalog`: catálogo cacheado de tipos de SO de IClass, sync manual desde la API, listado activo para consumo del FE.

### Modified Capabilities
- `iclass-integration`: `createServiceOrder` recibe `soType` como input explícito; se elimina el default por env var; se agrega `listSoTypes` al port y al client.
- `scheduling`: `Project` tiene FK opcional `iclassSoTypeId`; `SendTaskToIClass` resuelve el tipo desde el Project y falla con error tipado si falta mapeo o el Project no existe; `PATCH /api/projects/:id` acepta `iclassSoTypeId`.

## Approach

1. **Catálogo**: nueva tabla `IClassSoType` cacheada en DB. Sync manual (endpoint admin) llama a IClass, hace upsert por `code` y marca `active: false` los códigos que ya no aparecen (soft-delete — preservamos referencias históricas de Projects).
2. **Mapeo**: FK nullable `Project.iclassSoTypeId → IClassSoType.id`. La nullabilidad es porque la sincronización del catálogo y el mapeo por Project se hacen en momentos distintos.
3. **Resolución determinística**: `SendTaskToIClass` carga `task.project.iclassSoType` (JOIN), valida que existan ambos, y pasa el `code` al port. Si `task.projectId` es null → `MissingProjectForIClassError`. Si `project.iclassSoTypeId` es null → `MissingIClassMappingError(project.title)`.
4. **Fail-fast**: eliminamos `defaultSoType` del `IClassClient` y `iclassDefaultSoType` de `config.ts`. La firma de `IClassPort.createServiceOrder` exige `soType` como campo del input, no es opcional. El compilador previene el olvido.
5. **DIP**: ningún use case toca Prisma; `IClassSoTypeRepository` es un nuevo port con adapter Prisma + in-memory.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Nuevo modelo `IClassSoType`; `Project.iclassSoTypeId` (FK nullable) + relación |
| `src/domain/ports/IClassPort.ts` | Modified | `soType` en input de `createServiceOrder`; nuevo `listSoTypes` |
| `src/domain/ports/` | New | `IClassSoTypeRepository` |
| `src/domain/errors/` | New | `MissingProjectForIClassError`, `MissingIClassMappingError` |
| `src/application/use-cases/SendTaskToIClass.ts` | Modified | Resuelve soType desde `task.project.iclassSoType` |
| `src/application/use-cases/` | New | `SyncIClassSoTypes`, `ListIClassSoTypes`, `UpdateProjectIClassMapping` (o extensión de `UpdateProject`) |
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modified | Quitar `defaultSoType`; agregar `listSoTypes`; `createServiceOrder` recibe `soType` |
| `src/infrastructure/adapters/prisma/` | New | `PrismaIClassSoTypeRepository` |
| `src/infrastructure/adapters/in-memory/` | New | `InMemoryIClassSoTypeRepository` |
| `src/infrastructure/http/routes/` | New/Modified | Admin sync + list de soTypes; `PATCH /projects/:id` con `iclassSoTypeId` |
| `src/infrastructure/http/iclass.factory.ts` | Modified | No pasar `defaultSoType` |
| `src/infrastructure/config.ts` | Modified | Quitar `iclassDefaultSoType` |
| `env.example`, `.github/workflows/deploy.yml` | Modified | Quitar `ICLASS_DEFAULT_SO_TYPE` |
| `docs/iclass-integration.md` | Modified | Reflejar nuevo flujo |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Projects existentes sin mapeo → envíos a IClass fallan tras el deploy | High | Comunicar al equipo de operaciones antes del deploy; preparar checklist de mapeo manual; ofrecer un script SQL/admin para asignar el mapeo más común a granel |
| Orden de deploy: si se quita la env var antes de aplicar la migración, el server no levanta | Med | Migración + código nuevo + remoción de env var deben ir en el **mismo deploy**; el config no valida la env var que ya no existe |
| Sync llama a IClass con thirdPartyId equivocado | Low | El thirdPartyId vive en config (ya existe), no se hardcodea en el use case; test con stub del port |
| Soft-delete (`active: false`) de un tipo que algún Project sigue referenciando | Med | El FK queda válido (no cascade); el endpoint `GET ?active=true` excluye inactivos del dropdown FE pero el envío sigue funcionando con el código viejo; documentar |
| Token IClass expira durante sync | Low | El client ya maneja re-login en 401 (heredado de change anterior) |

## Frontend Implications

Esta change habilita (no diseña) lo siguiente del lado del FE:

- **Página admin de IClass SO Types**: botón "Sincronizar desde IClass" (POST al endpoint de sync), tabla del catálogo con `code`, `description`, `active`, `syncedAt`.
- **Edición de Project**: dropdown "Tipo de SO en IClass" en el formulario de Project, poblado por `GET /api/admin/iclass/so-types?active=true`. Permite limpiar (null) además de seleccionar.
- **Lista de Projects**: badge o columna mostrando el `iclassSoType.description` (o "Sin mapeo" si null) para que el operador vea de un vistazo cuáles Projects están listos para enviar a IClass.
- **Modal "Enviar a IClass"**: render de los nuevos códigos de error:
  - `MISSING_PROJECT_FOR_ICLASS` → "La tarea no tiene Project asignado. Asigná un Project antes de enviar a IClass."
  - `MISSING_ICLASS_MAPPING` (con `projectTitle` en el payload) → "El Project «{title}» no tiene mapeo a IClass. Configurá su tipo de SO en la edición del Project."
- **Permisos**: los endpoints `/api/admin/iclass/*` requieren rol admin (igual que el resto de `/admin`).

## Rollback Plan

La FK es nullable y el catálogo es aditivo. Para rollback:
1. Revertir el código a la versión previa (que usa la env var).
2. Restaurar `ICLASS_DEFAULT_SO_TYPE` en el deploy.
3. Las columnas y tabla nuevas pueden quedarse en DB sin afectar (no las usa nadie); o revertir migración con `prisma migrate resolve` si se quiere limpieza total.

Mientras el catálogo esté vacío o ningún Project tenga mapeo, **todas las llamadas a "Enviar a IClass" fallarán** — esto es deliberado (fail-fast), pero implica que el rollout requiere mapear al menos los Projects activos antes de habilitar a usuarios.

## Dependencies

- API IClass `GET /thirdparties/{thirdPartyId}/serviceorders/types` — ya documentada en skill `iclass-ipnext`. Verificada: 26 tipos para thirdPartyId `6808841`.
- Change previa `task-send-to-iclass` (archivada `2026-05-27`) provee el `IClassPort` y `IClassClient` base que vamos a extender.

## Success Criteria

- [ ] `POST /api/admin/iclass/so-types/sync` puebla la tabla con los 26 tipos (upsert idempotente).
- [ ] `GET /api/admin/iclass/so-types?active=true` devuelve solo los activos.
- [ ] `PATCH /api/projects/:id` con `iclassSoTypeId` válido persiste el mapeo; con `null` lo limpia; con id inexistente devuelve 400/404.
- [ ] `SendTaskToIClass` con `task.project.iclassSoType` válido envía el `code` correcto a IClass.
- [ ] `SendTaskToIClass` sin Project → 422/400 con `MissingProjectForIClassError`.
- [ ] `SendTaskToIClass` con Project sin mapeo → 422/400 con `MissingIClassMappingError` y `projectTitle` en payload.
- [ ] `ICLASS_DEFAULT_SO_TYPE` no aparece en código, env.example ni workflow.
- [ ] Tests (TDD) verdes con adapters in-memory; `tsc --noEmit` limpio.
