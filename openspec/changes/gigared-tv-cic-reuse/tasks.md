# Tasks — `gigared-tv-cic-reuse`

**Strict TDD activo.** Cada tarea: test que FALLA primero → implementación → verde. Gate del repo: `npm test` + `tsc --noEmit`.

Worktree `.claude/worktrees/gigared-tv-cic-reuse-be` · branch `fix/gigared-tv-cic-reuse` · base `24a7e9b9`.

---

## Fase 1 — Dominio puro (sin I/O)

- [x] **T1.1** `parseTvInternalId` en `domain/gigared/tvIdentity.ts`
  - Tests: uuid pelado → `seq 0` · `{uuid}-3` → `seq 3` · `{uuid}-0` → `seq 0` · no-uuid → `null` · `''` → `null` · uuid con sufijo no numérico → `null` · uuid con basura alrededor → `null`
  - Round-trip contra `currentTvInternalId` para `seq` 0..5
- [x] **T1.2** `isValidCicFormat` en `domain/gigared/cicFormat.ts`
  - Tests: `'0006677401'` → true · **`'00065470 4'` → false** (el bug real, con el byte `0x20` explícito) · `''` / `null` / `undefined` → false · `'abc'` → false · `'0006677401\n'` → false
- [x] **T1.3** `classifyPoolEntry` en `domain/gigared/poolCandidate.ts`
  - Tests una por rama: `limpio` · `malformado` (precede a todo) · `ajeno` por identidad no parseable · `requiere-verificacion` con el `clientId` extraído
  - Test de ORDEN: cic malformado **e** internalId ajeno → `malformado` (el formato se evalúa primero)

## Fase 2 — Puerto y adapters

- [x] **T2.1** Puerto `TvCicReuseEligibilityRepository` en `domain/ports/`
- [x] **T2.2** `InMemoryTvCicReuseEligibilityRepository`
- [x] **T2.3** `PrismaTvCicReuseEligibilityRepository` — las **tres** condiciones en UNA query
  - Tests: cliente inexistente → false · sin `tvCancelledAt` → false · con `tvCancelledAt` **y** fila TV activa → false · con `tvCancelledAt` y sin fila TV activa → **true**
  - **Fixture con ≥2 clientes y ≥2 filas** — un fixture degenerado de un solo elemento deja pasar mutantes de scope (lección registrada)

## Fase 3 — Errores y mapeo HTTP

- [x] **T3.1** `TvPoolUnavailableError` (`TV_POOL_UNAVAILABLE`, 503) y `TvNoUsableCicError` (`TV_NO_USABLE_CIC`, 422)
- [x] **T3.2** Mapeo en el router de gigared + tests de ruta de ambos códigos

## Fase 4 — Reescritura de `resolveGigaredAccount` (el corazón)

- [x] **T4.1** Listado del pool envuelto → `TvPoolUnavailableError` (503, jamás 404)
- [x] **T4.2** Clasificación + verificación async + construcción del set de candidatos
- [x] **T4.3** **Orden limpio-primero** — test con 1 limpio + 3 reutilizables: DEBE elegir el limpio
- [x] **T4.4** Reutilización end-to-end — pool 100% reutilizable → el alta se completa
- [x] **T4.5** Rechazo del no-elegible — cliente sin `tvCancelledAt` (**caso `ALVEZ SUSANA`**) → `TvPoolPoisonedError` 422, jamás elegido
- [x] **T4.6** Loop de reintento acotado
  - `register` 404 sobre el 1er candidato + 2do válido → alta OK, operador no ve error
  - Sólo `GigaredNotFoundError` reintenta; `GigaredRejectedError` conserva el camino actual (discriminador por email)
  - Tope de 3: 4 candidatos malos → `TvNoUsableCicError`, y se llamó a `register` **exactamente 3 veces**
  - **`activate` / `setInternalId` que fallan NO reintentan** con otro CIC (anti cuenta huérfana)
- [x] **T4.7** **Test de regresión del bug reportado**: pool = exactamente las 10 cuentas reales de producción (9 estampadas + `'00065470 4'`) → el resultado NUNCA es `404 GIGARED_NOT_FOUND`
- [x] **T4.8** No-regresión: los tests existentes de `RegisterGigaredAccount` siguen verdes **sin editarlos**. Si alguno debe cambiar, se justifica por escrito — un test que contradice el spec puede tener razón (precedente `pppoe-move-ip-kind-aware`)

## Fase 5 — Observabilidad

- [x] **T5.1** `mapError` loguea el `403 cic-ownership-error` antes de traducirlo
- [x] **T5.2** `mapError` loguea los 404 **excepto** `empty-accounts_list`
- [x] **T5.3** Test de que `empty-accounts_list` **NO** loguea y sigue devolviendo `[]` en `listAccounts`

## Fase 6 — Auditoría

- [x] **T6.1** `AuditEvent action='tv.cic_reused'` con cic + internalId previo + clientId previo
- [x] **T6.2** `reusedFrom:{internalId}` en el `reason` del `TvActivationEvent`
- [x] **T6.3** Best-effort: el fallo de la auditoría NO aborta el alta ya completada
- [x] **T6.4** Un alta sobre un CIC **limpio** NO emite el evento de reutilización

