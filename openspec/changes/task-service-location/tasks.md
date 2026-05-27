# Tasks — task-service-location

Cambio aditivo en tres fases independientemente desplegables.
STRICT TDD: test rojo primero, luego implementación, luego verde.

---

## Fase 1 — Schema + Entidades de Dominio

### 1.1 — Schema Prisma
- [ ] 1.1 Agregar `address String?`, `lat Float?`, `lng Float?` al modelo `Service` en
  `prisma/schema.prisma`.
- [ ] 1.2 Ejecutar `npm run prisma:migrate` con nombre `service_add_location`. Verificar
  que la migración generada sea solo ADD COLUMN (sin datos).
  ✅ **GATE: `prisma migrate status` limpio.**

### 1.2 — Entidades de dominio
- [ ] 1.3 Agregar `address: string | null`, `lat: number | null`, `lng: number | null`
  a `interface Service` en `src/domain/entities/customer.ts`.
- [ ] 1.4 Agregar `lat: number | null`, `lng: number | null`
  a `interface GrContract` en `src/domain/entities/gestionReal.ts`.
- [ ] 1.5 `tsc --noEmit` verde (los adapters aún no usan los campos — TS los marca como
  faltantes en las expresiones de objeto). Corregir los lugares que construyen `GrContract`
  o `Service` sin los nuevos campos (agregar `?? null`).

---

## Fase 2 — Captura y Persistencia (Sync Path)

### 2.1 — Parser GR (TDD)
- [ ] 2.1 (TEST ROJO) En `src/__tests__/infrastructure/GestionRealClient.test.ts`,
  agregar casos:
  - Payload con `lat`/`lng` numéricos → `GrContract.lat`/`lng` son los números.
  - Payload sin `lat`/`lng` → `null`.
  - Payload con `domicilio: ""` → `address: null` (no `""`).
- [ ] 2.2 En `parseContractsResponse` (`GestionRealClient.ts`): capturar
  `lat: numOrNull(c.lat)` y `lng: numOrNull(c.lng)`. Corregir `address` para que `""`
  retorne `null` (usar `str(c.domicilio) || null` en lugar de `str(c.domicilio)`).
  Agregar helper `numOrNull(v: unknown): number | null`.
- [ ] 2.3 (TEST VERDE) Los casos del 2.1 pasan. ✅

### 2.2 — `upsertContract` (TDD)
- [ ] 2.4 (TEST ROJO) En `src/__tests__/application/SyncGestionRealContracts.test.ts`,
  agregar casos:
  - Contrato con `address`, `lat`, `lng` → el servicio creado tiene esos valores.
  - Contrato con `address = null` → `Service.address = null` (no lanza error).
  - Re-upsert de un contrato existente con nueva dirección → la dirección se actualiza.
- [ ] 2.5 En `PrismaClientMirrorRepository.upsertContract` (`upsertContract`): incluir
  `address: k.address ?? null`, `lat: k.lat ?? null`, `lng: k.lng ?? null` en el objeto
  `data` de tanto el `create` como el `update`.
- [ ] 2.6 En `InMemoryClientMirrorRepository.upsertContract`: el in-memory ya almacena
  el `GrContract` completo — no requiere cambio funcional, pero verificar que el tipo
  compila sin errores.
- [ ] 2.7 (TEST VERDE) Los casos del 2.4 pasan. ✅
- [ ] 2.8 `npm test` verde en el suite completo.

---

## Fase 3 — Read Path (Endpoint Servicios)

### 3.1 — `toService` y entidad dominio (TDD)
- [ ] 3.1 (TEST ROJO) En `src/__tests__/clients.routes.test.ts`, agregar caso para
  `GET /api/clients/:id/services`:
  - Mock devuelve servicios con `address`, `lat`, `lng`.
  - Verificar que la respuesta JSON incluye los tres campos (incluyendo cuando son null).
