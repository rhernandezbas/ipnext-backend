# Tasks: recapture-assignable-roles

## 1. Dominio (BE)
- [x] `rbac.ts`: `TECHNICAL_ROLE_CODES = ['tecnico'] as const` + `isTechnicalRoleSet(codes)`
- [x] `ports/UserRoleLookup.ts`: `{ listRoleCodes(userId): Promise<string[]> }`
- [x] `errors/recapture.ts`: `RecaptureAssigneeNotAllowedError` (code `RECAPTURE_ASSIGNEE_NOT_ALLOWED`)

## 2. Aplicación (BE)
- [x] `AssignRecaptureLead`: 3er arg `roleLookup` REQUERIDO; tras existencia, enforce pool → error
- [x] `AssignRecaptureLeadsBulk`: 3er arg; chequeo UNA vez pre-loop (ningún lead tocado si falla)
- [x] Regla: `codes.length > 0 && !isTechnicalRoleSet(codes)`; `operatorId:null` omite el chequeo

## 3. Infraestructura (BE)
- [x] `recapture.routes.ts`: mapear `RecaptureAssigneeNotAllowedError` → **422** `{ error, code }` (ambos endpoints)
- [x] `app.ts`: `roleLookupForRecapture` (envuelve `rbacUserRepo.listRolesForUser → codes`) inyectado en ambos use cases

## 4. Tests BE (TDD — rojo primero)
- [x] `rbac.test.ts`: `isTechnicalRoleSet` (['tecnico']→true, ['noc']→false, []→false, multi)
- [x] `assign-recapture-lead.usecases.test.ts`: técnico→error, sin-rol→error, noc→OK, null→sin chequeo, ghost→ReferenceNotFound
- [x] `assign-recapture-leads-bulk.usecases.test.ts`: técnico→error y NINGÚN lead cambia; noc→OK; sin-rol→error
- [x] `recapture-assign.routes.test.ts`: técnico→422, noc→200, null→200, ghost→400/REFERENCE_NOT_FOUND
- [x] `recapture.routes.test.ts`: bulk técnico→422, ningún lead tocado
- [x] `recapture-refine.routes.test.ts` + `recapture-csv.routes.test.ts`: actualizar 3er arg (stub no-técnico)

## 5. FE
- [x] `useAssignableOperators.ts`: `TECHNICAL_ROLE_CODES` + predicado (active + ≥1 rol + no técnico) + JSDoc
- [x] `LeadDetailDrawer.tsx`: copy empty-state "No hay usuarios disponibles para asignar." + comentarios
- [x] `LeadDetailDrawer.module.css` + `RecaptacionPage.tsx`: comentarios actualizados

## 6. Tests FE (TDD — rojo primero)
- [x] `useAssignableOperators.test.ts`: noc incluido, técnico excluido, sin-rol excluido, multi-rol c/técnico excluido, disabled excluido
- [x] `LeadDetailDrawer.test.tsx`: filtro (admin incluido, técnico/sin-rol excluidos), phantom c/técnico, empty-state copy
- [x] `RecaptacionPage.test.tsx`: A12/A13 (bulk+inline, admin incluido / técnico+sin-rol excluidos), A14 phantom c/técnico

## 7. Gates
- [x] BE: `npx jest <archivos> --forceExit` → 120 passed / 7 suites; `npx tsc --noEmit` limpio
- [x] FE: `npx vitest run <archivos>` → 74 passed (3 suites) + 44 adyacentes; `npx tsc --noEmit` limpio

## 8. Cierre
- [ ] push + PR (coordinar BE + FE). NO ejecutado por pedido (sin push).
