# Change: recapture-assignable-roles

## Why
La recaptación (recovery de clientes churned) hoy restringe el pool de operadores
asignables a un ÚNICO rol: `ventas`. El FE filtra `roles.some(r => r.code === 'ventas')`
(`useAssignableOperators.ts`) y el BE NO valida rol alguno — `AssignRecaptureLead` /
`AssignRecaptureLeadsBulk` sólo chequean que el usuario exista. Negocio pidió abrir el
pool: administración, NOC y otros perfiles también trabajan recaptación. El ÚNICO perfil
que NO debe recibir leads es el técnico de campo (`tecnico`).

Además hoy no hay enforcement en el backend: un cliente API podría asignar a cualquier
usuario existente (incluido un técnico) salteándose el filtro visual del FE.

## What changes
- **Regla nueva de asignable**: usuario ACTIVO **Y** con al menos un rol **Y** ninguno de
  sus roles es técnico. Un usuario activo SIN roles NO es asignable. Sólo `tecnico` se
  excluye (`noc` SÍ puede recibir).
- **Enforcement DOBLE CAPA**:
  - **FE** (`useAssignableOperators`): predicado nuevo; los 3 selects (inline, bulk toolbar,
    drawer) leen del mismo hook.
  - **BE** (`AssignRecaptureLead`, `AssignRecaptureLeadsBulk`): tras validar existencia, si
    el target no es asignable → `RecaptureAssigneeNotAllowedError`. En el bulk el chequeo es
    UNA vez, antes del loop (ningún lead se toca si falla).
- **Contrato de error BE↔FE**: HTTP **422** `{ error, code: 'RECAPTURE_ASSIGNEE_NOT_ALLOWED' }`.
- `operatorId: null` (desasignar) OMITE el chequeo.

## Impact
- Affected code (BE): `domain/entities/rbac.ts` (helper), `domain/ports/UserRoleLookup.ts`
  (port nuevo), `domain/errors/recapture.ts` (error nuevo), `AssignRecaptureLead`,
  `AssignRecaptureLeadsBulk`, `recapture.routes.ts` (mapeo 422), `app.ts` (wiring del
  roleLookup).
- Affected code (FE): `hooks/useAssignableOperators.ts` (predicado + constante), copy del
  empty-state en `LeadDetailDrawer.tsx` + comentarios (drawer, CSS, RecaptacionPage).
- Comportamiento: se ABRE el pool (admin/administracion/noc ahora asignables) y se CIERRA el
  agujero del BE (técnicos y sin-rol rechazados con 422). Aditivo salvo el cambio de copy.
- Migraciones: ninguna. Sin cambios de schema.
