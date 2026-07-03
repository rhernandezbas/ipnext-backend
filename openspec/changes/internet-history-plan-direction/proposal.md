# internet-history-plan-direction

## Why
El modal "Historial de Internet" (vista GLOBAL, `GET /api/pppoe/activation-history`) lista eventos de servicio (alta/baja/modificado/…) pero:
1. No se puede filtrar por TÓPICO (tipo de evento) ni por si un cambio de plan fue **upgrade** o **downgrade**.
2. En un evento `modified` (cambio de plan) el par de planes vive solo dentro de `notes` como texto libre `"OLD → NEW"` — no hay dato estructurado para renderizar un badge ↑/↓ ni para filtrar.

El usuario quiere: dos filtros nuevos (tópico + dirección) en la barra GLOBAL, y en la fila del cambio de plan un badge ↑/↓ con el texto `plan viejo → nuevo`.

## What
1. **Schema (aditivo)**: `ContractServiceEvent` gana `oldPlan String?` + `newPlan String?` (`prisma/schema.prisma`). NO se persiste la dirección — se DERIVA al leer. Migración `20260828000000_contract_service_event_plan_change` = solo 2 `ADD COLUMN` nullable.
2. **Writers**: los dos únicos productores de eventos `modified` (`ChangePppoePlanService`, `UpdatePppoeService`; `BulkChangePppoePlan` lo hereda por delegación) graban `oldPlan`/`newPlan` además del `notes` existente (compat).
3. **Derivación read-side**: `ListInternetServiceHistory` carga el catálogo de planes una vez (`PlanRepository.list()` → `Map<code, downloadKbps>`) y deriva `direction: 'upgrade' | 'downgrade' | null`. `null` cuando: el evento no es `modified`, falta un código en el catálogo, los kbps son iguales, o alguno es plan de ENFORCEMENT (`IP-REDUCCION` / `IP-BAJA`, vía `isEnforcementPlan`).
4. **Filtros**: `GET /api/pppoe/activation-history` acepta `eventType` (push-down SQL vía el port) y `direction` (in-memory tras derivar; independiente — los no-cambios-de-plan caen por `direction=null`).
5. **DTO**: `InternetServiceEventDto` gana `direction`, `oldPlan`, `newPlan`.
6. **Backfill**: script one-shot idempotente (`scripts/backfill-contract-service-event-plans.ts`) que parsea `notes` (`"OLD → NEW"`, `'—'`→null) para poblar `oldPlan`/`newPlan` de eventos `modified` viejos. NO va en la migración (regla del proyecto: migraciones solo-schema).
7. **FE**: 2 `<select>` (tópico + dirección) en la barra GLOBAL + badge ↑/↓ + texto `oldPlan → newPlan` en la fila `modified`.

## Out of scope
- Persistir la dirección (se deriva, no se guarda — evita drift si cambia el catálogo).
- Filtro de dirección en la vista per-cliente (no tiene barra de filtros).
- Backfill dentro de la migración (queda como script aparte, re-ejecutable).

## Back-compat
- `notes` se mantiene intacto (mismo par `"OLD → NEW"`) — nada que lo consuma se rompe.
- Columnas nullable + `PlanRepository` inyectado: eventos viejos sin `oldPlan`/`newPlan` derivan `direction=null` (se muestran sin badge) hasta que corra el backfill.
- Contrato de wire aditivo: los 3 campos nuevos son opcionales para el FE.

## Coordinación FE
Requerida (contrato de query params + 3 campos nuevos del DTO). Implementada en `ipnext-frontend` (branch `feat/internet-history-plan-direction`).
