# Tasks: Adoptar pendiente con sesión no-producción (fix radacct-HA-podrido)

> TDD estricto (test primero, red → green). BE-only, sin migración, sin FE.
> Gate de salida: `npm test` verde + `tsc --noEmit` limpio + review adversarial (muta RADIUS).
> No hay push sin OK del usuario.

## 1. Tests (primero — red)

- [ ] 1.1 Extender el helper `session()` de `AutoMovePppoe.pendingInstall.test.ts` para aceptar `framedIp: string | null = null` (default null — no rompe las llamadas existentes).
- [ ] 1.2 NUEVO test (el bug de Ignacio): pendiente creado HOY + sesión con `framedIp='172.31.255.254'` (preinstall, fuera de todo pool) y `startedAt` de hace 3 semanas → **adoptado** (nasId=NAS B, evento `moved`/`auto_install`, `skippedStale=0`).
- [ ] 1.3 RE-ESCRIBIR el test D7.1 "username reciclado" (existente): la sesión del reciclado ahora lleva `framedIp='100.64.43.50'` (IP de producción del pool cgnat de B) → sigue `skipped_stale_session`/`session_predates_service`. Actualizar nombre/comentario a "reciclado con IP de producción".
- [ ] 1.4 NUEVO test (conservador): pendiente + sesión `framedIp=null` que precede al alta → sigue skip (el caso null no adopta).
- [ ] 1.5 Verificar que las regresiones existentes siguen (sesión fresca adopta; mismatch normal viejo → stale; startedAt no parseable + framedIp null → skip).
- [ ] 1.6 Correr SOLO `AutoMovePppoe.pendingInstall.test.ts` → confirmar ROJO (1.2 falla con el código actual; 1.3 falla porque hoy skipea por timestamp sin mirar IP → en realidad hoy 1.3 PASA; el que FALLA es 1.2).

## 2. Implementación (green)

- [ ] 2.1 En `AutoMovePppoe.run()`, tras `cgnatPools`/`publicPools` (~línea 242): `const productionPools = [...cgnatPools, ...publicPools];`.
- [ ] 2.2 En el bloque `else` de la rama adopción (D7.1, ~líneas 343-364): calcular `precedesAlta = !(startedAtMs(winner) >= Date.parse(service.createdAt))` y `winnerIpIsNonProduction = winner.framedIp !== null && !ipInAnyRange(winner.framedIp, productionPools)`; saltar (skippedStale + pendingSkip `session_predates_service`) SOLO si `precedesAlta && !winnerIpIsNonProduction`. Actualizar el `console.warn` para incluir `framedIp`.
- [ ] 2.3 Correr `AutoMovePppoe.pendingInstall.test.ts` → VERDE.
- [ ] 2.4 Correr `AutoMovePppoe.test.ts` (suite W2 del watcher) → VERDE (regresión del freshness de mismatches normales).

## 3. Gate de calidad

- [ ] 3.1 `npm test` — suite completa verde (corrida POR EL ORQUESTADOR, no por el agente).
- [ ] 3.2 `tsc --noEmit` — sin errores de tipos.
- [ ] 3.3 DIP: `application/` no importa `infrastructure/`.

## 4. Review

- [ ] 4.1 Review adversarial (foco: ¿el bypass reintroduce el reciclado? ¿borde framedIp null / winner sin IP? ¿toca el freshness de mismatches normales? ¿el `productionPools` recomputa bien?). Los revisores NO fixean.
- [ ] 4.2 Fix wave si hay hallazgos + re-review focalizada hasta CLEAN.

## 5. Salida

- [ ] 5.1 Actualizar BACKLOG con el resultado (card).
- [ ] 5.2 Commit + push con OK del usuario (deploya a prod). Seguir el run en `gh`.
- [ ] 5.3 Remediación de `IgnacioBellAlt`: adopción manual (independiente del fix) o esperar al deploy.
