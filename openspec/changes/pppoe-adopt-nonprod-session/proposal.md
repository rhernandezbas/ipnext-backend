# Proposal: Adoptar un pendiente cuya sesión NO es de producción (fix radacct-HA-podrido)

> **(bug de prod 2026-07-03, `IgnacioBellAlt`)** — el watcher de auto-instalación NO adopta a un cliente que ya venía conectado antes del alta (caso: migrar un cliente EXISTENTE de `/ppp secret` local → RADIUS). El gate D7.1 usa el `acctstarttime` del `radacct`, que el RADIUS HA master-master CORROMPE (session-id reusado + Start/Stop cruzados entre r1/r2 → `acctstarttime` clavado en el pasado). Fix mínimo: distinguir el reciclado real del CPE-esperando por la **IP de la sesión**, no por el timestamp.

## Intent

Que `AutoMovePppoe` **adopte** un servicio pendiente (nasId null) cuya sesión ganadora tiene una IP que **no es de producción** (pool preinstall/temporal), aunque su `acctstarttime` preceda al alta del servicio — porque ese timestamp lo corrompe el RADIUS HA y no es una señal confiable de "reciclado".

## Why

- **Bug observado en prod:** `IgnacioBellAlt` (cliente existente migrando local→RADIUS) cae en el pool-preinstall (`172.31.255.254`) del NAS Estudiantes. El `radacct` reporta su sesión con `acctstarttime` de AYER (session-id reusado + HA master-master), aunque el router (`/ppp active`) la muestra recién conectada (uptime 9 min). El gate D7.1 calcula `startedAt(ayer) >= createdAt(hoy)` = FALSE → `skipped_stale_session` / `session_predates_service` → **skip ETERNO**. El CPE puede reconectar infinitas veces; el `radacct` sigue diciendo "ayer".
- **La señal correcta es la IP, no el timestamp.** Un pendiente legítimo se crea SIN Framed-IP → el RADIUS no le asigna IP fija → el NAS lo manda a su pool local (preinstall `172.31.255.x`). La ÚNICA forma de que un pendiente tenga sesión con IP de **producción** (cgnat/public) es el reciclado real (username de un cliente viejo que sí tenía Framed-IP). El rango preinstall (`172.31.255.0/24`, privado reservado) **jamás solapa** producción (`100.64.x` cgnat / `190.7.x` public) — verificado en la carga del pool-preinstall (W0.5).
- **Cubre todos los NAS gratis:** como la señal es "la IP NO está en ningún pool de producción conocido", cualquier rango temporal (incluido el del NE8000, distinto de `172.31.255.x`) queda cubierto sin registrar nada.
- **Esfuerzo mínimo:** 1 archivo (`AutoMovePppoe.ts`) + tests. Sin migración, sin enum de DB, sin config.

## Scope

### In Scope

- En el gate D7.1 (rama ADOPCIÓN de `AutoMovePppoe.run()`): saltar por `session_predates_service` SOLO si la sesión precede al alta **Y** su `framedIp` es de producción (∈ pools cgnat/public) **o es desconocido (null)**. Si el `framedIp` es demostrablemente no-producción (preinstall/temporal) → NO saltar, adoptar.
- Precomputar `productionPools = [...cgnatPools, ...publicPools]` una vez por tick.
- Tests TDD: el nuevo caso (adopta con IP preinstall que precede) + actualizar el test del reciclado (ahora su sesión lleva IP de producción) + el caso conservador (framedIp null → skip).

### Out of Scope

- **Registrar el pool-preinstall como `IpPool`/`ipKind`** (opción B descartada por el usuario a favor de la mínima). No hay migración ni cambio de enum.
- El **freshness gate de los mismatches NORMALES** (no-adopción, `AutoMovePppoe.ts:326-342`) — intacto: la exención es SOLO para adopciones.
- La causa del `radacct` podrido (session-id reusado + HA master-master) — es un problema del RADIUS/NAS, se documenta como deuda aparte; este fix hace al watcher robusto ante datos podridos.
- FE — server-side puro, sin cambios de contrato.

## Capabilities

### Modified Capabilities

- `pppoe-autoinstall-adoption`: la adopción de un pendiente deja de depender del `acctstarttime` (que el HA corrompe) para decidir "reciclado vs instalación". Ahora usa la **IP de la sesión**: producción/desconocida + precede → skip; no-producción → adopta.

## Approach

