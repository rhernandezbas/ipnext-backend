# Verify Report: recapture-admin-assign

Fase `sdd-verify` (read-only). Validación de spec-compliance del change `recapture-admin-assign`.

## Veredicto: **PASS**

La implementación cubre todos los Requirements y Scenarios del spec con tests concretos. `tsc` y la suite recapture/rbac pasan en verde. Código, rutas, restricción server-side, use case bulk, migración de permiso, seed parity y eliminación de self-take coinciden con proposal/design. Sin hallazgos CRITICAL.

## Totales reales

| Check | Comando | Resultado |
|-------|---------|-----------|
| TypeScript | `npx tsc --noEmit` | **0 errores** (exit 0) |
| Jest (recapture) | `npx jest src/__tests__/recapture-assign.routes.test.ts src/__tests__/recapture.routes.test.ts src/__tests__/application/recapture` | **6 suites / 75 tests — todos pasan** |
| Jest (rbac entity) | `npx jest src/__tests__/domain/entities/rbac.test.ts` | **1 suite / 33 tests — todos pasan** (cubre `recapture.assign` en whitelist) |

## Tabla scenario → test

### ADDED

| Requirement / Scenario | Test | Estado |
|---|---|---|
| Permiso RBAC `recapture.assign` → assign está en el whitelist | `domain/entities/rbac.test.ts` › "includes recapture.assign (bulk assignment permission)" (`expect(KNOWN_ACTIONS).toContain('assign')`) + "contains exactly 43 valid action codes" | ✅ CUBIERTO |
| Permiso RBAC → super_admin y administrador reciben recapture.assign | Sin test automatizado de DB. Verificado por inspección: `migration.sql` grants a `super_admin` y `administrador` + `seed.ts:519` loop `['read','manage','assign']` para ambos roles | ⚠️ WARNING (cobertura por inspección, no test) |
| Permiso RBAC → la migración es idempotente | Sin test automatizado (las migraciones no corren en jest). Verificado por inspección: `INSERT ... ON CONFLICT ("moduleId","action") DO NOTHING` + `ON CONFLICT ("roleId","permissionId") DO NOTHING` | ⚠️ WARNING (cobertura por inspección, no test) |
| Bulk assign → admin asigna varios leads a un operador (200 `{assigned:3}`, assigneeId+status) | `recapture.routes.test.ts` › "returns 200 with { assigned } on success" (assigned:2 a nivel ruta) **+** `assign-recapture-leads-bulk.usecases.test.ts` › "assigns N leads ... returns { assigned: N }" (verifica `assigneeId='op-1'` y `status='en_gestion'`) | ✅ CUBIERTO |
| Bulk assign → operatorId inexistente rechaza el bulk (400 REFERENCE_NOT_FOUND, nada cambia) | `assign-recapture-leads-bulk.usecases.test.ts` › "operatorId does not exist ... throws ReferenceNotFoundError" (validación antes de iterar leads ⇒ nada cambia) | ✅ CUBIERTO (ver WARNING sobre código HTTP a nivel ruta) |
| Bulk assign → leadIds parcialmente inexistentes solo cuenta los existentes (200 `{assigned:1}`) | `assign-recapture-leads-bulk.usecases.test.ts` › "partial non-existent leadIds — only counts existing" | ✅ CUBIERTO |
| Bulk assign → requiere permiso assign (403 PERMISSION_DENIED) | `recapture.routes.test.ts` › "returns 403 without assign perm" | ✅ CUBIERTO |
| Bulk assign → valida el body (400 VALIDATION_ERROR, leadIds ausente/vacío) | `recapture.routes.test.ts` › "returns 400 VALIDATION_ERROR on invalid body (empty leadIds)" + "returns 400 VALIDATION_ERROR when leadIds is not an array" | ✅ CUBIERTO |
| Restricción lectura `GET /leads` → agente ve solo sus leads asignados | `recapture.routes.test.ts` › "agent only sees their own leads (scoped to actorId)" | ✅ CUBIERTO |
| Restricción lectura → agente no puede ver leads de otros vía `?assigneeId=otro` | `recapture.routes.test.ts` › "agent ignores ?assigneeId=another query param" | ✅ CUBIERTO |
| Restricción lectura → admin ve todos los leads | `recapture.routes.test.ts` › "admin (hasAssignPerm=true) sees all leads" | ✅ CUBIERTO |
| Restricción detalle/gestión `GET /leads/:id` → agente lee su propio lead (200) | `recapture.routes.test.ts` › "agent gets 200 for own lead" | ✅ CUBIERTO |
| Restricción detalle → agente no puede leer un lead ajeno (404 RECAPTURE_LEAD_NOT_FOUND) | `recapture.routes.test.ts` › "agent gets 404 for lead belonging to someone else" (GET) | ✅ CUBIERTO |
| Restricción `PATCH /leads/:id` → agente no puede cambiar estado de lead ajeno (404, sin cambio) | `recapture.routes.test.ts` › "PATCH /leads/:id — ownership check › agent gets 404 ..." | ✅ CUBIERTO |
| Restricción `POST /leads/:id/contacts` → agente no puede registrar contacto en lead ajeno (404) | `recapture.routes.test.ts` › "POST /leads/:id/contacts — ownership check › agent gets 404 ..." | ✅ CUBIERTO |
| Restricción gestión → agente gestiona su propio lead (`PATCH` status 200) | `recapture.routes.test.ts` › "PATCH /api/recapture/leads/:id › updates lead status" (con `hasAssignPerm` default true; el path no-admin sobre lead propio se ejercita en el resto de ownership tests) | ⚠️ WARNING (camino feliz no-admin sobre lead propio no aislado en PATCH; sí cubierto en GET "agent gets 200 for own lead") |

