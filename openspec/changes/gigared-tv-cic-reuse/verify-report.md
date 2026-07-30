# Verification Report — `gigared-tv-cic-reuse`

**Modo**: Strict TDD · **Base**: `main` = `24a7e9b9` · **Fecha**: 2026-07-30
**Worktrees**: BE `gigared-tv-cic-reuse-be` · FE `gigared-tv-cic-reuse-fe`

---

## Ejecución real (no análisis estático)

| Gate | Comando | Resultado |
|---|---|---|
| BE tests | `npx jest` | **11.299 passed** / 1118 suites · 1 failed (ajeno) · 88 skipped |
| BE typecheck | `tsc --noEmit` | **exit 0** |
| FE tests | `npx vitest run` | **7.485 passed** / 672 suites · 1 failed (ajeno) |
| FE typecheck | `tsc --noEmit` | **exit 0** |
| Suites del change (evidencia por test, reporter JSON) | 16 suites | **320/320 passed, 0 failed** |

**Los 2 fallos son AJENOS y PREEXISTENTES, verificados corriéndolos en `main` limpio de cada repo:**
- BE `technicianLocation.routes.test.ts` → *"GET /:login/journey is gated by location_read"* (200 en vez de 403)
- FE `WhatsappReportsPage.test.tsx`

Ninguno toca un archivo de este diff. No se asumió: se ejecutaron aislados en el checkout principal.

---

## Completitud

| Métrica | Valor |
|---|---|
| Tareas totales en `tasks.md` | 33 |
| Marcadas `[x]` | **0** |
| Marcadas `[ ]` | 33 |

⚠️ **WARNING (contable, no funcional)** — el trabajo de las 33 tareas ESTÁ hecho y probado (ver la matriz), pero los checkboxes nunca se actualizaron durante el apply. Además, el alcance real EXCEDIÓ a `tasks.md`: cuatro rondas de review adversarial agregaron requisitos (`POOL-1.7` reescrito, `POOL-1.8`, `POOL-1.9`, `POOL-2.1b`, `ERR-1.1b`, `OBS-1.4`, la 4ta condición de la invariante) que no existían cuando se escribió el checklist. **`tasks.md` quedó desactualizado respecto del spec — hay que reconciliarlo antes de archivar.**

---

## Matriz de spec-compliance

Cada fila exige un test que **PASÓ**. Código existente no es evidencia.

### `CIC-1` — validez de formato del CIC

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| CIC-1.1 | carácter fuera de `[0-9]` → rechazado | `cicFormat.test.ts` › *EL BUG REAL: el CIC con un ESPACIO embebido → INVÁLIDO* | ✅ |
| CIC-1.1 | no se valida la LONGITUD (decisión de diseño) | `cicFormat.test.ts` › *NO se valida la longitud…* | ✅ |
| CIC-1.2 | vacío / null / undefined → rechazado | `cicFormat.test.ts` › *vacío / null / undefined → inválido* | ✅ |
| CIC-1 | **escenario del bug real** (pool con `'00065470 4'`) | `poolCandidate.test.ts` › *el único sin internal_id clasifica `malformado`, NO `limpio`* + `cicReuse` › *el CIC MALFORMADO no cuenta como limpio* | ✅ |

