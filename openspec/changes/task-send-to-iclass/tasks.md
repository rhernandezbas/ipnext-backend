# Tasks — task-send-to-iclass

Cambio aditivo, desplegable por fases. Flag default **OFF** → seguro de mergear sin activar.
STRICT TDD: test rojo primero, luego implementación, luego verde. `npm test` y `tsc --noEmit` deben quedar verdes en cada gate.

---

## Fase 1 — Schema + Feature Flags (base)

### 1.1 — Schema Prisma
- [x] 1.1 Agregar modelo `FeatureFlag { key String @id, enabled Boolean @default(false), updatedAt DateTime @updatedAt }` en `prisma/schema.prisma`.
- [x] 1.2 Agregar `iclassOrderCode String?` al modelo `ScheduledTask`.
- [~] 1.3 `npm run prisma:migrate` nombre `feature_flags_and_iclass_order_code`. PENDIENTE por DB: `prisma migrate dev` falló con P1000 (auth contra DB local). Schema modificado + `prisma generate` corrido OK. La migración se aplica en el deploy.
  ✅ **GATE: schema coherente; tests in-memory no dependen de DB.**
- [x] 1.4 En `prisma/seed.ts`, sembrar el flag `iclass-integration` con `enabled: false` (idempotente: upsert por key). (Ya presente en HEAD.)

### 1.2 — Puerto + entidad de dominio (FeatureFlag)
- [x] 1.5 Crear `interface FeatureFlag` y `FeatureFlagRepository` en `src/domain/ports/FeatureFlagRepository.ts` (REQ-FF-PORT-1).
- [x] 1.6 Crear `FeatureFlagNotFoundError` en `src/domain/errors/`.

### 1.3 — Adapters FeatureFlag (TDD)
- [x] 1.7 (TEST ROJO) `src/__tests__/infrastructure/InMemoryFeatureFlagRepository.test.ts`: list / get / setEnabled / get inexistente → null.
- [x] 1.8 Implementar `InMemoryFeatureFlagRepository` en `infrastructure/adapters/in-memory/`.
- [x] 1.9 Implementar `PrismaFeatureFlagRepository` en `infrastructure/adapters/prisma/` (respetar naming Prisma{Entity}Repository — coherente, sin copiar la deuda existente).
- [x] 1.10 (TEST VERDE) 1.7 pasa. `tsc --noEmit` verde.

### 1.4 — Use-cases + rutas admin de flags (TDD)
- [x] 1.11 (TEST ROJO) `src/__tests__/infrastructure/feature-flags.routes.test.ts` (supertest): GET list, GET one, GET 404 FLAG_NOT_FOUND, PATCH toggle persistente, PATCH body inválido 400, PATCH 404, sin auth 401 (REQ-FF-READ-1, REQ-FF-TOGGLE-1, REQ-FF-AUTH-1).
- [x] 1.12 Use-cases `ListFeatureFlags`, `GetFeatureFlag`, `SetFeatureFlag` en `application/use-cases/`.
- [x] 1.13 Router `feature-flags.routes.ts` montado en `/api/admin/feature-flags` con middleware de auth. Validación de body con zod (`{ enabled: boolean }`).
- [x] 1.14 Wiring en `app.ts` (mínimo).
- [x] 1.15 (TEST VERDE) 1.11 pasa. `npm test` + `tsc --noEmit` verdes.
  ✅ **DEPLOY GATE: feature-flags funciona end-to-end, sin tocar IClass aún.**

---

## Fase 2 — Puerto y adapter IClass

### 2.1 — Puerto + errores de dominio
- [x] 2.1 Crear `IClassPort` (+ `IClassNode`, `CreateServiceOrderInput`) en `src/domain/ports/IClassPort.ts` (REQ-PORT-1).
- [x] 2.2 Crear `IClassNodeNotFoundError` y `IClassUnavailableError` en `src/domain/errors/`.

### 2.2 — Config
- [x] 2.3 Agregar a `config.ts` (opt-in, NO fail-fast salvo que el flag se use): `ICLASS_BASE_URL`, `ICLASS_USERNAME`, `ICLASS_PASSWORD`, `ICLASS_THIRD_PARTY_ID`, `ICLASS_DEFAULT_SO_TYPE`. Documentar en `env.example`.

### 2.3 — InMemory IClass (TDD)
- [x] 2.4 (TEST ROJO) `src/__tests__/infrastructure/InMemoryIClassClient.test.ts`: listNodes configurable; createServiceOrder registra la OS y devuelve orderCode; modos de fallo (unavailable) activables.
- [x] 2.5 Implementar `InMemoryIClassClient` en `infrastructure/adapters/in-memory/`.
- [x] 2.6 (TEST VERDE) 2.4 pasa.

### 2.4 — IClassClient real (TDD con mock de axios)
- [x] 2.7 (TEST ROJO) `src/__tests__/infrastructure/IClassClient.test.ts`: login Bearer; `createServiceOrder` arma `ServiceOrderV1In` con `address.nodeCode = city` y SIN `scheduledDate` (REQ-OS-1); `listNodes` mapea `codigo/descricao→code/description`; re-login UNA vez ante 401 (REQ-OS-3); 5xx → `IClassUnavailableError`; nunca devuelve JSON crudo (REQ-OS-4).
- [x] 2.8 Implementar `IClassClient` en `infrastructure/adapters/iclass/` (patrón `GestionRealClient`: axios + mapError). Cache de `listNodes()` con TTL (AD-2).
- [x] 2.9 (TEST VERDE) 2.7 pasa. `npm test` + `tsc --noEmit` verdes.

---

## Fase 3 — Use-case SendTaskToIClass + integración con MoveTaskToStage

