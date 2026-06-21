# Proposal: PPPoE motivo — polish del review (A/B/C)

## Intent

Cerrar los 3 detalles que dejó el review de `pppoe-baja-motivo` (todos menores, aditivos, no bloqueaban):

- **A** (completeness): el evento `activated` del alta se grababa SIN el operador (`actorName=''`). Threading del actor por `AssociatePppoeToContract` + `CreatePppoeService` + sus rutas POST → ahora el alta del historial muestra quién la hizo (paridad con TV).
- **B** (cosmético): en `pppoe.routes.ts` el `const BajaBodySchema` quedó entre bloques de `import` → movido debajo de los imports (convención `import/first`).
- **C** (UX): `handleDeassociate` (FE) no tenía manejo de error → agregado `try/catch` + banner `role="alert"` (espeja `handleBaja`; 404 = idempotente).

## Scope

### In Scope
- BE: `AssociatePppoeToContract.execute(.., actor?)` + `CreatePppoeService.execute(input, actor?)` → pasan `{actorId, actorName}` a `ensureInternet(true)`. Rutas `POST /pppoe/:id/associate` y `POST /contracts/:cid/pppoe` pasan `actorOf(req)`. Param **opcional** (back-compat total con tests).
- BE: reorden del import en `pppoe.routes.ts`.
- FE: `handleDeassociate` con try/catch + `deassociateError` banner.

### Out of Scope
- Cambios de comportamiento (todo aditivo).

## Risks
Mínimos: el actor es param opcional (tests sin actor siguen verdes); el banner es aditivo; el import es cosmético (tsc valida).

## Success Criteria
- [ ] El alta de PPPoE (asociar/crear) registra el evento `activated` con el operador.
- [ ] Import ordenado; `tsc` limpio.
- [ ] Desasociar con error → banner; 404 silencioso.
- [ ] BE + FE tests verdes; tsc/typecheck limpios.