### `POOL-1` — filtro anti-envenenamiento refinado

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| POOL-1.1 | unstamped + formato válido → `limpio` | `poolCandidate.test.ts` › *cic válido + internal_id vacío → limpio* | ✅ |
| POOL-1.2 | identidad no parseable → `ajeno` | `poolCandidate.test.ts` › *identidad NO parseable → ajeno* + `cicReuse` › *identidad NO parseable (tercero desconocido) → jamás candidato* | ✅ |
| POOL-1.3 | clientId inexistente en el mirror → `ajeno` | `InMemoryTvCicReuseEligibilityRepository.test.ts` › *cliente inexistente → false* | ⚠️ PARCIAL — probado a nivel puerto; a nivel use case está delegado, sin test propio |
| POOL-1.4 | cliente no elegible → `ajeno` | `cicReuse` › *cliente sin baja local → NO se reutiliza* (**caso ALVEZ**) + *cliente de baja PERO con fila de TV activa (drift)* | ✅ |
| POOL-1.5 | cliente elegible → `reutilizable` | `cicReuse` › *pool 100% reutilizable → el alta se completa y estampa la identidad NUEVA* | ✅ |
| POOL-1.6 | **limpio primero** | `cicReuse` › *con 1 limpio y 3 reutilizables → elige el LIMPIO* | ✅ |
| POOL-1.7a | sin cubetas → `NoCicAvailableError` | `usecase.test.ts` › *F5(a): cic vacío SIN estampar → NoCicAvailableError, NO TvPoolPoisonedError* | ✅ |
| POOL-1.7b | duda domina/empata → 503 | `cicReuse` › *M5 — 1 veneno + 1 duda (empate) → gana lo TRANSITORIO* | ✅ |
| POOL-1.7b | **la duda NO puede tapar N venenos** | `cicReuse` › *M5-bis — MUCHOS venenos + 1 duda → gana el VENENO* | ✅ |
| POOL-1.7c | `poisonedCount = ajenos + ocupadas` | `cicReuse` › *veneno REAL … con su cuenta exacta* (`poisonedCount === 2`) + `F4-bis` (`=== 3`) | ✅ |
| POOL-1.7d | el mensaje nombra la causa REAL | `cicReuse` › *F4 — el mensaje NO inventa "identidad ajena" cuando la causa fue "cuenta ocupada"* | ✅ |
| POOL-1.8 | el chequeo PURO va ANTES del I/O falible | `cicReuse` › *F3 — cuentas OCUPADAS + Postgres caído → 422* (assertea además que el mirror NO se consultó) | ✅ |
| POOL-1.9 | el CIC malformado deja rastro con el valor ofensor | `cicReuse` › *F5 — un CIC MALFORMADO deja rastro en el log* | ✅ |
| — | cortocircuito: con suficientes limpios no se verifica nada | `cicReuse` › *con suficientes CICs LIMPIOS no se verifica ningun reutilizable* | ✅ |

**Invariante de elegibilidad — las CUATRO condiciones**

| Cond. | Test | Resultado |
|---|---|---|
| 1 · existe en el mirror | `InMemory…test.ts` › *cliente inexistente → false* | ✅ |
| 2 · `tvCancelledAt` seteado | `InMemory…` › *cliente SIN tvCancelledAt → false (caso ALVEZ)* + `Prisma…where.test.ts` › *el where lleva las 3 condiciones* | ✅ |
| 3 · sin fila de TV activa | `InMemory…` › *con tvCancelledAt Y fila TV ACTIVA → false (drift)* + `Prisma…where.test.ts` (el `none` es load-bearing) | ✅ |
| 4 · el PARTNER confirma libre — **por campo** | `cicReuse` › `C3` × 4 (*sólo email/firstName/lastName/registrationDate seteado → NO está libre*) | ✅ |
| 4 · `''` cuenta como vacío | `cicReuse` › `C3` › *el string VACÍO cuenta como vacío* | ✅ |
| 4 · `undefined` = desconocido → no-verificable | `cicReuse` › *campos AUSENTES (undefined) → no-verificable ⇒ 503, NO veneno* | ✅ |
| 4 · `ott.registeredDevices` (señal ortogonal) | `cicReuse` › *F9 — cuenta con DISPOSITIVOS registrados no está libre* + *F9-bis* | ✅ |
| 4 · sin llamada extra al partner | `cicReuse` › *CERO llamadas extra al partner: el dato ya venia en el listado* | ✅ |

**Escenarios del spec**

| Escenario | Test | Resultado |
|---|---|---|
| limpio + reutilizable → elige el limpio | `cicReuse` › *con 1 limpio y 3 reutilizables* | ✅ |
| todos estampados de clientes de baja → completa el alta | `cicReuse` › *pool 100% reutilizable* | ✅ |
| ALVEZ (sin `tvCancelledAt`) → 422, jamás elegido | `cicReuse` › *cliente sin baja local → TvPoolPoisonedError* | ✅ |
| `internal_id` no-uuid → `ajeno` | `cicReuse` › *identidad NO parseable* | ✅ |

