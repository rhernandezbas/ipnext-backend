# Proposal — task-service-location

## Intent

Cuando un técnico crea o edita una tarea y selecciona un **Servicio** del cliente, la
dirección de instalación (y las coordenadas lat/lng cuando estén disponibles) se deben
auto-completar en la tarea. Hoy la tarea toma la dirección del **Cliente**; el Servicio
es más específico (es el domicilio del nodo instalado) y debe tener prioridad.

El cambio requiere tres capas de trabajo en orden:

1. **Backend — Schema**: agregar `address`, `lat`, `lng` al modelo `Service` (migración aditiva).
2. **Backend — Sync**: capturar y persistir lat/lng desde GR en el flujo de sincronización.
3. **Frontend — UX** (coordinación, no implementación aquí): leer los campos desde el
   endpoint de servicios y aplicar la regla de precedencia servicio > cliente.

## Problem

### Raíz técnica

- `Service` en Prisma NO tiene `address`, `lat` ni `lng`.
- `parseContractsResponse` ya captura `address: str(c.domicilio)` en `GrContract`,
  pero NO lat/lng — y `upsertContract` descarta `address` al hacer el upsert.
- En la muestra de GR: los 4 contratos tenían `domicilio`; solo 1 tenía lat/lng.
  GR devuelve lat/lng de forma dispersa → no podemos asumirlos presentes.
- El endpoint `GET /api/clients/:id/services` devuelve `Service[]` mapeado por `toService`.
  Hoy `toService` no expone dirección porque el modelo no la tiene.

### Consecuencia UX

- El frontend (`CreateTaskModal`, `SchedulingTaskDetailPage`) solo puede auto-completar
  la dirección desde el cliente (`client.address`).
- Un cliente con 3 servicios en domicilios distintos obliga al técnico a corregir la
  dirección manualmente cada vez.

## Scope IN

### Backend

| Área | Cambio |
|------|--------|
| `prisma/schema.prisma` → `Service` | `+ address String?  lat Float?  lng Float?` |
| Migración Prisma | Aditiva (solo ALTER TABLE ADD COLUMN, nullable). No backfill automático. |
| `src/domain/entities/gestionReal.ts` → `GrContract` | `+ lat: number \| null`  `+ lng: number \| null` |
| `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` → `parseContractsResponse` | Capturar `lat`/`lng` del payload GR |
| `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` → `upsertContract` | Persistir `address`, `lat`, `lng` en `Service` |
| `src/domain/entities/customer.ts` → `Service` | `+ address: string \| null  lat: number \| null  lng: number \| null` |
| `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts` → `toService` | Exponer `address`, `lat`, `lng` |
| Tests | Unidad para `parseContractsResponse`; integración para `upsertContract`; integración ruta `GET /api/clients/:id/services` |

### Backend — Backfill de 7 174 servicios existentes

Ver sección "Decisión de Backfill" a continuación.

## Scope OUT

- Implementación frontend (especificada en "Coordinación Frontend" de este documento).
- Almacenamiento de lat/lng en `Client` (ya existe en GR como dirección de cliente,
  pero NO es el objetivo de este change).
- Entrada manual de lat/lng por el operador en la tarea (fuera de alcance).
- Geocodificación (convertir address → lat/lng cuando GR no la trae) — deferido.

## Decisión de Backfill

### Contexto

Hay 7 174 `Service` rows existentes (ya sincronizadas). Los campos
`address`/`lat`/`lng` serán `NULL` después de la migración aditiva. Para que el
auto-complete funcione no solo para servicios nuevos, hace falta poblarlo.

### Opciones evaluadas

**Opción A — Re-backfill completo: limpiar el cursor de SyncState y re-correr**

- Cómo: borrar/nullear la entrada `gr-clients` de `SyncState` (o ajustar la fecha
  a un pasado lejano). El scheduler detecta "no cursor" → modo backfill → re-crea/actualiza
  todos los clientes. El scheduler ya sabe que en backfill solo hace `fetchContractsByClient`
  para `createdClientIds` (clientes recién creados). Los 7 174 clientes ya existen, así
  que `createdClientIds` = [] → **cero contratos se re-sincronizan** en el ciclo normal.
  Para forzar el re-sync de contratos habría que modificar el scheduler o ejecutar
  `SyncGestionRealContracts` directamente con todos los `grClienteId`.
- Costo: ~1 request GR por cliente = ~7 174 requests. A la velocidad actual del scheduler
  (~20 min en el backfill inicial), el re-sync de contratos tarda igual.
- Riesgo: bloqueo del event loop durante ~20 min si se ejecuta en el scheduler en línea;
  potencial rate-limiting de GR.
- Ventaja: reutiliza código existente sin ningún script nuevo.

**Opción B — Script one-off (RECOMENDADA)**

- Cómo: un script `prisma/scripts/backfill-service-address.ts` que:
  1. Recorre todos los `Service` con `grContratoId NOT NULL` en batches de N.
  2. Por cada batch, resuelve el `grClienteId` via `Client.grClienteId`.
  3. Llama a `GestionRealClient.fetchContractsByClient(grClienteId)`.
  4. Actualiza `Service.address/lat/lng` donde los encuentre.
- Costo: mismo ~1 request GR por cliente, pero ejecutado fuera del scheduler,
  sin presión de tiempo, con control total (pausa, reanuda, logs detallados).
- Riesgo: bajo. Es idempotente; no toca la lógica de sync en producción.
- Ventaja: no interfiere con el scheduler en línea; puede correrse en una ventana de
  mantenimiento; progreso visible; no resetea cursors de SyncState.

**Opción C — Lazy (no backfill)**

