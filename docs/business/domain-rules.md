# Reglas de negocio observadas

Reglas inferidas del código (no de un documento de requerimientos). Cada una cita
su fuente.

## Clientes

### Estados de cliente (enum local `ClientStatus`)

`active` · `late` · `blocked` · `inactive` (modelo `Client`).

### Mapeo de estado GR → estado local

Los estados de Gestión Real (códigos) se traducen al enum local en
`PrismaClientMirrorRepository.mapStatus`:

| Código GR | Estado GR | → Estado local |
|:---------:|-----------|:--------------:|
| `1` | Activo | `active` |
| `2` | Deudor | `late` |
| `4` | Incobrable | `blocked` |
| `3` | Inactivo | `inactive` |
| `6` | Baja | `inactive` |
| (otro) | — | `inactive` (default) |

### Qué estados se sincronizan

Por defecto solo `1` (Activo) y `2` (Deudor) — `GR_SYNC_ESTADOS=1,2`. Configurable
por env. Los demás estados no se traen salvo que se los agregue al flag.

### Identidad y coexistencia

- `Client.grClienteId` y `Service.grContratoId` son `@unique` pero **nullable**:
  filas de otros orígenes (Splynx) conviven con las de GR sin colisión.
- El upsert del mirror es por la business key externa: existe → update, no existe →
  create. Nunca duplica.
- `login` es `@unique` requerido; como GR no provee uno, el mirror lo sintetiza
  como `gr:{grClienteId}`.
- Si `name` viene vacío de GR, se usa `Cliente {grClienteId}` como fallback.

## Contratos / Servicios

- Un contrato GR siempre pertenece a un cliente; el upsert resuelve el padre por
  `grClienteId`. **Si el padre no existe, el contrato se descarta** (no-op): el
  sync de clientes corre siempre antes que el de contratos.
- Fallbacks al espejar: `plan` → `"Sin plan"`, `status` → `"active"`,
  `startDate` → fecha actual si GR no la trae o es inparseable.
- De las `conexiones` de un contrato GR se extrae el **primer** username PPPoE
  (`firstPppoeUser`).
- Los contratos GR se piden con `incluye_bajas: 'S'` (se traen también los dados
  de baja).

## Sincronización (delta)

- **Primer run** sin watermark → backfill completo. **Runs siguientes** → delta
  por fecha de modificación (`fecha_tipo=m`).
- El delta de GR es de **granularidad diaria**; el sync re-escanea el último día
  (overlap intencional) apoyándose en la idempotencia para no perder cambios del
  mismo día.
- En **backfill** solo se traen contratos de clientes recién creados; en **delta**,
  de todos los clientes tocados. (Detalle en
  [TDR 0001](../tdr/0001-gestion-real-sync-design.md).)
- Si un sync falla a mitad, el watermark **no avanza** y el run se reintenta desde
  donde estaba.

## Tareas (ScheduledTask)

- Una tarea **siempre** pertenece a una `Stage` (FK `stageId` obligatoria,
  `onDelete: Restrict` — no se puede borrar una stage con tareas).
- `category` y `priority` se guardan como **texto libre**, validados contra los
  catálogos editables `TaskCategory` / `TaskPriority` (no son FKs).
- `sequenceNumber` es autoincremental y único (número visible de la tarea).
- Mover de stage y cambiar status pasan por `MoveTaskToStage` /
  `UpdateTaskStatus`, que validan la stage destino contra `StageRepository`.
- Varios campos están `@deprecated` (`assignedTo`, `clientId`, `status`,
  `scheduledDate`/`scheduledTime`): conviven con sus reemplazos durante la
  migración. **Deuda técnica explícita** marcada en el propio schema.

## Workflows y stages

- Existe un **workflow default protegido** (errores `DEFAULT_WORKFLOW_PROTECTED`,
  `WORKFLOW_IN_USE`, `STAGE_IN_USE` en el error handler de `app.ts`).
- No se puede borrar un workflow o una stage en uso (devuelve 409 Conflict).
- Nombres de workflow y stage no pueden colisionar (`*_NAME_CONFLICT` → 409).
- Las stages tienen `order` y `color` editable por workflow.

## Mapeo de errores de dominio → HTTP

El error handler global en `app.ts` traduce `DomainError.code` a status:

| Familia de código | Status |
|-------------------|:------:|
| `*_NOT_FOUND` (client, ticket, task, stage, workflow…) | 404 |
| `AUTHENTICATION_ERROR` | 401 |
| `SPLYNX_UNAVAILABLE` | 502 |
| `*_CONFLICT`, `*_PROTECTED`, `*_IN_USE` | 409 |
| `REORDER_SET_MISMATCH` | 400 |
| Otro `DomainError` | 400 (default) |
| No-`DomainError` (inesperado) | 500 |

## Resiliencia operativa

- El server **no muere** ante un `unhandledRejection` / `uncaughtException` (ej.
  Splynx caído en una ruta async): se loguea y se sigue sirviendo (`main.ts`).
- El sync GR vive detrás de `GR_SYNC_ENABLED`; apagado, el sistema se comporta
  igual que antes del mirror (ver
  [ADR 0005](../adr/0005-in-process-scheduler-behind-flag.md)).
