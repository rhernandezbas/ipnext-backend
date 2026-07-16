# Proposal — contract-node-ap-catalog (Bulk WhatsApp F2/F3, Fase A: catálogo de nodo/AP)

## 1. Why / Intent

El EPIC Bulk WhatsApp (F2 envío masivo por template) dejó **LOCKED fuera de v1** la segmentación
por NODO, con este motivo textual (ver `openspec/changes/messaging-bulk/proposal.md` §3):

> **Segmentación por NODO → v2. LOCKED: el `Client` no tiene fuente de datos limpia de nodo**
> (PPPoE→NAS da granularidad de BRAS equivocada, `ScheduledTask.networkSiteId` = 0% cobertura,
> `NetworkSite.clientCount` es campo editado a mano). v2 requiere modelar un `Client.networkSiteId`
> real + backfill como esfuerzo PROPIO.

**Fase A** es ese "esfuerzo PROPIO" — pero acotado a lo estructural y AUTOMÁTICO: crear el modelo de
datos que permite, más adelante (Fase B), asignar a un contrato su **nodo** y su **AP** (access
point), y (Fase C) segmentar un envío bulk por esos ejes. Nada de esto sirve sin una **fuente limpia
de qué APs existen y a qué nodo pertenecen**. Esa fuente ya está en el mirror de UISP.

**Descubrimiento del spike (verificado en vivo)**: el criterio de "esto es un AP" es
`UispDevice.role === 'ap'` — 544 APs sobre 4130 devices, repartidos en 74 nodos. Un AP pertenece a un
nodo por `UispDevice.uispSiteId`, y `NetworkSite` ya se auto-siembra desde los `UispSite` con
`uispSiteId` seteado (`SyncUispMirror.execute()` paso 8). O sea: el 100% de la data ya entra sola por
el sync cada 5 min. Solo falta **derivar el catálogo de APs** del mirror y **linkearlo al nodo**.

## 2. Scope IN (Fase A)

1. **Modelo `AccessPoint`** — catálogo DERIVADO del mirror UISP (`uispDeviceId @unique`, `name`,
   `mac`, `networkSiteId?` → FK a `NetworkSite`, timestamps). NO editable a mano: lo posee el sync.
2. **Campos en `Contract`** — `networkSiteId?` + `accessPointId?` (ambos FK, `onDelete: SetNull`),
   **manual-only**: el sync de GR NUNCA los escribe (excluidos del whitelist de `upsertContract`,
   misma disciplina que `name`/`gps`/`technology`).
3. **Port + adapters `AccessPointRepository`** — `upsertByUispDeviceId`, `findMany`,
   `findByNetworkSiteId`, `findById`. Impl Prisma + in-memory.
4. **`SyncUispMirror` paso 9** — después de sembrar los NetworkSites, sembrar los AccessPoints desde
   los `UispDevice` con `role === 'ap'`, resolviendo el `networkSiteId` por `uispSiteId`. Idempotente,
   sin auto-borrado, respetando el guard anti-truncación existente.
5. **Migración ADITIVA** — `CREATE TABLE AccessPoint` + `ADD COLUMN Contract.*` + FKs + índices. Sin
   DROP, sin backfill.
6. **Wiring** — inyectar `PrismaAccessPointRepository` en el composition root del sync
   (`bootstrapUispSync.ts`), con guard en el composition-test.

## 3. Scope OUT (explícito — anti scope-creep)

- **Asignación contrato → nodo/AP (UI + rutas/use-cases de asignación)** → **Fase B**. Este cambio NO
  agrega ninguna ruta ni use case de asignación; solo el modelo + los FKs vacíos.
- **Segmentación del bulk por nodo/AP (segment builder)** → **Fase C**. El `ListSegmentRecipients` /
  filtro por nodo se construye sobre estos campos DESPUÉS.
- **Backfill de contratos existentes con su nodo/AP** — fuera de alcance. Los FKs nacen `NULL`; el
  operador (Fase B) o un import posterior los pueblan.
- **AP editable a mano / CRUD de APs** — el catálogo es derivado. No hay endpoint de creación/edición
  de APs; si un AP no está en UISP, no está en el catálogo (by design).

## 4. Enfoque

BE-first, aditivo y dark: sin data poblada de Contract el feature es invisible; el catálogo de APs se
llena solo en el próximo tick del sync UISP (feature ya activa en prod). Riesgo bajo: todo lo nuevo es
opcional/nullable y no toca ningún camino existente.
