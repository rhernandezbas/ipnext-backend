# Change: plan-no-sync-enforcement

## Why
`CreatePlan`/`UpdatePlan`/`DeletePlan` sincronizan TODO plan al orchestrator (`syncPlan`/`deletePlan`),
incluidos `IP-REDUCCION`/`IP-BAJA` (categoría `Corte`), que son grupos de ENFORCEMENT que el orchestrator
posee. Como parte del fix "orchestrator dueño de los grupos de enforcement" (defense-in-depth), el
orchestrator va a RESERVAR esos códigos (rechazar PUT/DELETE). Si Prominense los sigue sincronizando, el
orchestrator los rechazaría y rompería el create/update/delete del catálogo.

Este cambio va PRIMERO (antes del cambio del orchestrator): Prominense deja de sincronizar los planes de
enforcement, de modo que cuando el orchestrator empiece a rechazarlos, ya nadie le mande PUT/DELETE.

## What changes
- Helper de dominio `isEnforcementPlan(code)` con el set `ENFORCEMENT_PLAN_CODES` (`IP-REDUCCION`,
  `IP-BAJA`) en `domain/entities/plan.ts`. El criterio es el CÓDIGO (inmutable), NO la categoría.
- `CreatePlan`/`UpdatePlan`/`DeletePlan` NO llaman al orchestrator (`syncPlan`/`deletePlan`) para planes
  cuyo código es de enforcement — los crean/actualizan/borran solo en la DB local de Prominense.

## Impact
- Affected specs: plan-management.
- Affected code: `domain/entities/plan.ts`, `application/use-cases/{CreatePlan,UpdatePlan,DeletePlan}.ts`.
- Cambio COORDINADO con el orchestrator (reservar IP-REDUCCION/IP-BAJA). Este va PRIMERO en el orden de deploy.
- Los planes comerciales (no-`Corte`) siguen sincronizándose exactamente igual.
