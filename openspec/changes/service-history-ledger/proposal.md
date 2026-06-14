# service-history-ledger (#110)

## Why
El "Historial de servicios" del contrato (#73, `GET /api/contracts/:contractId/service-history`) muestra UNA fila por servicio con su estado ACTUAL (`status`) + `createdAt` (alta) + `deactivatedAt` (última baja). La tabla `ContractService` tiene `@@unique([contractId, serviceCatalogId])`: hay UNA sola fila por (contrato, servicio). Cuando un servicio se da de baja y se reactiva, `status` vuelve a `active` y `deactivatedAt` se limpia a `null` — **la historia de cambios de estado SE PIERDE**.

Caso real verificado por el usuario: un servicio TV muestra "Activo · alta 11 jun 2026 · Baja —" aunque tuvo una baja y una reactivación. Esos cambios NO se ven. El usuario quiere ver TODOS los cambios de estado de CADA servicio en el tiempo, **igual que el historial del modal de TV** (`ActivationHistoryModal`), que sí muestra alta/baja/reactivación porque TV YA tiene un ledger append-only (`tv_activation_events`).

## What
- **Schema (aditivo):** tabla nueva append-only `contract_service_events` (modelo `ContractServiceEvent`): un row por cada cambio de estado de un servicio NO-TV (internet/voz/cámaras/otros). `@@map` para mantener naming snake_case como `tv_activation_events`. La fila `ContractService` (estado actual + `deactivatedAt`) NO se toca: el ledger la complementa, no la reemplaza.
- **Port + adapters:** `ContractServiceEventRepository` (domain port) con `record(input)` (append-only) y `listByContract(contractId)` (newest-first). Adapters `PrismaContractServiceEventRepository` + `InMemoryContractServiceEventRepository`.
- **Wiring (best-effort, patrón activity-log #10):** registrar eventos genéricos en los use-cases que cambian el estado de un `ContractService` no-TV:
  - `AddContractService` → evento `activated` (alta inicial).
  - `UpdateContractService` → `deactivated` (active→inactive) / `reactivated` (inactive→active), SOLO cuando hay transición real de status.
  - `RemoveContractService` → `deactivated` (baja por eliminación), si la fila existía y estaba activa.
  - El registro es best-effort: si falla, NO aborta la operación principal.
- **Cruce de fuentes (NO duplicar TV):** el endpoint de historial pasa de devolver lista-de-servicios a lista-de-servicios-con-su-secuencia-de-eventos. Para cada servicio:
  - Si es **TV** (`tvLogin !== null`): la secuencia de eventos viene de `tv_activation_events` (filtrados por `contractId`, mapeados a la forma común), conservando el detalle (CIC). NO se escribe nada en `contract_service_events` para TV.
  - Si es **NO-TV**: la secuencia viene de `contract_service_events`.
- **FE:** `ServiceHistoryModal` agrega, por cada fila de servicio, la secuencia temporal de eventos (alta/baja/reactivación con fecha + operador, estilo `ActivationHistoryModal`), sin perder la columna de estado actual. Se gatea `clients.read` (igual que hoy).

## Permisos (dos capas)
- BE: `requirePerm('clients', 'read')` en la ruta (sin cambios — verificado en `contractServices.routes.ts:39,114`).
- FE: el botón "Historial" ya está gateado `<Can permission="clients.read">` en `ContractCard` (#73). Sin cambio de permiso.

## Seguridad — #65 H3
`tvPassword` JAMÁS viaja en ningún DTO de historial (regla heredada de #73). El nuevo shape solo expone `tvLogin` a nivel servicio y NUNCA credenciales a nivel evento. Test pinea la ausencia de `tvPassword` en toda la respuesta.

## Limitación documentada (igual que #73)
Sin backfill posible del histórico pre-migración: los servicios no-TV ya inactivados/reactivados antes de esta migración no tienen eventos registrados. El historial arranca a poblarse hacia adelante. Para esos casos legacy, la fila de servicio sigue mostrando su estado actual + `createdAt`/`deactivatedAt` como hasta hoy (degradación elegante: un servicio sin eventos muestra al menos su alta derivada de `createdAt`).

## Wire contract (resumen — detalle en design.md y spec)
- Nuevo evento común `ServiceEventDto` { id, eventType (`activated`|`deactivated`|`reactivated`), occurredAt, actorName, cic? }.
- `ContractServiceHistoryItemDto` (#73) gana `events: ServiceEventDto[]` (orden cronológico asc). El resto de campos se mantiene → no rompe a FE.
- FE: tipo `ServiceHistoryEntry` en `src/types/customer.ts` gana `events: ServiceEvent[]`.
