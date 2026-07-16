# Proposal — contract-node-ap-auto-assign (Fase B: auto-assign nodo/AP + picker manual BE)

## 1. Why / Intent

La **Fase A** (`contract-node-ap-catalog`, EN PROD `c0d7acb3`) dejó el modelo listo: catálogo
`AccessPoint` derivado del mirror UISP (544 APs, 74 nodos, auto-sembrado en el paso 9 de
`SyncUispMirror`) y los FKs manual-only `Contract.networkSiteId` / `Contract.accessPointId` —
**vacíos**. Sin data poblada, la segmentación por nodo/AP del Bulk WhatsApp (Fase C) sigue siendo
imposible y la ficha del contrato no dice de qué antena cuelga el cliente.

**Fase B puebla esos FKs por dos vías complementarias:**

1. **Auto-assign (AUTO DURA)** — el sync deriva nodo/AP de cada contrato desde la evidencia de red y
   lo ESCRIBE siempre que la derivación resuelva (pisa lo que haya). La cadena, verificada en vivo
   contra prod + NMS (ver design §2-§3):

   ```
   Contract ← PppoeService.contractId
                └─ MAC del CPE:  callerId (4.2%)  ∪  RadiusEvent.macAddress (fuente masiva)
                     └─ UispDevice.mac (station, MAC normalizada)
                          └─ attributes.apDevice.id  ←  ESLABÓN NUEVO en el mirror
                               └─ AccessPoint.uispDeviceId → AccessPoint.networkSiteId
   ```

   **Descubrimiento clave (verificado en vivo 2026-07-16)**: el eslabón station→AP ya viene en el
   MISMO payload de `/v2.1/devices` que el sync consume hoy — `attributes.apDevice.id` (98.8% de las
   3385 stations, 100% resoluble contra el catálogo de APs). CERO llamadas extra a UISP.

   **Descubrimiento del spike prod (2026-07-16)**: `PppoeService.callerId` solo está poblado en
   231/5456 (4.2%) — el write-through solo corre on-demand (`GetPppoeCallerId`). La fuente masiva de
   MAC es el accounting RADIUS ya espejado (`RadiusEvent.macAddress`); la resolución va en CASCADA
   (callerId → último RadiusEvent por username).

2. **Picker manual (BE)** — para lo que la red NO ve: fibra (UISP no la conoce) y PPPoE sin match.
   Use case `SetContractNetworkAssignment` + catálogo de APs asignables + PATCH del contrato, con
   permiso granular. La UI del picker va como change coordinado APARTE en el FE.

## 2. Scope IN (Fase B — BE)

1. **Eslabón station→AP en el mirror** — `UispDevice.apUispDeviceId` (columna nueva TEXT nullable,
   migración ADITIVA), mapeado en `UispClient.mapDevice` desde `raw.attributes.apDevice.id`.
2. **Normalizador de MAC** — helper puro de dominio (`normalizeMac`): formato canónico lowercase sin
   separadores, usado en TODOS los lados del join (callerId, RadiusEvent.macAddress, UispDevice.mac).
3. **Use case `AutoAssignContractNetwork`** — NUEVO, invocado por `UispSyncScheduler` post-sync
   (decisión y justificación en design §5), aislado en try/catch, idempotente, gated por feature
   flag propio (`contract-network-auto-assign`, dark por default), con métricas persistidas en
   `SyncState` (asignados / sin-match / ambiguos / sin-cambio).
4. **Semántica AUTO DURA** — matriz explícita de casos (design §6): deriva ⇒ escribe (pisa manual);
   NO deriva ⇒ NO toca lo existente (jamás nullea una asignación manual); ambiguo ⇒ skip + log.
5. **Ports extendidos** — `RadiusEventRepository.latestMacByUsernames` (batch, sin N+1),
   `ContractRepository.getNetworkAssignments` + `updateNetworkAssignment` (compartido por auto y
   manual). Impl Prisma + in-memory.
6. **Picker manual BE** — use case `SetContractNetworkAssignment` (validación de FKs + invariante
   AP∈nodo + rechazo de APs retirados) + `ListAssignableAccessPoints` (filtra `missingSince`) +
   rutas: `GET /api/access-points` y `PATCH /api/contracts/:id/network-assignment`, con permisos
   granulares (`network.read` / `contracts.assign`) y DTOs (nunca entidad Prisma cruda).
7. **Migraciones** — 2 aditivas: `ADD COLUMN UispDevice.apUispDeviceId` (via `prisma migrate diff`)
   + seed idempotente del permiso `(contracts, assign)` (patrón `messaging_bulk_permissions`).

## 3. Scope OUT (explícito — anti scope-creep)

- **UI del picker (FE)** → change coordinado aparte en `ipnext-frontend`. Este cambio expone el BE.
- **Segmentación del bulk por nodo/AP (segment builder)** → **Fase C**, se construye sobre estos
  campos después de que se pueblen.
- **Backfill de `PppoeService.callerId` desde `RadiusEvent`** — NO se hace: la cascada read-time del
  auto-assign da el mismo resultado sin doble-escritura ni ownership cruzado (tradeoff en design §4.2).
- **Historial de asignaciones / auditoría de quién pisó qué** — fuera de alcance v1. Los writes del
  auto-assign se loguean y se cuentan; no se persiste un ledger por contrato.
- **Vincular fibra automáticamente** (SmartOLT / OLT→nodo) — fuera de alcance; para fibra existe el
  picker manual.
- **Tocar el paso 9 existente del sync** — el catálogo de APs ya funciona; no se modifica.

## 4. Enfoque

BE-first, aditivo y dark: la columna nueva del mirror se puebla sola en el próximo tick del sync; el
auto-assign nace detrás de un feature flag APAGADO (rollout controlado: prender flag → observar
métricas del primer run en `SyncState` → confirmar semántica dura). El picker manual es
independiente del flag (sirve desde el deploy). Riesgo principal: la semántica AUTO DURA pisa
asignaciones manuales — mitigado con matriz explícita (design §6, decisión re-confirmada con el
usuario), flag de apagado inmediato y métricas por corrida.
