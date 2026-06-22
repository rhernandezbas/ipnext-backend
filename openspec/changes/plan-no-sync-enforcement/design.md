# Design: plan-no-sync-enforcement

## Contexto
Los grupos de enforcement (`IP-REDUCCION`, `IP-BAJA`) son del orchestrator. Hoy viven en el catálogo de
Prominense (categoría `Corte`) y se sincronizan como cualquier plan vía `syncPlan`/`deletePlan`.

## Decisión 1 — criterio de exclusión: el CÓDIGO (no la categoría)
Prominense excluye por CÓDIGO (`ENFORCEMENT_PLAN_CODES = {IP-REDUCCION, IP-BAJA}`), centralizado en
`isEnforcementPlan(code)` (domain). Se eligió el código —y NO la categoría— por dos razones (judgment-day):
1. El orchestrator reserva por CÓDIGO (`is_reserved_groupname`); usar la MISMA dimensión evita el mismatch
   (un plan con código reservado pero categoría `Air` igual debe excluirse, y viceversa).
2. El `code` es INMUTABLE (`UpdatePlanInput` no lo incluye) → no hay transiciones de categoría que dejen
   RADIUS y DB inconsistentes.
Alternativa descartada: filtrar por categoría `Corte` (editable) — abría mismatch con el orchestrator y
estados inconsistentes en transiciones Corte↔no-Corte.

## Decisión 2 — defense-in-depth (2 repos), AMBOS por código
La protección vive en DOS lugares, los dos por CÓDIGO:
- (a) Prominense NO intenta sincronizar los códigos de enforcement (este cambio).
- (b) El orchestrator RECHAZA el PUT/DELETE de esos códigos (cambio coordinado).
Mantener `ENFORCEMENT_PLAN_CODES` (Prominense) alineado con `is_reserved_groupname` (orchestrator).

## Decisión 3 — orden de deploy
Este cambio (Prominense) va PRIMERO; el del orchestrator (reservar) SEGUNDO. Así nunca hay una ventana
donde Prominense sincronice un código que el orchestrator ya rechaza (que rompería el catálogo).

## Fuera de scope
- La reserva en el orchestrator (change aparte, va segundo).
- Quitar `IP-REDUCCION`/`IP-BAJA` del catálogo de Prominense (siguen ahí; solo no se sincronizan).
