# Integración IClass — Runbook

> Crear Órdenes de Servicio (OS) en **IClass FS** cuando una tarea de scheduling pasa al stage **"Enviar a IClass"**. Última actualización: 2026-05-27.

## Qué hace

Al mover una tarea al stage **"Enviar a IClass"** (`PATCH /api/scheduling/:id/stage`):

1. Si el feature flag `iclass-integration` está **OFF** → solo mueve el stage (no toca IClass).
2. Si está **ON** → valida campos requeridos, resuelve el nodo por ciudad, crea la OS en IClass **sin fecha** (el técnico y la fecha los asigna una persona en IClass), guarda `iclassOrderCode` en la tarea y la mueve a **"Registrado en IClass"**.

Skill con la API documentada: `iclass-ipnext` (endpoints, auth, gotchas).

## Configuración (OBLIGATORIA para que funcione)

La integración necesita estos **GitHub Secrets** (repo Settings → Secrets → Actions), inyectados al container en `.github/workflows/deploy.yml` con `-e`:

| Secret | Ejemplo | Notas |
|--------|---------|-------|
| `ICLASS_USERNAME` | `IPNXAPI` | usuario de la API IClass |
| `ICLASS_PASSWORD` | `********` | password (rotar si se filtró) |
| `ICLASS_THIRD_PARTY_ID` | `6808841` | tercero (credenciada) IPNX — de aquí salen los nodos |

`ICLASS_BASE_URL` tiene default en código (`https://api-v2.iclass.com.br`) — **no** se pasa por `-e` (un secret vacío sobrescribiría el default con `""`).