### `POOL-2` — reintento acotado

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| POOL-2.1 | reintenta SÓLO con `cicNotOwned` | `err13` › *F3 — un not-found MARCADO como "cic ajeno" SÍ reintenta* | ✅ |
| POOL-2.1 | **la marca se produce en el ADAPTER** | `GigaredClient.observability` › *M1 — el 403 cic-ownership marca cicNotOwned=true* | ✅ |
| POOL-2.1b | sin marca → `TvIdentityStampUnverifiedError`, **cero reintento** | `err13` › *F3 — un not-found INDETERMINADO NO reintenta (anti doble cobro)* + `observability` › *M1 — el 424 NO marca* / *M1 — el 404 pelado tampoco* | ✅ |
| POOL-2.2 | tope de 3 | `cicReuse` › *el tope es 3: con 4 candidatos malos, register se llama EXACTAMENTE 3 veces* | ✅ |
| POOL-2.3 | otro error → sin reintento | `cicReuse` › *NO reintenta ante un error que NO es not-found* + *un fallo de `activate` NO reintenta* | ✅ |
| POOL-2.4 | agotados → `TvNoUsableCicError`, nunca 404 crudo | `cicReuse` › *todos inservibles → TvNoUsableCicError (422), NUNCA GigaredNotFoundError* | ✅ |
| — | **escenario**: 1er candidato 403 + 2do válido → alta OK sin error | `cicReuse` › *register 404 en el 1er candidato + 2do válido* | ✅ |

### `ERR-1` — ningún 404 crudo durante un alta

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| ERR-1.1 | NotFound del listado → 503 | `err13` › *F5 — el NotFound del pool SÍ se traduce* | ✅ |
| ERR-1.1 | los demás se propagan TAL CUAL (auth/notConfigured/unavailable) | `err13` › *F5 — el catch del pool NO aplasta los errores que ya tienen código propio* | ✅ |
| ERR-1.1b | fallo de elegibilidad NO aborta el alta | `cicReuse` › *Postgres caido en la elegibilidad → TRANSITORIO (503)* | ✅ |
| ERR-1.2 | `activate` / `setInternalId` not-found → error tipado | `err13` › *ACTIVATE que 404ea* + *SETINTERNALID que 404ea* | ✅ |
| ERR-1.2 | `listAccounts({email})` not-found → error tipado | `err13` › *el listAccounts({email}) del recovery que 404ea* | ✅ |
| **ERR-1.3** | **ningún camino termina en 404 crudo** | `err13` › **BARRIDO: 404 en CUALQUIER punto** (5 puntos, data-driven) + `cicReuse` › *el resultado NUNCA es un GigaredNotFoundError* | ✅ |
| ERR-1.3 | mapeo HTTP de los códigos nuevos | `gigared.routes.cicReuse.test.ts` › *TvPoolUnavailableError → 503* / *TvNoUsableCicError → 422* | ✅ |

### `OBS-1` — observabilidad del rechazo del partner

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| OBS-1.1 | el 403 `cic-ownership-error` SE LOGUEA | `observability` › *OBS-1.1 — el 403 cic-ownership-error SE LOGUEA* | ✅ |
| OBS-1.1 | el contrato de traducción NO cambió | `observability` › *el 403 cic-ownership SIGUE mapeando a GigaredNotFoundError* | ✅ |
| OBS-1.2 | ~~loguear todo 404~~ **REVERTIDO** → NO se loguean | `observability` › *F7 — un 404 genérico NO se loguea (happy path)* | ✅ |
| OBS-1.3 | `empty-accounts_list` no loguea y sigue dando `[]` | `observability` › *OBS-1.3 — el 404 empty-accounts_list NO se loguea…* | ✅ |
| OBS-1.4 | los NO-404 siguen logueando | `observability` › *F7 — los NO-404 sí se siguen logueando* | ✅ |
| — | la cuenta OCUPADA y los campos AUSENTES dejan rastro | `cicReuse` › *C6* + *C6-bis* | ✅ |

### `AUD-1` — rastro de la reutilización

