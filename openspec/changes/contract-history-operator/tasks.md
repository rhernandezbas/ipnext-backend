# Tasks — contract-history-operator (#117)

> STRICT TDD: cada bloque de impl va precedido de su test en rojo (RED) → impl mínima (GREEN) → refactor.
> NO hay migración de schema (la relación `actor` ya existe). NO se cambia el shape del DTO (`actorName` se mantiene).

## Fase 0 — Confirmación previa (sin código)
- [ ] 1. Confirmar que `actor RbacUser?` existe en ambos modelos (`schema.prisma` TV `:2439`, no-TV `:2465`) — NO crear migración
- [ ] 2. Confirmar que el DTO ya expone `actorName` (`contract-services.dto.ts:86`, mapeo TV `:147`) — NO tocar el DTO
- [ ] 3. Confirmar (grep) que `actorName` es el único nombre de campo del operador en el wire — el FE no se toca

## Fase 1 — Fix read-side: JOIN al operador en adapters Prisma (RED → GREEN)
- [ ] 4. RED: test del mapper/adapter CSE — `toEvent` resuelve las 3 ramas:
      `{ actorName:'', actor:{login:'admin'} }` → `'admin'`;
      `{ actorName:'real', actor:{login:'admin'} }` → `'real'` (snapshot gana);
      `{ actorName:'', actor:null }` → `''`
- [ ] 5. GREEN: `PrismaContractServiceEventRepository.listByContract` += `include: { actor: { select: { login: true } } }`; `toEvent`: `actorName: row.actorName || row.actor?.login || ''`
- [ ] 6. RED: test del mapper/adapter TV — mismas 3 ramas para `PrismaTvActivationEventRepository.toEvent`
- [ ] 7. GREEN: `PrismaTvActivationEventRepository` += `actor: { select: { login: true } }` en el `include` de `listByContract` (`:66-74`), `listByClient` (`:33-41`) y `list` (`:43-63`); `toEvent`: `actorName: row.actorName || row.actor?.login || ''`

## Fase 2 — Use-case: confirmar que propaga el operador (RED → GREEN)
- [ ] 8. RED: `ListContractServiceHistory.test.ts` — servicio con evento `actorName:"jperez"` (CSE y TV) → `item.events[].actorName === "jperez"`; assert sin `tvPassword` en la respuesta
- [ ] 9. RED: mismo test — servicio SIN eventos → events sintéticos con `actorName:''` (la síntesis NO inventa operador)
- [ ] 10. GREEN: el use-case ya propaga `actorName` — NO debería requerir cambio. Si el test rojo revela un gap (p.ej. un mapeo que pisa `actorName`), corregir mínimamente en `ListContractServiceHistory.ts`

## Fase 3 — SEAM completo (ruta real → use-case → repo in-memory → historial) (RED → GREEN)
- [ ] 11. RED: `contractHistoryOperator.routes.test.ts` (supertest, app real, repos in-memory, user autenticado "jperez"):
      `POST /api/contracts/:id/services` → `GET /api/contracts/:id/service-history` → evento `activated` con `actorName:"jperez"`
- [ ] 12. RED: misma suite — `PATCH .../services/:id` (active→inactive→active) → eventos `deactivated`/`reactivated` con operador; `DELETE` → `deactivated` con operador
- [ ] 13. RED: misma suite — seed de un evento con `actorName:''` + `actorId` de RbacUser "admin" → `GET service-history` → `actorName:"admin"` (verifica el JOIN end-to-end; usar el adapter Prisma o un in-memory que simule el fallback según cómo esté wireado el test)
- [ ] 14. RED: misma suite — 401 sin auth, 403 sin `clients.read`; `tvPassword` ausente en todo el body
- [ ] 15. GREEN: hacer pasar 11-14. El threading de write ya existe (`actorOf`, register, cancel); ajustar SOLO si un test rojo expone un call-site que pierde el actor con `req.user` presente

## Fase 4 — (Opcional) SEAM TV register/cancel si la batería in-memory lo permite
- [ ] 16. RED/GREEN: reusar patrón `gigared.activation-history.routes.test.ts` para verificar que `register` (alta) y `cancel` (baja) graban el operador y aparece en el historial del contrato. Si la complejidad de wiring de gigared con in-memory es alta, dejar cubierto a nivel use-case (`RegisterGigaredAccount`/`CancelTvJobRunner` ya threadean) y documentar

## Fase 5 — Paridad y degradación (RED → GREEN)
- [ ] 17. Documentar en el test de paridad de adapters que la resolución `actorId→login` es exclusiva del adapter Prisma (el InMemory devuelve el snapshot sembrado; el JOIN es persistencia-specific, igual que `customerName` del #106)
- [ ] 18. Pinear la degradación: evento con `actorId:null` + `actorName:''` → `''` (no falla, no omite el evento)

## Gates
- [ ] 19. `npx tsc --noEmit` 0 errores
- [ ] 20. jest targeted verde: mapper/adapter CSE+TV, `ListContractServiceHistory`, ruta SEAM
- [ ] 21. Confirmar NO se creó migración ni se corrió `migrate dev`/`migrate diff` (no hay cambio de schema)
- [ ] 22. Confirmar wire contract intacto: `actorName` (string) sigue siendo el campo del operador; FE no requiere cambio
