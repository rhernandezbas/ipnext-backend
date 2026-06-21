# Tasks: Recaptación — Admin asigna leads (BE)

Strict TDD: para cada use case / ruta, escribir el test que falla PRIMERO, luego el código. Runner: `npx jest --runInBand`. Verificación final: `npx jest` + `npx tsc --noEmit` en verde.

## 1. Permiso `recapture.assign` (seed + migración + action code)

- [ ] 1.1 Agregar `'assign'` a `KNOWN_ACTIONS` en `src/domain/entities/rbac.ts` (sub-action de recapture).
- [ ] 1.2 Crear migración de datos `prisma/migrations/20260804000000_recapture_assign_permission/migration.sql`: INSERT permiso `(recapture, assign)` + grants a `super_admin` y `administrador`, idempotente (`ON CONFLICT DO NOTHING`), replicando el patrón de `20260730000000_pppoe_rbac_permissions`.
- [ ] 1.3 Extender el loop de recapture en `prisma/seed.ts` para incluir `'assign'` (paridad dev, idempotente).

## 2. Use case bulk-assign

- [ ] 2.1 Test (RED): `src/__tests__/application/recapture/assign-recapture-leads-bulk.usecases.test.ts` con InMemoryRecaptureRepository + stub EntityLookup. Casos: asigna N leads (count correcto); operatorId null desasigna; operatorId inexistente → ReferenceNotFoundError; leadIds parcialmente inexistentes (solo cuenta existentes); skip user lookup cuando operatorId null.
- [ ] 2.2 Código (GREEN): `src/application/use-cases/recapture/AssignRecaptureLeadsBulk.ts` — reusa `repo.assign` + validación de `EntityLookup`. Devuelve `{ assigned: number }`.

## 3. Rutas + restricción server-side

- [ ] 3.1 Test (RED) restricción de lectura en `recapture.routes.test.ts` (o nuevo archivo): agente (hasAssignPerm=false) ve solo sus leads en `GET /leads`; ignora `?assigneeId=otro`; admin (hasAssignPerm=true) ve todos.
- [ ] 3.2 Test (RED) restricción de detalle/gestión: agente NO puede `GET`/`PATCH`/`contacts` lead ajeno (404 RECAPTURE_LEAD_NOT_FOUND); agente SÍ sobre el propio (200); admin sin restricción.
- [ ] 3.3 Test (RED) bulk-assign route `PATCH /leads/assign-bulk`: ok (200 {assigned}); operatorId inexistente (400 REFERENCE_NOT_FOUND); body inválido (400 VALIDATION_ERROR); sin permiso assign (403).
- [ ] 3.4 Test (RED) re-gate: `PATCH /leads/:id/assign`, `POST /ingest-churned`, `POST /import-csv` con `assign` denegado → 403.
- [ ] 3.5 Código (GREEN) `src/infrastructure/http/routes/recapture.routes.ts`:
  - [ ] 3.5.1 Firma: quitar `claimLead`/`claimNextLead`/`releaseLead`; agregar `assignBulk: AssignRecaptureLeadsBulk` y `hasAssignPerm: (userId:string)=>Promise<boolean>`; agregar `assign: RequestHandler` al objeto `perms`.
  - [ ] 3.5.2 Montar `PATCH /leads/assign-bulk` (ANTES de `/leads/:id` para evitar captura) gateado `perms.assign`.
  - [ ] 3.5.3 Re-gatear `PATCH /leads/:id/assign`, `POST /ingest-churned`, `POST /import-csv` a `perms.assign`.
  - [ ] 3.5.4 `GET /leads`: si `!await hasAssignPerm(actorId)` → forzar `assigneeId=actorId`, `unassigned=false`.
  - [ ] 3.5.5 `GET /leads/:id`, `PATCH /leads/:id`, `POST /leads/:id/contacts`: si `!await hasAssignPerm(actorId)` → validar `lead.assigneeId===actorId` antes de responder/mutar, sino 404.
- [ ] 3.6 Wiring `src/infrastructure/http/app.ts`: armar `hasRecaptureAssign` (closure sobre `rbacUserRepo`), pasar `new AssignRecaptureLeadsBulk(recaptureRepo, userLookupForScheduling)` + `hasRecaptureAssign` + `assign: requirePerm('recapture','assign')`; quitar wiring de claim/claimNext/release.

## 4. Eliminar self-take + release

- [ ] 4.1 Borrar use cases `src/application/use-cases/recapture/ClaimRecaptureLead.ts`, `ClaimNextRecaptureLead.ts`, `ReleaseRecaptureLead.ts`.
- [ ] 4.2 Retirar `claimNext()` del port `src/domain/ports/RecaptureRepository.ts` + de `PrismaRecaptureRepository.ts` + `InMemoryRecaptureRepository.ts`. Retirar `release()` del port + ambos adapters. **Mantener `claim()`** (usado por tests como setup helper).
- [ ] 4.3 Quitar las rutas `POST /leads/claim-next` y `POST /leads/:id/claim` y `POST /leads/:id/release` del router (ya cubierto en 3.5).
- [ ] 4.4 Adaptar/eliminar tests rotos: en `recapture.usecases.test.ts` quitar bloques de Claim/ClaimNext/Release; en los 4 route tests actualizar la firma de `createRecaptureRouter` (quitar claim/claimNext/release, agregar bulk + hasAssignPerm + perms.assign); migrar setups que usen `repo.claimNext` a `repo.claim`/`repo.assign`. Verificar que nada más importe los use cases borrados.

## 5. Verificación

- [ ] 5.1 `npx jest --runInBand` → toda la suite en verde.
- [ ] 5.2 `npx tsc --noEmit` → sin errores (boundaries hexagonales limpios, sin imports de Prisma en application/domain).