- [ ] 3.2 Actualizar `toService` en `PrismaCustomerRepository.ts`:
  ```ts
  address: row.address ?? null,
  lat:     row.lat     ?? null,
  lng:     row.lng     ?? null,
  ```
- [ ] 3.3 Actualizar `InMemoryCustomerRepository` (si existe un `toService` equivalente
  o una construcción de `Service[]` en los fixtures de test) para incluir los tres campos
  (con valores null como default).
- [ ] 3.4 (TEST VERDE) Los casos del 3.1 pasan. ✅
- [ ] 3.5 `npm test` verde. `tsc --noEmit` verde.
  ✅ **DEPLOY GATE: Fase 1-3 deployable. Nuevos contratos ya persisten dirección.**

---

## Fase 4 — Backfill de Servicios Existentes

### 4.1 — Script backfill
- [ ] 4.1 Crear `prisma/scripts/backfill-service-address.ts`:
  - Leer `BATCH_SIZE` de env (default 50 clientes por ciclo).
  - Paginación con skip/take sobre `Service WHERE grContratoId IS NOT NULL`.
  - Agrupar por `client.grClienteId` (1 request GR por cliente).
  - `fetchContractsByClient(grClienteId)` → `parseContractsResponse` (ya actualizado).
  - `prisma.service.update(...)` para cada match.
  - Sleep de 100ms entre batches de clientes.
  - Log al final: `Updated X / Skipped Y (no address) / Errors Z`.
- [ ] 4.2 Documentar cómo ejecutar en README del script o en el `package.json`:
  ```
  npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-service-address.ts
  ```
- [ ] 4.3 Ejecutar en staging/dev y verificar que el conteo de `Service` con
  `address NOT NULL` aumenta sensiblemente (esperado: ~100% de los contratos vigentes).
  ✅ **GATE: verificar con query `SELECT COUNT(*) FROM "Service" WHERE address IS NOT NULL`.**
- [ ] 4.4 Ejecutar en PROD en ventana de mantenimiento o como cron job con bajo paralelismo.
  ✅ **PROD GATE: confirmar counts antes y después.**

---

## Fase 5 — Coordinación Frontend

> Estas tareas son en el repo `ipnext-frontend`. Se listan aquí para trazabilidad.

- [ ] 5.1 Actualizar tipo `Service` en `src/types/` con `address: string | null`,
  `lat: number | null`, `lng: number | null`.
- [ ] 5.2 `CreateTaskModal.tsx`: al seleccionar servicio, aplicar regla de precedencia:
  si `service.address !== null` → setear campos `address`/`lat`/`lng` de la tarea
  desde el servicio. Si null → usar `client.address` (comportamiento actual).
- [ ] 5.3 `SchedulingTaskDetailPage.tsx`: al cargar detalle con `serviceId`, aplicar
  la misma regla de precedencia sobre el formulario de edición.
- [ ] 5.4 Manejar gracefully `lat`/`lng` null en el mapa (no mostrar pin).
- [ ] 5.5 (Opcional UX) Indicador visual de la fuente de la dirección: servicio vs. cliente.

---

## Verification Checklist

- [ ] V.1 `schema.prisma` modelo `Service` tiene `address String?`, `lat Float?`, `lng Float?`.
- [ ] V.2 `GET /api/clients/:id/services` responde con `address`/`lat`/`lng` en cada ítem.
- [ ] V.3 Nuevo contrato sincronizado desde GR tiene `address` populado (cuando GR lo provee).
- [ ] V.4 Script backfill ejecutado: `SELECT COUNT(*) FROM "Service" WHERE address IS NOT NULL` > 0.
- [ ] V.5 `npm test` verde. `tsc --noEmit` verde.
- [ ] V.6 En `CreateTaskModal` (frontend): seleccionar servicio con dirección auto-completa
  el campo `address` de la tarea.
- [ ] V.7 En `CreateTaskModal` (frontend): seleccionar servicio sin dirección mantiene
  `client.address` (sin regresión).