## Fase 7 — Wiring y cierre

- [x] **T7.1** Cablear el repo en `app.ts`
- [x] **T7.2** **Composition-root test** — falla si `RegisterGigaredAccount` se construye sin la dependencia *(lección W6: sin esto la feature queda muerta en prod con el CI en verde)*
- [x] **T7.3** Gate completo corrido **por el orquestador**: `npm test` + `tsc --noEmit` (no confiar en el reporte del agente)
- [x] **T7.4** **Review adversarial** — focos: (a) la invariante de reutilización y sus bordes, (b) el loop de reintento e idempotencia/doble-registro, (c) contrato de errores y no-regresión, (d) calidad de los tests / mutantes
- [x] **T7.5** Fix wave con TDD → **re-review focalizada** → CLEAN
- [x] **T7.6** `sdd-verify` — matriz de spec-compliance: cada escenario con su test verde
- [x] **T7.7** Actualizar la card del BACKLOG + espejo en Obsidian

---

## Verificación en vivo (post-deploy, con OK del usuario)

- [ ] **V1** Alta real sobre un CIC reutilizable → confirmar cuenta creada, credenciales propias, `qty_registered_devices: 0`
- [ ] **V2** Confirmar el `AuditEvent` y la visibilidad en el Historial de TV
- [ ] **V3** Re-consultar el pool: una cuenta menos disponible, el resto intacto

> **⛔ El primer register real escribe al partner.** Todo el desarrollo va contra fakes. La verificación en vivo requiere OK explícito del usuario — regla vigente desde el `gigared-tv-identity-hardening`.

## Fuera de este change

- `ALVEZ SUSANA BEATRIZ` desincronizada → **card propia**
- CIC `00065470 4` → acción no-código de Gigared
- Deuda de acumulación de alias → monitorear; si crece, card de reporte

---

## Añadido por las 4 RONDAS DE REVIEW ADVERSARIAL (no existía en el checklist original)

El review encontró que el bug reportado **seguía vivo con 11.257 tests en verde**, y dos de los fix waves introdujeron regresiones. Estas tareas nacieron de ahí:

- [x] **R1** ERR-1.2 real — `activate`, `setInternalId` y `listAccounts({email})` protegidos *(el bug seguía vivo por 3 puertas)*
- [x] **R2** Reemplazar el test TAUTOLÓGICO de ERR-1.3 por un BARRIDO data-driven sobre cada llamada al partner
- [x] **R3** `cicNotOwned` — sólo el 403 `cic-ownership-error` habilita el reintento *(el 424 podía crear 3 cuentas reales: doble cobro)*
- [x] **R3b** Verificar la marca **en el ADAPTER**, que es quien la produce *(los fixtures la escribían a mano)*
- [x] **R4** 4ta condición de la invariante: el PARTNER confirma que la cuenta está libre *(el propio alta creaba el estado "elegible" ⇒ robo de CIC)*
- [x] **R5** El catch del pool sólo envuelve el NotFound *(aplastaba el error de API key vencida en un 503 "reintentá")*
- [x] **R6** Fallo de elegibilidad ≠ alta muerta *(regresión de disponibilidad)*
- [x] **R7** Revertir OBS-1.2 *(loguear todos los 404 sepultaba la señal bajo el happy path)*
- [x] **R8** La auditoría se emite al ESTAMPAR, no al volver *(se perdía si el readback fallaba)*
- [x] **R8-bis** Guard `cic === cicInicial` + flag `estampado` *(REGRESIÓN del fix wave: la auditoría mentía)*
- [x] **R9** Eliminar el `getAccountByCic` extra — usar el dato del listado *(redundante Y colgaba la premisa de un endpoint no verificado)*
- [x] **R10** Contadores por causa + `noVerificables >= descartados` *(una duda enmascaraba N venenos)*
- [x] **R11** El chequeo PURO antes del I/O falible *(un 422 se degradaba a 503 eterno)*
- [x] **R12** El CIC malformado deja rastro en el log *(la causa raíz seguía muda)*
- [x] **R13** `ott.registeredDevices` como señal ORTOGONAL *(la falla-cerrada cubría 3 de 4 campos)*
- [x] **R14** Fixtures: `poolEntry` realista, dueño anterior con `internalId ≠ clientId`, ≥2 matches por email *(fixtures degenerados dejaban vivos 10 mutantes)*
- [x] **R15** Revert-probe ejecutado sobre los 8 mutantes que sobrevivían → **todos mueren**
- [x] **R16** Spec corregido 4 veces, cada corrección con su porqué *(el código se había adelantado al spec)*
- [x] **R17** Artefactos SDD movidos al worktree *(estaban en el checkout de `main`, no viajaban con la branch)*
- [x] **R18** FE: `registerErrorView` extraído a función PURA + 15 tests *(el mapeo vivía inline en un `catch`, sin un solo test)*
