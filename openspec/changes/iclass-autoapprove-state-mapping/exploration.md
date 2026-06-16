# Exploration: iclass-autoapprove-state-mapping

> SDD explore. 2026-06-15. Híbrido (engram `sdd/iclass-autoapprove-state-mapping/explore` + este archivo).
> Scope CERRADO por el usuario: 2 cosas, ambas sobre el scheduler `IngestClosedServiceOrders` que ya pollea IClass.

## Current State

- **El scheduler ya ve TODAS las OS**, no solo cerradas: `IngestClosedServiceOrders.ts:172` llama `this.iclass.listServiceOrders({updatedDateBegin, updatedDateEnd})` SIN filtro de estado. El filtro a terminal es post-fetch (`:241` `statusCode !== '7' → skip`).
- **La captura de estado ya corre para TODOS los estados** (iclass-status-sync), ANTES del guard terminal (`:214-239`): hace upsert al catálogo + `setIClassStatus(taskId, statusCode)` en la tarea.
- **El cierre con '7' ya funciona** (#41): mueve la tarea a un stage (mapeo result-code→stage, `:344-364`) + setea `generalStatus='closed'`.
- **Ya existe `closeServiceOrder`** (port `IClassPort.ts:174`, adapter `IClassClient.ts:430` → `POST /serviceorders/close`), con manejo de rate-limit-200 ("Espere um pouco", `:441`) y un **TODO sin resolver** (`:428`: "confirmar el token de éxito real en la prueba en vivo §10").
- **Los 3 bootstraps** (`bootstrapTaskAutocomplete/IClassClosure/Backfill`) inyectan el `statusCatalog` al scheduler — los 3, verificado.
- **`ScheduledTask`** tiene: `generalStatus` ('open'|'closed'|'dismissed', lifecycle), `stageId`/`stageCategory` (workflow stages = columnas kanban), `iclassStatusCode`/`iclassStatus` (estado IClass capturado + JOIN al catálogo para label/color/tracked).
- **`IClassStatusCatalog`** (tabla `20260724`): `statusCode` (unique), `iclassLabel`, `displayLabel`, `color`, `tracked`. **HOY es solo visual — NO mapea a ningún estado de Prominense.**

## Resolución del unknown (a) — ¿con qué endpoint se "aprueba"?

**Bajé el OpenAPI. NO existe endpoint de "approve"/"aprovar"/"encerrar".** Los únicos writes de OS son: `POST /serviceorders/close` (CloseSOIn: serviceOrderCode, resultCode, closeDate, commentary), `POST /serviceorders/update` (UpdateSOIn: schedule/materials/procedures/etc — NO tiene campo de status), `PATCH /serviceorders/comment`.

**Conclusión**: la ÚNICA vía API para avanzar una OS a `'7'` ENCERRADO es `POST /serviceorders/close`. O sea, "auto-aprobar" = llamar al `closeServiceOrder` que YA existe (Fase 2), con el `resultCode` mapeado desde `motivoFechamento`.

⚠️ **PERO queda un riesgo DURO sin confirmar (unknown b)**: no sabemos si `close` FUNCIONA sobre una OS que ya está en `FECHADA('4')`/`APROVAÇÃO('50')` (el técnico ya la cerró en campo). Puede dar "ya cerrada" o requerir otro verbo que la API no expone. El §10 (prueba en vivo del write, flag OFF) NUNCA se corrió. **Si `close` no avanza desde '4', cosa 1 vía API queda BLOQUEADA** (habría que resolverlo por config de IClass o seguir aprobando manual). Es el gate #1.

## Resolución del unknown (c) — "estado mío"

`ScheduledTask` ya tiene **Stage** (workflow stages / columnas del kanban) — ese ES el "estado propio" de Prominense que el operador ya ve. Y ya existe un mecanismo de mover stage (result-code→stage en el cierre). **Recomendación: mapear estado IClass → Stage existente**, NO inventar un set de estados nuevo. `generalStatus` (open/closed/dismissed) queda intacto.

## Affected Areas

- `src/application/use-cases/IngestClosedServiceOrders.ts` — hook de auto-aprobación (cosa 1) + aplicar mapeo estado→stage (cosa 2), en el bloque de captura `:214-239`.
- `src/domain/ports/IClassPort.ts` + `IClassClient.ts` — reusar `closeServiceOrder` (cosa 1); `getServiceOrder` para pre-check si hace falta.
- `src/domain/entities/iclass-status-catalog.ts` + repo + migración nueva — agregar `prominenseStageId` (FK nullable a Stage) al catálogo (cosa 2).
- `src/domain/entities/scheduling.ts` — Stage ya existe; sin cambio de modelo salvo el mapeo.
- Los 3 `bootstrap*.ts` — cablear lo nuevo en los 3 (lección "feature muerta") + composition test.
- IClassResultCode (catálogo existente) — para mapear `motivoFechamento` (texto) → `resultCode` (cosa 1).
- FE (repo aparte): columna "Stage de Prominense" en el ABM del catálogo de estados (cosa 2); ningún cambio para cosa 1 (es automático).

## Approaches

### Cosa 1 — Auto-aprobar
1. **Hook en el scheduler (RECOMENDADO)** — en `processSummary`, cuando `statusCode==='4'` (FECHADA) + tarea `open` + flag ON + `resultCode` resoluble desde `motivoFechamento`, llamar `closeServiceOrder`. El siguiente tick ve `'7'` y dispara el cierre/stage-move que YA existe. Reusa todo. Efecto: Medio. Contra: writes dentro del poll-loop × 3 bootstraps → idempotencia + rate-limit + concurrencia (guards fuertes + composition test).
2. **Job separado** que liste OS en `'4'` y las cierre. Más aislado, pero infra nueva. Efecto: Medio-Alto.

### Cosa 2 — Estado IClass → Stage de Prominense
1. **`prominenseStageId` en el catálogo + aplicar en la captura (RECOMENDADO)** — agregar la columna; en `:214-239`, si la row del statusCode tiene `prominenseStageId` y el status cambió, mover el `stageId` de la tarea. Reusa el catálogo (ya sincronizado, una row por estado) + el stage-move existente. Efecto: Bajo-Medio. Política a definir: ¿auto-mueve siempre, o respeta un move manual del operador?

## Recommendation

- **Cosa 2 primero / en paralelo**: bajo riesgo, read-side + columna de mapeo + stage-move. No depende del write a IClass. Lista para proposal.
- **Cosa 1 GATEADA por el §10**: antes de diseñar el auto-cierre en serio, hay que correr la prueba en vivo del write (cerrar una OS de PRUEBA que esté en FECHADA y ver si `close` la avanza a `'7'`). Es escritura → la decide/dispara el usuario. Si pasa, cosa 1 = hook en el scheduler reusando `closeServiceOrder`. Si falla, cosa 1 vía API queda bloqueada (escalar a IClass / config).

## Risks

- **(DURO) Cosa 1**: no hay endpoint approve; `close`-desde-'4' sin confirmar (§10). Puede bloquear cosa 1 entera.
- **Cosa 1**: `motivoFechamento` poblado en FECHADA ('4') sin confirmar (en EM ANALISE es null; no hubo OS en '4' viva para sondear). Sin él, no hay `resultCode` que mandar.
- **Cosa 1**: writes automáticos en el poll-loop × 3 bootstraps → idempotencia/concurrencia/rate-limit. Composition test obligatorio.
- **Cosa 2**: el auto-stage-move puede pelearse con moves manuales del operador → definir política.
- `motivoFechamento` es TEXTO, no código → el mapeo a `resultCode` vía IClassResultCode puede no matchear 1-a-1 (revisar cobertura del catálogo).

## Ready for Proposal

**Sí para cosa 2** (clara, baja dependencia). **Cosa 1: condicional al §10** — recomiendo correr la prueba de escritura en vivo ANTES de comprometer el diseño del auto-cierre, porque puede bloquearla. Decisión del usuario: ¿corremos el §10 ahora (con una OS de prueba), o avanzamos el proposal de cosa 2 y dejamos cosa 1 detrás del gate?
