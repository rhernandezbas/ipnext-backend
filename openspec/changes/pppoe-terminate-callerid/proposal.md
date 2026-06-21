# Proposal: BE — baja=terminar (borra RADIUS + libera IP) + caller-id (MAC de sesión)

## Intent
Lado BE de Change B (el ORCH ya expone `DELETE /users/:u` + `caller_id` en sesiones):
1. **Baja = terminar**: el botón "Dar de baja" deja de SUSPENDER y pasa a BORRAR el user de RADIUS (libera la IP), vía el `DELETE /users/:u` nuevo del orchestrator.
2. **Caller-id (MAC)**: exponer la MAC de la sesión activa para mostrarla en el panel.

## Scope (BE)
**Feature 2 — baja=terminar:**
- `RadiusOrchestratorGateway`: `deleteUser(username): Promise<void>`. Adapter `HttpRadiusOrchestratorGateway` → `DELETE /users/{username}`. In-memory stub.
- Nuevo `TerminatePppoeService.execute(id, {reason, actorId, actorName})`: findById → si `mikrotik_radius` `orchestrator.deleteUser(username)` (+ `disconnectSessions` best-effort para patear la sesión); si no, `router.removeSecret` (si existe). Luego `repo.upsertByUsername({...,status:'terminated', remoteAddress:null})` (IP liberada, fila como histórico) + `ensureInternet(contractId,false,{reason,actor})` best-effort (registra el evento `deactivated` con motivo, como hoy).
- Rewire `DELETE /api/pppoe/:id`: pasa de `DeactivatePppoeService` a `TerminatePppoeService` (misma ruta/body/reason/actor → CERO cambio FE). `DeactivatePppoeService` queda intacto (no se usa más en rutas, pero no se borra). Confirmar que nada más llama a Deactivate (el corte masivo usa Enforce, no Deactivate).

**Feature 1 — caller-id:**
- `OrchestratorSession` (el tipo de `listSessions`): agregar `callerId: string | null` (mapear el `caller_id` del orchestrator).
- Endpoint lazy `GET /api/pppoe/:id/caller-id` (gate `pppoe.read`): resuelve el PPPoE → `orchestrator.listSessions(username)` → devuelve `{ callerId: string|null }` (la MAC de la sesión activa más reciente, o null si no hay sesión). NO toca el DTO del PPPoE (lazy, no ralentiza la lista del contrato).

## Out of Scope
- FE (otro change: mostrar el caller-id + el baja ya pega a la ruta). El ORCH (ya deployado).

## Affected Areas
| Área | Impacto |
|------|---------|
| `domain/ports/RadiusOrchestratorGateway.ts` | +`deleteUser`, +`callerId` en OrchestratorSession |
| `infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway.ts` | +`deleteUser` (DELETE /users/:u), mapear caller_id |
| `infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway.ts` | stubs |
| `application/use-cases/TerminatePppoeService.ts` | New |
| `infrastructure/http/routes/pppoe.routes.ts` | DELETE /pppoe/:id → Terminate; +GET /pppoe/:id/caller-id |
| `infrastructure/http/app.ts` | wiring (+ composition test) |

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Baja borra de RADIUS pero el orchestrator falla | Media | red-primero: si `deleteUser` falla (502), la DB NO cambia (no miente); el patrón ya existe |
| Baja irreversible por error del operador | Media | El FE ya pide MOTIVO (modal) antes de la baja; confirm explícito |
| Romper algo que use Deactivate | Baja | Confirmado: solo la ruta DELETE /pppoe/:id lo usa; el corte masivo usa Enforce |
| caller-id lazy agrega latencia | Baja | Endpoint dedicado, solo se llama al abrir el panel |

## Success Criteria
- [ ] `DELETE /api/pppoe/:id` (con motivo) borra el user de RADIUS (libera IP) + status='terminated' + evento en historial.
- [ ] `GET /api/pppoe/:id/caller-id` devuelve la MAC de la sesión activa (o null).
- [ ] `npm test` verde + tsc limpio; review GO. (Deploy DESPUÉS del ORCH, ya live.)