### 3.1 — Soporte en SchedulingRepository
- [x] 3.1 Agregar `getStageByName(name): Promise<Stage | null>` y `setIClassOrderCode(taskId, code)` al port `SchedulingRepository` (design: Stage lookup, AD-7).
- [x] 3.2 Extender el JOIN de Client en `PrismaSchedulingRepository` para incluir `phone` (y exponer `iclassOrderCode` en `toTask`). Implementar los métodos nuevos en Prisma + InMemory.

### 3.2 — Use-case (TDD)
- [x] 3.3 (TEST ROJO) `src/__tests__/application/SendTaskToIClass.test.ts` cubriendo TODOS los escenarios del spec scheduling:
  - flag OFF → mueve sin llamar IClass (REQ-MOVE-FLAG-OFF-1)
  - faltan requeridos → `MissingRequiredFieldsError` con `missingFields` exactos (REQ-MOVE-VAL-1)
  - `customerId` null → faltan customerName/phone/city
  - ciudad sin nodo → `IClassNodeNotFoundError` (REQ-MOVE-VAL-1 / REQ-OS-2)
  - happy path → crea OS sin fecha, guarda orderCode, mueve a "Registrado en IClass" (REQ-MOVE-OS-1)
  - IClass falla → `IClassUnavailableError`, no mueve, orderCode null
  - idempotencia: task con orderCode ya seteado → no recrea (AD-7)
- [x] 3.4 Crear `MissingRequiredFieldsError` (con `missingFields: string[]`) en `domain/errors/`.
- [x] 3.5 Implementar `SendTaskToIClass` en `application/use-cases/` (depende de `IClassPort`, `FeatureFlagRepository`, `SchedulingRepository` — DIP, sin tipos de infra).
- [x] 3.6 (TEST VERDE) 3.3 pasa.

### 3.3 — Hook en MoveTaskToStage (TDD)
- [x] 3.7 (TEST ROJO) Extender `src/__tests__/application/MoveTaskToStage.test.ts` (o crear): mover a stage "Enviar a IClass" delega en `SendTaskToIClass`; mover a otro stage → comportamiento intacto.
- [x] 3.8 Modificar `MoveTaskToStage`: si el stage destino se llama "Enviar a IClass" → delegar en `SendTaskToIClass`; si no → flujo actual.
- [x] 3.9 (TEST VERDE) 3.7 pasa.

---

## Fase 4 — Capa HTTP (rutas + error mapping)

- [x] 4.1 (TEST ROJO) En `src/__tests__/infrastructure/scheduling.routes.test.ts`: `PATCH /api/scheduling/:id/stage` →
  - 422 `MISSING_REQUIRED_FIELDS` con `missingFields` (flag ON)
  - 422 `ICLASS_NODE_NOT_FOUND`
  - 200 con `iclassOrderCode` y stage "Registrado en IClass" (happy path)
  - 502 `ICLASS_UNAVAILABLE`
  - 200 sin tocar IClass (flag OFF)
- [x] 4.2 Mapear los nuevos errores de dominio en el error-handler HTTP (tabla design): 422/422/502 + propagar `missingFields`.
- [x] 4.3 Wiring en `app.ts`: instanciar `IClassClient` (o InMemory según env) vía factory `iclass.factory.ts`, `SendTaskToIClass`, inyectar en `MoveTaskToStage`. Ruta `/stage` ahora propaga con `next(err)` al handler global.
- [x] 4.4 (TEST VERDE) 4.1 pasa. `npm test` (993 passed, 9 skipped) + `tsc --noEmit` verdes.
  ✅ **DEPLOY GATE: feature completa, flag OFF en prod.**

---

## Fase 5 — Coordinación Frontend (repo ipnext-frontend, trazabilidad)

> En el repo del front. Se listan para trazabilidad.

- [ ] 5.1 Al mover/soltar una tarea al stage "Enviar a IClass", manejar respuesta 422 `MISSING_REQUIRED_FIELDS`: mostrar **modal** listando `missingFields` (nombre, teléfono, dirección, ciudad, descripción) y NO confirmar el move.
- [ ] 5.2 Manejar 422 `ICLASS_NODE_NOT_FOUND` (ciudad no válida) y 502 `ICLASS_UNAVAILABLE` con mensajes claros.
- [ ] 5.3 Al éxito, reflejar el avance a "Registrado en IClass" y mostrar `iclassOrderCode`.

---

## Verification Checklist

- [~] V.1 Migración aplicada: tabla `FeatureFlag` + `ScheduledTask.iclassOrderCode`. Seed crea flag OFF. PENDIENTE en deploy (P1000 contra DB local en Fase 1).
- [~] V.2 `PATCH /api/admin/feature-flags/iclass-integration {enabled:true|false}` persiste y sobrevive reinicio. Cubierto por tests de routes (Fase 1); persistencia real depende de la migración (deploy).
- [x] V.3 Flag OFF → mover a "Enviar a IClass" no llama IClass (200). (scheduling.routes.test.ts)
- [x] V.4 Flag ON, faltan campos → 422 con `missingFields` exactos; sin OS creada. (scheduling.routes.test.ts)
- [x] V.5 Flag ON, ciudad inválida → 422 `ICLASS_NODE_NOT_FOUND`. (scheduling.routes.test.ts)
- [x] V.6 Flag ON, datos OK → OS creada SIN fecha, `iclassOrderCode` guardado, stage = "Registrado en IClass". (scheduling.routes.test.ts + SendTaskToIClass.test.ts)
- [x] V.7 Idempotencia: reintentar sobre tarea con orderCode no duplica OS. (SendTaskToIClass.test.ts, Fase 3)
- [x] V.8 `npm test` verde (993 passed, 9 skipped), `tsc --noEmit` verde.