| Req | Escenario | Test | Resultado |
|---|---|---|---|
| AUD-1.1 | emite `tv.cic_reused` con el dueño anterior | `reuseAudit` › *AUD-1.1 — … con el dueño anterior* (`toEqual` exacto, con `internalId ≠ clientId` para matar el swap) | ✅ |
| AUD-1.1 | se emite al ESTAMPAR, sobrevive al readback fallido | `reuseAudit` › *F8 — el rastro se emite aunque el READBACK falle después* | ✅ |
| AUD-1.1 | NO se emite si el discriminador redirige a otro cic | `reuseAudit` › *F8-bis (REGRESIÓN DEL FIX WAVE)* | ✅ |
| AUD-1.1 | NO se emite sin reutilización real (rama "ya estampada") | `reuseAudit` › *#4 — ni auditoría NI reason de reutilización* | ✅ |
| AUD-1.2 | el `reason` del Historial nombra al dueño exacto | `reuseAudit` › *AUD-1.2 — el reason del Historial de TV nombra al dueño anterior EXACTO* | ✅ |
| AUD-1.3 | best-effort: el fallo no aborta el alta | `reuseAudit` › *AUD-1.3 — si la auditoría FALLA, el alta ya completada NO se aborta* | ✅ |
| AUD-1.4 | un CIC limpio NO emite el evento | `reuseAudit` › *AUD-1.4* | ✅ |

### Wiring (composition root)

| Req | Test | Resultado |
|---|---|---|
| `app.ts` construye el repo de elegibilidad | `gigared-composition.cicReuse` › *app.ts construye PrismaTvCicReuseEligibilityRepository* | ✅ |
| se inyecta en `RegisterGigaredAccount` (si no, feature MUERTA) | idem › *recibe el repo de elegibilidad* + *recibe el repo de auditoría* | ✅ |
| **el ORDEN posicional** (args por posición: un swap compila y rompe en silencio) | idem › *el ORDEN posicional es el correcto* (índices 9 y 10) | ✅ |
| el stripper de comentarios no es teatro | idem › *el stripper funciona* | ✅ |

### Frontend

| Req | Test | Resultado |
|---|---|---|
| `TV_NO_USABLE_CIC` (422) sin botón de reintentar | `registerErrorView.test.ts` › *TV_NO_USABLE_CIC (422, de DATOS) → SIN botón* | ✅ |
| el copy NO miente ("reintentar no va a cambiar el resultado") | idem › *NO le dice al operador que reintente* | ✅ |
| `TV_POOL_UNAVAILABLE` (503) → warning + retry | idem › *TRANSITORIO → warning CON reintentar* | ✅ |
| no filtra el `detail` crudo del upstream | idem › *NO filtra el detail crudo* | ✅ |
| invariante: todo `retry` es transitorio; ningún 4xx de datos lo ofrece | idem › *invariante transversal* | ✅ |
| caracterización: los 6 códigos previos no cambiaron | idem › describe *caracterización de lo que YA existía* | ✅ |

**Resumen de compliance: 63/64 escenarios COMPLIANT · 1 PARCIAL · 0 FAILING · 0 UNTESTED.**

---

## Evidencia de que los tests PROTEGEN (revert-probe ejecutado)

No alcanza con que los tests pasen: se rompió el código a propósito y se verificó el rojo.

| Mutante | Resultado |
|---|---|
| sacar `, true` (marca `cicNotOwned`) del adapter | **muere** |
| sacar el try/catch de la elegibilidad | **muere** |
| invertir la precedencia `descartados`/`noVerificables` | **muere** |
| mismatch de CIC → `'ocupada'` en vez de `'no-verificable'` | **muere** |
| intercambiar `internalId`↔`clientId` en `beforeJson` | **muere** |
| apagar el `reason` del Historial (`reason: null`) | **muere** |
| que sólo el `email` decida si la cuenta está libre | **muere** |
| `matches[0]` a ciegas en el discriminador por email | **muere** |

Restaurado tras cada uno → suite verde. Los 8 sobrevivían antes de las rondas 3 y 4.

---

## Coherencia con el diseño