> **`ICLASS_DEFAULT_SO_TYPE` fue eliminado.** El tipo de OS ya no es global ni fijo. Cada `Project` tiene su propio mapeo vía `iclassSoTypeId` (tabla `IClassSoType`). El catálogo se sincroniza con `POST /api/admin/iclass/so-types/sync` y se asigna a cada Project vía `PATCH /api/projects/:id { iclassSoTypeId }`. Ver [Procedimiento de rollout](#procedimiento-de-rollout) abajo.

> ⚠️ **Sin estos secrets, el factory `buildIClassClient` cae al `InMemoryIClassClient` inerte** (sin nodos) → toda tarea falla con `ICLASS_NODE_NOT_FOUND`. El flag puede estar ON, pero sin secrets no crea nada.

## Cómo activar

1. Cargar los 3 secrets de arriba (`ICLASS_USERNAME`, `ICLASS_PASSWORD`, `ICLASS_THIRD_PARTY_ID`).
2. Deploy (push a `main`). CI aplica la migración antes de levantar el código nuevo.
3. Seguir el [Procedimiento de rollout](#procedimiento-de-rollout) completo antes de prender el flag.
4. Prender el flag por API **solo después** de mapear todos los Projects activos:
   ```
   PATCH /api/admin/feature-flags/iclass-integration  { "enabled": true }
   ```
   (auth de admin; persistente en DB).

## Campos requeridos de la tarea

Para enviar a IClass la tarea debe tener: **nombre del cliente, teléfono, dirección, ciudad, descripción**.
- `customerName` / `phone` / `city` salen del `Client` (vía `customerId`).
- `address` / `description` salen de la tarea.

Si falta alguno → `422 MISSING_REQUIRED_FIELDS` con `missingFields: [...]` (el front muestra un modal). NO se crea OS ni se mueve la tarea.

## Decisiones clave / gotchas (aprendidas en producción)

- **`customerCode` = `grClienteId ?? splynxId ?? login`** — NO el `id` (UUID). IClass limita la longitud de `codigoCliente`/`codigoOS`; un UUID (36 chars) da `ICLERR_0045`/`ICLERR_0050`.
- **`soCode` / `addressCode` = `task.sequenceNumber`** (ej. `4274`) — corto y correlaciona la OS de IClass con la tarea del backend.
- **`nodeCode` = ciudad del cliente** (`customerCity`), validada contra los nodos de IClass (`GET /thirdparties/{id}/nodes`). El match es **case-insensitive y accent-insensitive** (`Luján` ≡ `Lujan`). Si la ciudad no matchea ningún nodo → `422 ICLASS_NODE_NOT_FOUND`. Los nodos se llaman como las localidades (Mercedes, Chivilcoy, Lujan, CABA, …).
- **OS sin `scheduledDate`** — la fecha y el técnico los asigna una persona en IClass.
- **Idempotencia**: si la tarea ya tiene `iclassOrderCode`, NO se recrea la OS.
- **IClass NO tiene DELETE** por API. Una OS creada por error queda en la cola real. Cerrarla por API está **bloqueado por encuestas obligatorias** (es flujo de la app móvil del técnico).

## Códigos de error (capa HTTP)

| Situación | HTTP | `code` | Body extra |
|-----------|------|--------|------------|
| Faltan requeridos | 422 | `MISSING_REQUIRED_FIELDS` | `missingFields[]` |
| Tarea sin Project asignado | 422 | `MISSING_PROJECT_FOR_ICLASS` | — |
| Project sin tipo de OS mapeado | 422 | `MISSING_ICLASS_MAPPING` | `projectTitle` |
| Ciudad sin nodo IClass | 422 | `ICLASS_NODE_NOT_FOUND` | — |
| IClass rechazó la OS (validación) | 422 | `ICLASS_REJECTED` | `reason` (detalle del `erros` de IClass) |
| IClass caído / 5xx / sin conexión | 502 | `ICLASS_UNAVAILABLE` | — |

> `ICLASS_REJECTED` ≠ `ICLASS_UNAVAILABLE`: el primero es un problema de **datos** (IClass devolvió `erros`); el segundo es IClass **no disponible** (transporte/5xx). El front muestra el `reason` en el modal.

## Arquitectura (dónde vive cada cosa)

| Pieza | Archivo |
|-------|---------|
| Puerto principal | `src/domain/ports/IClassPort.ts` |
| Puerto catálogo | `src/domain/ports/IClassSoTypeRepository.ts` |
| Errores dominio | `src/domain/errors/iclass.ts` |
| Entidad catálogo | `src/domain/entities/iclass-so-type.ts` |
| Use-case envío | `src/application/use-cases/SendTaskToIClass.ts` |
| Use-case sync catálogo | `src/application/use-cases/SyncIClassSoTypes.ts` |
| Use-case listar catálogo | `src/application/use-cases/ListIClassSoTypes.ts` |
| Use-case asignar tipo a Project | `src/application/use-cases/AssignIClassSoTypeToProject.ts` |
| Hook de disparo | `src/application/use-cases/MoveTaskToStage.ts` (delega si el stage destino es "Enviar a IClass") |
| Adapter real | `src/infrastructure/adapters/iclass/IClassClient.ts` (axios, login Bearer, re-login en 401, cache de nodos) |
| Adapter Prisma catálogo | `src/infrastructure/adapters/prisma/PrismaIClassSoTypeRepository.ts` |
| Adapter in-memory (tests) | `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts` |
| Factory (real vs in-memory) | `src/infrastructure/http/iclass.factory.ts` |
| Rutas admin catálogo | `src/infrastructure/http/routes/iclass-admin.routes.ts` (`POST /api/admin/iclass/so-types/sync`, `GET /api/admin/iclass/so-types`) |
| Config | `src/infrastructure/config.ts` (`config.iclass`) |
| Feature flag | tabla `FeatureFlag`, repos + `/api/admin/feature-flags` |

Frontend (repo `ipnext-frontend`): `IClassSendResultModal` + `useIClassSendFeedback` manejan los códigos de error y el toast de éxito con `iclassOrderCode`.

## Procedimiento de rollout

> Este procedimiento es **OBLIGATORIO** luego de desplegar esta PR por primera vez (o al hacerlo en un ambiente nuevo). El flag `iclass-integration` debe permanecer **OFF** hasta completar todos los pasos.

### Antes de activar el flag

1. **Verificar migración aplicada** — CI ejecuta `prisma migrate deploy` antes de levantar el código; confirmar en los logs de GitHub Actions que completó sin errores. La migración crea la tabla `IClassSoType` y agrega la columna nullable `Project.iclassSoTypeId`.

2. **Sincronizar el catálogo de tipos de OS**:
   ```
   POST /api/admin/iclass/so-types/sync
   Authorization: Bearer <admin-token>
   ```
   Respuesta esperada: `{ synced: N, created: N, updated: 0, reactivated: 0, deactivated: 0 }` con `N` ≈ 26 tipos activos.

3. **Ver el catálogo disponible**:
   ```
   GET /api/admin/iclass/so-types?active=true
   Authorization: Bearer <admin-token>
   ```
   Devuelve `{ items: [{ id, code, description, active, ... }] }`. Anotar los `id` de los tipos relevantes por Project.

4. **Mapear cada Project activo** — para cada Project que vaya a usar "Enviar a IClass":
   ```
   PATCH /api/projects/:id
   { "iclassSoTypeId": "<id-del-tipo>" }
   ```
   Confirmar que la respuesta incluye `iclassSoType: { code: "...", ... }` (no `null`).

5. **Verificar que todos los Projects activos están mapeados** — `GET /api/projects` y revisar que ningún Project que use IClass tenga `iclassSoType: null`.

### Activar el flag

```
PATCH /api/admin/feature-flags/iclass-integration  { "enabled": true }
Authorization: Bearer <admin-token>
```

### Verificación post-activación

6. Mover una tarea de prueba al stage "Enviar a IClass" desde el front. Confirmar que la OS se crea en IClass y que la tarea queda en "Registrado en IClass" con `iclassOrderCode` poblado.

> **Si un Project activo no tiene mapeo cuando el flag está ON**, la llamada fallará con `422 MISSING_ICLASS_MAPPING`. Esto NO revierte el stage — la tarea queda en "Enviar a IClass" y se puede reintentar luego de mapear el Project.

### Rollback

La migración es aditiva (tabla nueva + columna nullable). Para rollback de código: hacer `git revert` y redeploy. Las columnas/tabla nuevas no afectan el código viejo. El secret `ICLASS_DEFAULT_SO_TYPE` debe ser **eliminado** de GitHub Secrets y EasyPanel — ya no se lee en ningún lugar.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| `ICLASS_NODE_NOT_FOUND` para una ciudad que existe | secrets `ICLASS_*` no cargados → cliente in-memory sin nodos | cargar secrets + redeploy |
| `ICLASS_NODE_NOT_FOUND` para ciudad rara | la localidad del cliente no matchea ningún nodo | corregir la localidad o crear el nodo en IClass |
| `MISSING_PROJECT_FOR_ICLASS` (422) | la tarea no tiene Project asignado | asignar un Project a la tarea antes de enviar |
| `MISSING_ICLASS_MAPPING` (422) | el Project de la tarea no tiene `iclassSoTypeId` | ejecutar `PATCH /api/projects/:id { iclassSoTypeId }` |
| `ICLASS_REJECTED` con `ICLERR_xxxx` | IClass rechazó el payload | leer el `reason`; revisar datos del cliente/tarea |
| `ICLASS_UNAVAILABLE` (502) | IClass caído o el container no llega a IClass | verificar IClass + egress del container; reintentar |
| Nada pasa al mover el stage | flag `iclass-integration` OFF | completar el rollout procedure y prender el flag |
</content>
