# Proposal — IClass OS Actions (Fases 2 + 3)

> Change: `iclass-os-actions`
> Construye ENCIMA de la Fase 1 (`iclass-status-sync`, ya en prod): ver el estado de la OS de IClass desde Prominense.
> Fecha: 2026-06-14

## Why

Hoy Prominense **lee** el estado de las Órdenes de Servicio (OS) de IClass (Fase 1: el scheduler captura `iclassStatusCode` en la `ScheduledTask`, hay catálogo `IClassStatusCatalog`). Pero para operar la OS — **cerrarla/validarla** o **asignarle la cuadrilla** — el operador todavía tiene que entrar a IClass. El objetivo del usuario es que **Prominense sea el panel único**.

Cerramos el ciclo con las dos acciones de escritura que faltan:

- **Fase 2 — Cerrar/validar la OS desde Prominense** (`POST /serviceorders/close` a IClass).
- **Fase 3 — Asignar la cuadrilla/técnico desde Prominense** (`POST /serviceorders/update` con `requiredTeam`, alimentado por un catálogo nuevo `IClassTeam` sincronizado desde `GET /teams`).

## What changes

### Fase 2 — Cierre/validación de OS (push)
- `IClassPort`: agregar `getServiceOrder(iclassId)` (pre-check) + `closeServiceOrder(input)`.
- `IClassClient`: implementar ambos sobre `withAuthRetry` (429/401). Mapear errores a `IClassRejectedError`/`IClassUnavailableError`.
- Use case `CloseIClassServiceOrder` con **pre-check** (Approach 4): solo cierra si la tarea está `generalStatus === 'open'` **y** la OS no está ya cerrada en IClass.
- Ruta `POST /api/scheduling/:id/iclass/close` (montada en `scheduling.routes.ts`, mismo patrón que el resend manual).
- UI: botón "Cerrar/Validar OS" en el detalle de tarea → modal con select de result-code (catálogo `IClassResultCode` existente) + comentario + fecha.

### Fase 3 — Asignación de cuadrilla (push)
- Catálogo nuevo `IClassTeam` (entity + port + adapters Prisma/in-memory + use case `SyncIClassTeams`), **mismo patrón que `IClassNode`** (upsert por clave estable, `selectable`, `markInactiveExcept`).
- `IClassPort`: agregar `listTeams()` + `updateServiceOrder(input)` (campo `requiredTeam`).
- `IClassClient`: implementar ambos sobre `withAuthRetry`.
- Use case `AssignIClassTeam` con pre-check (tarea `open`, OS no cerrada).
- Rutas: `POST /api/scheduling/:id/iclass/assign-team` + `GET /api/admin/iclass/teams` (+ `POST /teams/sync`).
- Migración aditiva: tabla `IClassTeam`.
- UI: selector de cuadrilla en el detalle de tarea + página admin de sincronización (clon de la de nodos).

### Permisos (decisión tomada)
Permisos **granulares**, siguiendo el precedente `scheduling.iclass_manual_resend`:
- `scheduling.iclass_close` — gate del cierre (acción **destructiva** del lado IClass).
- `scheduling.iclass_assign` — gate de la asignación de cuadrilla.
- El sync del catálogo de teams reusa `iclass.manage` (mismo gate que el sync de nodos/result-codes/statuses).

### Feature flags (decisión tomada)
Reusar el patrón del flag `iclass-integration` (default OFF, persistido en DB, toggle por `admin.flags`):
- `iclass-close-action` (default **OFF**) — gate de RUNTIME del cierre. Es destructivo del lado IClass y **nunca se probó contra la API real** → arranca apagado, se habilita tras la prueba en vivo.
- `iclass-assign-action` (default **OFF**) — gate de runtime de la asignación.

El feature flag es un **segundo cerrojo** sobre el permiso: aunque el rol tenga `iclass_close`, si el flag está OFF la acción devuelve 403/409 controlado. Permite habilitar masivamente con un toggle sin redeploy una vez validado.

## Impact