- Cómo: los servicios existentes quedan con `address = NULL` hasta que GR los vuelve a
  tocar en un delta (cuando el cliente tenga alguna modificación).
- Costo: cero esfuerzo de implementación adicional.
- Riesgo: los 7 174 servicios existentes nunca mostrarán dirección hasta que GR los modifique.
  En la práctica, clientes activos sin cambios recientes quedarán sin dirección indefinidamente.
  El auto-complete del frontend fallará silenciosamente al seleccionar esos servicios
  (fallback al cliente = UX degradada).
- Rechazada: la experiencia de usuario queda rota por tiempo indeterminado.

### Recomendación: Opción B

El script one-off es la estrategia correcta porque:
1. No perturba el scheduler en producción.
2. Requiere ~1 request GR por cliente (mismo costo que la opción A, pero controlado).
3. Es trivial de escribir dado el código existente (`GestionRealClient` + `PrismaClientMirrorRepository`).
4. Se puede ejecutar en una ventana de mantenimiento con `ts-node` directamente.
5. Es idempotente: re-correrlo no rompe nada.

**Gotcha a documentar**: GR responde a `fetchContractsByClient` con TODOS los contratos
del cliente (activos y bajas). El script debe iterar contratos agrupados por cliente para
minimizar llamadas (una por cliente, no una por contrato).

## Coordinación Frontend

> Esta sección describe el comportamiento esperado. La implementación está en el
> repositorio frontend (`ipnext-frontend`).

### Regla de precedencia

```
service.address !== null
  → usar service.address como dirección de la tarea
  → usar service.lat / service.lng si disponibles
  → NO leer client.address

service.address === null
  → fallback a client.address (comportamiento actual)
  → lat/lng = null (o el valor del cliente si lo hay)
```

### CreateTaskModal (`src/components/scheduling/CreateTaskModal.tsx`)

- Al seleccionar un servicio del dropdown: si `service.address` está presente,
  setear el campo `address` de la tarea con `service.address` y los campos
  `lat`/`lng` con `service.lat`/`service.lng` (pueden ser null).
- Si `service.address` es null, mantener el comportamiento actual (usar `client.address`).
- UX: mostrar visualmente si la dirección proviene del servicio o del cliente
  (e.g. icono o label sutil). Esto evita confusión cuando el técnico ve una dirección
  diferente a la del cliente.

### SchedulingTaskDetailPage (`src/pages/scheduling/SchedulingTaskDetailPage.tsx`)

- Al cargar el detalle de una tarea que tiene `serviceId`: hacer un GET a
  `/api/clients/:clientId/services` (ya disponible), encontrar el servicio, y
  actualizar el campo `address` en el formulario siguiendo la misma regla de precedencia.
- Si el usuario cambia de servicio en el detalle: re-aplicar la regla.

### Contrato del endpoint `GET /api/clients/:id/services`

El endpoint ya existe. La respuesta de cada ítem pasará a incluir:

```ts
interface ServiceDTO {
  id: string;
  type: string;
  plan: string;
  ip: string;
  status: string;
  startDate: string;
  endDate: string;
  address: string | null;   // NUEVO
  lat: number | null;       // NUEVO
  lng: number | null;       // NUEVO
}
```

## Risks

1. **lat/lng disperso en GR** (constatado): la mayoría de servicios tendrán `lat = null /
   lng = null`. El frontend debe manejar esto gracefully (no bloquear si lat/lng es null).
2. **Re-sync delta no re-toca contratos sin cambios**: después del backfill manual, los
   contratos solo se actualizarán en el delta si GR reporta el cliente como modificado
   (`fecha_tipo=m`). Si GR actualiza lat/lng sin que el campo `modificado` del cliente
   cambie, el dato no llegará. Riesgo aceptable — el domicilio de instalación es estático.
3. **Script backfill sin rate-limit**: GR puede throttlear si se hacen ~7 174 requests en
   ráfaga. El script debe incluir un sleep entre batches de clientes.
4. **`address` de GR puede ser string vacío**: `str(c.domicilio)` devuelve `""` cuando el
   campo está en el payload pero vacío. Tratar `""` como `null` en el parser.

## Affected Areas

### Backend
- `prisma/schema.prisma`
- `prisma/migrations/<ts>_service_add_location/` (nueva migración aditiva)
- `prisma/scripts/backfill-service-address.ts` (script one-off)
- `src/domain/entities/gestionReal.ts`
- `src/domain/entities/customer.ts`
- `src/infrastructure/adapters/gestion-real/GestionRealClient.ts`
- `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts`
- `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts`
- Tests: `GestionRealClient.test.ts`, `SyncGestionRealContracts.test.ts`, `clients.routes.test.ts`

### Frontend (sibling repo — coordinación)
- `src/components/scheduling/CreateTaskModal.tsx`
- `src/pages/scheduling/SchedulingTaskDetailPage.tsx`
- `src/types/` (actualizar `Service` con `address/lat/lng`)

## Success Criteria

- `Service.address` se popula con el domicilio del contrato GR en todos los nuevos upserts.
- `Service.lat`/`lng` se popula cuando GR lo provee.
- `GET /api/clients/:id/services` devuelve `address`/`lat`/`lng` en cada ítem.
- El script de backfill actualiza al menos los servicios cuyo contrato GR tiene domicilio
  (esperado: ~100% de los 7 174).
- `npm test` verde después de cada fase.
- En el frontend, seleccionar un servicio con dirección en `CreateTaskModal` rellena el
  campo dirección y lat/lng de la tarea con los valores del servicio.
- Si el servicio no tiene dirección, la tarea usa la dirección del cliente (sin regresión).
