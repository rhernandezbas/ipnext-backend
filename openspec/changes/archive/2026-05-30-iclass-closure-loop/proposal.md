# Proposal: IClass Closure Loop

> Materializado y archivado 2026-05-30. Store: hybrid (engram + openspec). Companion del research `iclass-closed-os-ingest`.

## Intent

Cerrar el loop con IClass: traer DE VUELTA las Órdenes de Servicio **cerradas** (status 7 / Concluida), espejarlas en la DB, y **mover la tarea local de Prominense** al estado de workflow que el operador mapeó para ese resultado de cierre. Hoy ya enviamos tareas A IClass (`SendTaskToIClass`); esto es la dirección inversa (read path).

## In Scope

- Ingesta por **polling** (IClass v2 no tiene webhooks): `GET /serviceorders` (cluster + ventana fechas) → filtra `status.id === 7`.
- **Join** OS↔tarea por `SO.codigo === ScheduledTask.sequenceNumber` (solo las que enviamos nosotros; las creadas directo en IClass se ignoran).
- Espejo del agregado: SO + history + checklist + materiales + equipos (6 tablas aditivas).
- **Mapping configurable** result-code → Stage (`IClassResultCode.mappedStageId`), administrable desde la UX (igual que `Project.iclassSoTypeId`). Al cerrar, mueve la tarea al stage mapeado; sin mapeo no la mueve.
- Catálogo de result-codes sincronizado desde IClass + endpoints admin (sync/list/assign-stage).
- Scheduler in-process gateado por feature flag `iclass-closure-loop` (default OFF), advisory lock `iclass-closed`, tick configurable.
- Backfill on-demand acotado a tareas en vuelo ("Registrado en IClass").
- FE: subpages "Cierre de OS" (toggle + botón reconciliar) y "Mapeo de resultados".

## Out of Scope

- Fotos y firmas: **no expuestas por la API v2 de IClass** (gap documentado; se marca `photoMissing`). NO scraping de HTML — solo API REST JSON.
- Write-back a IClass. Mapping configurable ciudad→nodo (el envío usa match directo de nombre contra los nodos del tercero).

## Capabilities

- **NEW**: `iclass-closure-loop`.
- **MODIFIED**: `scheduling` (ScheduledTask ↔ IClassServiceOrder; transición de stage disparada por el cierre).

## Approach

Espeja el patrón de los schedulers GR. Port `IClassPort` gana métodos read; adapter parsea JSON (parsers validados contra payloads reales). Use-case `IngestClosedServiceOrders` orquesta list → filtra → matchea → idempotencia (`iclassUpdatedAt`) → fan-out de sub-recursos → arma agregado → upsert + move task. Mapping configurable via catálogo `IClassResultCode`. Scheduler + bootstrap + flag. Backfill reusa `processSummary`.

## Verified facts (recon en vivo)

- Join `codigo↔sequenceNumber` confirmado (OS nuestras tienen codigo chico; las de IClass tienen codigo==id).
- soType id numérico solo aparece en `tipoOs.id` del listado de OS (los endpoints de tipos NO lo exponen) → el sync de result-codes lo descubre desde las OS recientes.
- Result-code `tipo`: Sucesso / Pendente / Improdutiva (no solo Sucesso/Falha) → mapping configurable, no hardcode.
- Fechas `dd-MM-yyyy HH:mm:ss` (BA -03:00); cluster requerido; ventana máx 30 días.