| Decisión de `design.md` | ¿Se siguió? | Nota |
|---|---|---|
| D1 · helpers puros de dominio | ✅ | `parseTvInternalId`, `isValidCicFormat`, `classifyPoolEntry` |
| D2 · puerto propio con las 3 condiciones en UNA query | ✅ | anti-TOCTOU; `none` verificado load-bearing |
| D3 · errores nuevos 503 / 422 | ✅ | |
| D4 · limpio-primero + loop acotado | ✅ | |
| D5 · observabilidad del adapter | ⚠️ **DESVIADA (mejora)** | OBS-1.2 se revirtió: loguear todos los 404 sepultaba la señal bajo el happy path. Spec actualizado con el porqué. |
| D6 · auditoría | ⚠️ **DESVIADA (mejora)** | se emite en `intentarConCandidato`, no en `execute`: si no, se perdía cuando el readback fallaba. |
| D7 · wiring + composition-root test | ✅ | incluye el orden posicional |
| D8 · sin migración de DB | ✅ | confirmado: cero cambios en `prisma/` |
| D8 · `CancelTv` NO se toca | ✅ | confirmado por diff |
| **D2/D4 · verificación contra el partner con un GET extra** | ⚠️ **ELIMINADA (mejora)** | el GET era redundante (mismo `mapAccount`) y colgaba la premisa de un endpoint no verificado. Se usa el dato del listado. Spec actualizado. |

---

## Issues

### CRITICAL
**Ninguno.**

### WARNING
1. **`tasks.md` con 0/33 marcadas y desactualizado** respecto del spec (4 rondas de review agregaron requisitos). Reconciliar antes de archivar.
2. **POOL-1.3 sólo probado a nivel puerto** — a nivel use case está delegado y sin test propio. Riesgo bajo (el use case no decide nada ahí), pero la fila no es ✅ pleno.
3. **Auditoría duplicada entre REQUESTS distintos** (readback 404 → el operador reintenta → 2 eventos idénticos). Deuda ACEPTADA y documentada: los eventos son idénticos ⇒ ruido forense, no dato erróneo; deduplicar exige una query por `entityId` que el puerto no expone.
4. **Los dos rastros divergen en el retry**: si el readback falla tras estampar, la auditoría dice "CIC reusado" y el `reason` del Historial queda `null`. No lo arregla `estampado` (en el 2º intento no se estampa); requiere persistir el `reusedFrom`. Deuda documentada, sin test.
5. **`register` dentro de `withRetry429`** (hasta 5 POST por candidato) sin idempotency key. **Pre-existente del adapter**, no introducido por este change.

### SUGGESTION
1. Test de auditoría con **re-alta** (`seq > 0`): hoy todo `reuseAudit` corre con `seq = 0`, así que `afterJson.internalId === clientId`.
2. `MAX_CANDIDATOS` se aplica tras concatenar: 3 limpios malos pueden hambrear a N reutilizables buenos.
3. El mensaje del 503 con contadores 1 y 1 no distingue un swap de los dos números.

---

## Acciones NO-código pendientes (bloquean el desbloqueo real, no el merge)

1. **Gigared debe purgar el `internal_id` de las CICs envenenadas** — es lo único que devuelve pool usable más allá de los 8 reutilizables.
2. **Gigared debe arreglar el CIC `00065470 4`** (espacio embebido).
3. **`ALVEZ SUSANA BEATRIZ`** (`3ef5eb6e-…`): el partner la tiene `unregistered` con los datos borrados, pero en Prominense NO figura dada de baja ⇒ **su TV está rota ahora mismo**. Card propia.

## ⛔ Verificación en vivo — PENDIENTE, requiere OK del usuario

Todo el desarrollo fue **contra fakes**. El primer `register` real **ESCRIBE al partner**. La verificación en vivo (alta real sobre un CIC reutilizable + confirmación del `AuditEvent` + re-consulta del pool) es un evento aparte, con el usuario presente.

---

## Veredicto

# ✅ PASS WITH WARNINGS

63/64 escenarios del spec probados por un test que pasó, `tsc` limpio en ambos repos, 8/8 mutantes clave muertos con revert-probe ejecutado, y cero CRITICAL. Los warnings son contables (`tasks.md`), deudas aceptadas y documentadas, o pre-existentes.

**Apto para push.** El desbloqueo operativo real depende además de las acciones de Gigared, y la verificación en vivo requiere OK explícito del usuario.
