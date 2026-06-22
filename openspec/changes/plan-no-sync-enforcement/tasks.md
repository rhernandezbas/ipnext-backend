# Tasks: plan-no-sync-enforcement

## 1. Dominio
- [x] `isEnforcementPlan(category)` + `ENFORCEMENT_PLAN_CATEGORY` en `domain/entities/plan.ts`

## 2. Use cases
- [x] `CreatePlan`: saltar `syncPlan` si categoría `Corte`
- [x] `UpdatePlan`: saltar `syncPlan` si categoría FINAL `Corte`
- [x] `DeletePlan`: saltar `deletePlan` si categoría `Corte`

## 3. Tests (TDD — rojo primero)
- [x] `PlanCorteNoSync.test.ts`: Create/Update/Delete NO sincronizan Corte; no-Corte SÍ
- [x] suite de plan verde (18) + `tsc --noEmit` limpio

## 4. Cierre
- [x] suite COMPLETA verde + tsc limpio
- [x] judgment-day round 1 → fix: criterio por CÓDIGO (no categoría) — resuelve mismatch + transiciones
- [x] judgment-day round 2 → APPROVED. Bug de Round 1 resuelto; 2 WARNINGs de robustez pre-existente
      (ROUTER_REDUCED_PROFILE vs set; code sin normalizar) → deuda documentada (engram + comentario en plan.ts)
- [ ] push + PR (va PRIMERO; el change del orchestrator va SEGUNDO)