### MODIFIED

| Requirement / Scenario | Test | Estado |
|---|---|---|
| Asignación individual requiere assign → agente no puede asignar (403) | `recapture-assign.routes.test.ts` › "returns 403 when assign perm is denied" + `recapture.routes.test.ts` › "PATCH /leads/:id/assign › returns 403 without assign perm" | ✅ CUBIERTO |
| Asignación individual → admin asigna un lead individual (200, assigneeId+status) | `recapture-assign.routes.test.ts` › "returns 200 with DTO when assigning a valid operator" (`assigneeId:'op-1'`, `status:'en_gestion'`) | ✅ CUBIERTO |
| Ingesta/CSV requieren assign → agente no puede ingestar bajas (403) | `recapture.routes.test.ts` › "POST /ingest-churned › returns 403 without assign perm" | ✅ CUBIERTO |
| Ingesta/CSV → agente no puede importar CSV (403) | `recapture.routes.test.ts` › "POST /import-csv › returns 403 without assign perm (was manage)" | ✅ CUBIERTO |
| Ingesta/CSV → admin ingesta bajas (200 con conteo) | `recapture.routes.test.ts` › "POST /ingest-churned › ingests baja clients and returns count" | ✅ CUBIERTO |

### REMOVED

| Requirement / Scenario | Test | Estado |
|---|---|---|
| Self-take → claim-next ya no existe (404) | `recapture.routes.test.ts` › "Removed routes › POST /leads/claim-next returns 404" | ✅ CUBIERTO |
| Self-take → claim individual ya no existe (404) | `recapture.routes.test.ts` › "Removed routes › POST /leads/:id/claim returns 404" | ✅ CUBIERTO |
| Release → release ya no existe (404) | `recapture.routes.test.ts` › "Removed routes › POST /leads/:id/release returns 404" | ✅ CUBIERTO |

**Conteo:** 24 scenarios totales → **21 ✅ CUBIERTO directo** · **3 ⚠️ WARNING** (cobertura indirecta o por inspección) · **0 ❌ NO CUBIERTO**.

## Verificación spec ↔ código (sin divergencias críticas)