1. En `AutoMovePppoe.run()`, tras `cgnatPools`/`publicPools`, agregar `const productionPools = [...cgnatPools, ...publicPools];`.
2. En el bloque `else` de la rama adopción (D7.1), reemplazar la condición de skip `!(startedAt >= createdAt)` por: skip solo si `precedesAlta && !winnerIpIsNonProduction`, donde `winnerIpIsNonProduction = winner.framedIp !== null && !ipInAnyRange(winner.framedIp, productionPools)`.
3. TDD (red → green): tests primero (el nuevo de preinstall FALLA con el código actual; el del reciclado se re-escribe con IP de producción), luego el fix.
4. Gate: `npm test` verde + `tsc --noEmit` limpio + review adversarial (muta RADIUS).

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/application/use-cases/AutoMovePppoe.ts` | Modified | `productionPools` + condición de skip del gate D7.1 por IP |
| `src/__tests__/application/AutoMovePppoe.pendingInstall.test.ts` | Modified | Helper `session()` acepta `framedIp`; nuevo test preinstall-precede→adopta; reciclado re-escrito con IP producción; caso conservador null |

> Sin cambios en migración, schema, DTOs, rutas, FE, ni en el core `MovePppoeToNas`.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| El bypass reintroduce el vector del reciclado que D7.1 cerró | Baja | Un reciclado real tiene la colgada con IP de PRODUCCIÓN (cgnat/public) → sigue en skip. Solo una IP no-producción adopta; y el reciclado con IP pública de pool NO cargado (doblemente improbable) se corrige con move manual |
| `framedIp` null adopta un reciclado | Muy Baja | Decisión conservadora: null → mantener el skip por nacimiento (no se puede afirmar preinstall). En prod las sesiones traen su `framedipaddress` |
| Rompe el freshness de mismatches normales | Nula | La rama modificada es SOLO `isAdoption`; el gate C1 de mismatches (`:326-342`) no se toca (regresión cubierta por la suite W2) |

## Rollback

Revertir el cambio en `AutoMovePppoe.ts` — vuelve al gate D7.1 por timestamp. Sin data persistida ni migración.

## Review adversarial + fix wave (2026-07-03)

2 revisores (correctness/seguridad + regresión/integración). Hallazgos y resolución:

- **CRITICAL — clasificador FAIL-OPEN (R1):** `!ipInAnyRange(ip, productionPools)` no significa "IP positivamente no-producción" sino "no está en los pools CARGADOS". Con `productionPools` vacío (NAS sin pools / read incompleto) o `framedIp` basura (`''`, malformada), clasificaba cualquier cosa como no-producción → adoptaba un reciclado real. Y el circuit breaker NO cubre adopciones → falla silenciosa y sin tope. **FIXEADO:** clasificador fail-SAFE — `winnerIp !== null && isIpv4(winnerIp) && productionPools.length > 0 && !ipInAnyRange(...)`. Ante la duda, skip. Helper `isIpv4()` nuevo en `ipMath`. +3 tests (pools vacíos → skip; framedIp `''` → skip; reciclado IP pública → skip) + tests unitarios de `isIpv4`.
- **HIGH → deuda ACEPTADA (R1):** una IP de producción REAL en un rango que NO está cargado como `IpPool` se clasifica no-producción → un reciclado con esa IP se adoptaría. Inherente a la heurística "no está en producción conocida". Trade-off aceptado por el usuario (mínima vs pool registrado): doblemente improbable (reciclado + pool no cargado) y corregible con move manual. Documentado en el comentario del código.
- **MEDIUM → por diseño (R2):** un pendiente-que-precede con IP preinstall antes se descartaba sin consumir slot; ahora entra al cap. En una migración masiva local→RADIUS, varios "Ignacio" compiten por `maxMovesPerTick` y pueden `deferred` a mismatches/otras adopciones. No es bug (el breaker no se toca, los diferidos reintentan el próximo tick); es la dinámica buscada. Documentado.
- **Sin regresiones** (R2): breaker/cap intactos, downstream de adopción OK, ningún otro test atado al gate viejo, freshness de mismatches normales sin tocar.

### Re-review focalizada (fix wave 2)

Un 3er revisor sobre la fix wave 1 confirmó el CRITICAL cerrado, y halló un MEDIUM de honestidad: definir "producción" como `cgnat ∪ public` dejaba fuera los pools cargados con `ipKind=null` (rangos estáticos/legacy; el in-memory los defaultea así y la migración solo backfillea `'public'`) → una IP de producción ahí volvía a hacer fail-open. **FIXEADO:** el gate usa ahora TODOS los pools GESTIONADOS (`pools`, no solo `cgnat∪public`) — "IP conocida" = está en cualquier pool cargado; el preinstall (`172.31.255.x`) no está registrado en ninguno → sigue adoptable. +test (reciclado con IP en pool `ipKind=null` → skip). El HIGH residual se REDUCE a "IP de un rango que NO está cargado como NINGÚN pool" (más raro). Cerrados también 2 LOW (comentario de `createdAt` no-parseable ahora condicionado por IP; `console.warn` impreciso). Gate final: suite completa verde + tsc.

## Success Criteria

- [ ] Pendiente + sesión en pool preinstall (IP `172.31.255.x`) cuyo `startedAt` precede al `createdAt` → **adoptado** (nasId asignado, IP cgnat/public del destino, kick, evento `moved`/`auto_install`).
- [ ] Pendiente + sesión con IP de PRODUCCIÓN (cgnat/public) que precede → sigue `skipped_stale_session` / `session_predates_service` (reciclado protegido).
- [ ] Pendiente + sesión `framedIp` null que precede → sigue skip (conservador).
- [ ] Regresión: mismatch NORMAL con sesión vieja → sigue `skipped_stale_session` (freshness C1 intacto).
- [ ] Regresión: adopción con sesión fresca (startedAt >= createdAt) → adopta igual, sin importar la IP.
- [ ] `npm test` verde (incluida toda la suite de `AutoMovePppoe`) + `tsc --noEmit` limpio.
