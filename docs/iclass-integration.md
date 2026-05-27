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
| `ICLASS_DEFAULT_SO_TYPE` | `VISITA TECNICA WIRELESS` | tipo de OS fijo aplicado a TODAS las OS (AD-4) |

`ICLASS_BASE_URL` tiene default en código (`https://api-v2.iclass.com.br`) — **no** se pasa por `-e` (un secret vacío sobrescribiría el default con `""`).

> ⚠️ **Sin estos secrets, el factory `buildIClassClient` cae al `InMemoryIClassClient` inerte** (sin nodos) → toda tarea falla con `ICLASS_NODE_NOT_FOUND`. El flag puede estar ON, pero sin secrets no crea nada.

## Cómo activar

1. Cargar los 4 secrets (arriba).
2. Deploy (push a `main`).
3. Prender el flag por API:
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
| Ciudad sin nodo IClass | 422 | `ICLASS_NODE_NOT_FOUND` | — |
| IClass rechazó la OS (validación) | 422 | `ICLASS_REJECTED` | `reason` (detalle del `erros` de IClass) |
| IClass caído / 5xx / sin conexión | 502 | `ICLASS_UNAVAILABLE` | — |

> `ICLASS_REJECTED` ≠ `ICLASS_UNAVAILABLE`: el primero es un problema de **datos** (IClass devolvió `erros`); el segundo es IClass **no disponible** (transporte/5xx). El front muestra el `reason` en el modal.

## Arquitectura (dónde vive cada cosa)

| Pieza | Archivo |
|-------|---------|
| Puerto | `src/domain/ports/IClassPort.ts` |
| Errores dominio | `src/domain/errors/iclass.ts` (`IClassNodeNotFoundError`, `IClassUnavailableError`, `IClassRejectedError`) |
| Use-case | `src/application/use-cases/SendTaskToIClass.ts` |
| Hook de disparo | `src/application/use-cases/MoveTaskToStage.ts` (delega si el stage destino es "Enviar a IClass") |
| Adapter real | `src/infrastructure/adapters/iclass/IClassClient.ts` (axios, login Bearer, re-login en 401, cache de nodos) |
| Adapter in-memory (tests) | `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts` |
| Factory (real vs in-memory) | `src/infrastructure/http/iclass.factory.ts` |
| Config | `src/infrastructure/config.ts` (`config.iclass`) |
| Feature flag | tabla `FeatureFlag`, repos + `/api/admin/feature-flags` |

Frontend (repo `ipnext-frontend`): `IClassSendResultModal` + `useIClassSendFeedback` manejan los 4 códigos de error y el toast de éxito con `iclassOrderCode`.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| `ICLASS_NODE_NOT_FOUND` para una ciudad que existe | secrets `ICLASS_*` no cargados → cliente in-memory sin nodos | cargar secrets + redeploy |
| `ICLASS_NODE_NOT_FOUND` para ciudad rara | la localidad del cliente no matchea ningún nodo | corregir la localidad o crear el nodo en IClass |
| `ICLASS_REJECTED` con `ICLERR_xxxx` | IClass rechazó el payload | leer el `reason`; revisar datos del cliente/tarea |
| `ICLASS_UNAVAILABLE` (502) | IClass caído o el container no llega a IClass | verificar IClass + egress del container; reintentar |
| Nada pasa al mover el stage | flag `iclass-integration` OFF | prender el flag por API |
</content>