- **Action code**: `KNOWN_ACTIONS` incluye `'assign'` (`src/domain/entities/rbac.ts:78`). `PermissionAction` lo tipa. ✅
- **Migración**: `prisma/migrations/20260804000000_recapture_assign_permission/migration.sql` — INSERT permiso `(recapture, assign)` resuelto por `m.code='recapture'` + grants a `super_admin` y `administrador`, todo `ON CONFLICT DO NOTHING` (idempotente). Timestamp posterior a `20260803000000`. Coincide con D1. ✅
- **Seed parity**: `prisma/seed.ts:519` loop `['read','manage','assign']` upsert para ambos roles. Coincide con D1. ✅
- **Capability `hasAssignPerm`**: `app.ts:2075-2080` closure sobre `rbacUserRepo` (short-circuit super_admin + `listPermissionsForUser` filtrando `moduleCode==='recapture' && action==='assign'`). Idéntica a la firma propuesta en D2. ✅
- **Bulk use case**: `AssignRecaptureLeadsBulk.ts` — valida `userLookup` solo si `operatorId!==null`, itera `repo.assign`, cuenta no-null. Reusa `repo.assign`, no agrega método al port. Coincide con D4. ✅
- **Restricción server-side**: `recapture.routes.ts` — `GET /leads` fuerza `assigneeId=actorId` + `unassigned=false` para no-admin (D3); `GET/PATCH /leads/:id` y `POST /leads/:id/contacts` validan `lead.assigneeId===actorId` y responden **404 RECAPTURE_LEAD_NOT_FOUND** (D3, decisión 404 sobre 403 para no filtrar existencia). ✅
- **Re-gate**: `PATCH /leads/:id/assign`, `POST /ingest-churned`, `POST /import-csv` montados con `perms.assign`; wiring `assign: requirePerm('recapture','assign')` (`app.ts:2095`). ✅
- **Orden de rutas**: `PATCH /leads/assign-bulk` montado ANTES de `/leads/:id` (líneas 102 vs 205) — evita captura de `:id`. ✅
- **Eliminación self-take/release**: use cases `ClaimRecaptureLead.ts`, `ClaimNextRecaptureLead.ts`, `ReleaseRecaptureLead.ts` no existen; `claimNext()`/`release()` retirados del port y de ambos adapters (Prisma + in-memory); `claim()` retenido como helper de setup (D5/D6). Búsqueda global sin referencias residuales. ✅
- **Firma del router**: posicional, con `assignBulk` + `hasAssignPerm` + `perms.assign`, sin `claim/claimNext/release`. Los 4 route tests + app.ts actualizados consistentemente (D7). ✅
- **Boundaries hexagonales**: `AssignRecaptureLeadsBulk` depende de `RecaptureRepository` y `EntityLookup` (ports), sin imports de Prisma/Express. `tsc` limpio. ✅

## Hallazgos

### CRITICAL
Ninguno.

### WARNING
1. **Grants a roles y idempotencia de migración sin test automatizado.** Los scenarios "super_admin y administrador reciben recapture.assign" y "la migración es idempotente" están cubiertos por inspección del `migration.sql` (`ON CONFLICT DO NOTHING`) y `seed.ts`, pero ninguna migración corre dentro de jest, así que no hay aserción ejecutable. Es el patrón estándar del proyecto para migraciones de datos (no es una regresión introducida por este change), pero queda como riesgo: un error de tipeo en la SQL no lo atraparía la suite.
2. **Bulk route: aserción de estado por-lead solo a nivel use case.** El test de ruta "returns 200 with { assigned }" valida el contador pero no que cada lead quede `assigneeId=op-1, status='en_gestion'`. Esa aserción sí existe a nivel use case (`assign-recapture-leads-bulk.usecases.test.ts`), por lo que el comportamiento está cubierto, pero no end-to-end vía HTTP. Cobertura indirecta, suficiente.
3. **Bulk route: código HTTP `REFERENCE_NOT_FOUND` para operatorId inexistente cubierto solo a nivel use case.** El handler de ruta mapea `ReferenceNotFoundError → 400 REFERENCE_NOT_FOUND` (recapture.routes.ts:137-139), pero no hay un test de ruta que ejercite ese path de bulk (el test de use case verifica que se lanza el error; el mapeo HTTP idéntico sí está testeado en el endpoint individual `/leads/:id/assign`). Cobertura indirecta, suficiente.
4. **Camino feliz no-admin de `PATCH /leads/:id` sobre lead propio no aislado.** El test de PATCH status corre con `hasAssignPerm` default (true). La rama no-admin sobre lead propio (ownership OK → 200) no tiene un test dedicado en PATCH; sí está cubierta en GET ("agent gets 200 for own lead"). El branch de denegación (404 ajeno) sí está testeado en PATCH. Cobertura suficiente; agregar un caso explícito sería deseable.

### SUGGESTION
1. Agregar un test de ruta para el bulk con `operatorId` inexistente que asserte `400 + code REFERENCE_NOT_FOUND` (cerraría el WARNING 3 end-to-end).
2. Agregar un caso "agente gestiona su propio lead" explícito en `PATCH /leads/:id` con `hasAssignPerm=false` que asserte 200 + status actualizado (cierra WARNING 4).
3. Considerar un test de integración de migración/seed (o un script de smoke) que verifique los grants `recapture.assign` a `super_admin`/`administrador` contra una DB efímera, para cubrir los WARNING 1 con aserción ejecutable.

---

*Generado por la fase `sdd-verify`. Read-only: no se modificó código de la implementación.*