- **Affected specs**: nuevo capability `iclass-os-actions`.
- **Affected code (BE)**:
  - `src/domain/ports/IClassPort.ts` (+4 métodos: `getServiceOrder`, `closeServiceOrder`, `listTeams`, `updateServiceOrder`).
  - `src/infrastructure/adapters/iclass/IClassClient.ts` (impl + parsers).
  - `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts` (impl in-memory para tests).
  - `src/domain/entities/iclass-team.ts`, `src/domain/ports/IClassTeamRepository.ts`, adapters Prisma/in-memory.
  - Use cases nuevos: `CloseIClassServiceOrder`, `AssignIClassTeam`, `SyncIClassTeams`, `ListIClassTeams`.
  - DTOs: `iclassServiceOrderAction.dto.ts`, `iclassTeam.dto.ts`.
  - Rutas: `scheduling.routes.ts` (2 acciones), router admin de teams (clon de status/nodes).
  - `app.ts` (wiring), `errorHandler.ts` (códigos nuevos), `prisma/schema.prisma` + migración + seed (flags + permisos).
- **Affected code (FE)**: detalle de tarea (botón cerrar + selector cuadrilla), página admin de teams.
- **Contrato BE↔FE**: aditivo. No rompe endpoints existentes.

## ⚠️ RIESGO CRÍTICO — escrituras a IClass nunca probadas contra la API real

Estas cuatro operaciones (`close`, `update`, `GET serviceorders/{id}`, `teams`) son **ESCRITURAS/lecturas nuevas que NUNCA se ejercitaron contra la API real de IClass**. La investigación documenta que **IClass ya "mintió" 3 veces** respecto de su doc:
1. status codes intermedios opacos / no documentados como enum,
2. cap de paginación real = 20 (no el del spec),
3. filtro `?city=` roto.

Los endpoints `close`/`update`/`GET serviceorders/{id}`/`teams` **pueden comportarse distinto del spec**. El diseño DEBE garantizar:

- **(a) Mapeo de errores con `detail` visible** — patrón #47d/#47g: `IClassRejectedError` (422, con `reason`/`detail` que el FE muestra), `IClassUnavailableError` (502). El operador VE qué dijo IClass, no un 500 mudo.
- **(b) Prueba en vivo controlada ANTES de habilitar masivamente** — feature flag **OFF por default** para cada acción (sobre todo el cierre, destructivo). Plan: con UNA OS/cliente de prueba, ejecutar close + update contra la API real, capturar el shape exacto de la respuesta y de los errores, ajustar parsers, y SOLO entonces flippear el flag.
- **(c) Idempotencia + 429** — toda escritura pasa por `withAuthRetry` (backoff exponencial, 4 reintentos). El pre-check (`generalStatus === 'open'` + OS no cerrada) previene el doble-cierre frente al scheduler de cierre que corre cada 10 min.

## Decisiones tomadas (resumen)

1. **Un solo change, dos olas de implementación.** El design separa Fase 2 (cierre) y Fase 3 (asignación) en olas dependientes: Fase 2 primero (no necesita tabla nueva, valida el patrón de escritura+flag+prueba-en-vivo), Fase 3 después (agrega el catálogo `IClassTeam`). Razón: el riesgo de escritura-no-probada se acota validando UNA acción antes de sumar la segunda + una tabla.
2. **Feature flag por acción**, default OFF (cierre destructivo → imprescindible; asignación → por consistencia y por el mismo riesgo no-probado).
3. **Permisos granulares** `scheduling.iclass_close` / `scheduling.iclass_assign` (no `iclass.manage` genérico): el cierre es destructivo y conviene poder asignarlo a un rol acotado.
4. **Pre-check híbrido**: el guard barato (`generalStatus === 'open'`) sale del cache local (`getTask`); la confirmación de "OS no cerrada en IClass" va **en vivo** vía `getServiceOrder` (frescura > 1 llamada extra, porque el cache `iclassStatusCode` tiene hasta 10 min de lag y el cierre es destructivo — no podemos cerrar a ciegas).
5. **Race scheduler↔acción manual**: el guard `generalStatus !== 'closed'` (mismo que usa `IngestClosedServiceOrders`) + el pre-check en vivo evitan el doble-cierre. Edge case documentado: si el técnico ya cerró en campo con OTRO result-code, el pre-check lo detecta (OS terminal) y aborta con mensaje claro.
