# Verify Report: chatwoot-new-contact-404

**Fecha**: 2026-09-03
**Modo**: Strict TDD (activo — `openspec/config.yaml` `strict_tdd: true`, `rules.verify.test_command: npm test`)
**Runner acotado usado**: `npx jest src/__tests__/infrastructure/HttpChatwootGateway.test.ts` (única corrida permitida en este worktree — la suite completa ya la corrió el orquestador: 13289 passed / 0 failed, `tsc --noEmit` limpio).

---

## Completeness (tasks.md)

| Métrico | Valor |
|---|---|
| Tasks totales (checkable) | 27 |
| Completadas `[x]` | 22 |
| Pendientes `[ ]` | 5 (Fase 4 — verificación en vivo post-deploy) |

Pendientes, **deliberadamente**: 4.1–4.5 (smoke en vivo post-deploy contra Chatwoot real). No son deuda de esta verificación estática/TDD — dependen de un deploy y de una decisión operativa aún abierta en `design.md` (Open Questions: qué número usar para el re-envío del recipient `+5492324505794`). El resto (Fase 1, 2, 3 y el Fix wave F1 completo) está `[x]`.

---

## Build & Tests Execution

**Build (tsc --noEmit)**: ✅ Passed (exit 0, sin errores)

**Tests (acotado)**: ✅ 72 passed / 0 failed / 0 skipped
```
Test Suites: 1 passed, 1 total
Tests:       72 passed, 72 total
Time:        12.059 s
```
Coincide con lo que reporta el Gate de tasks.md ("`HttpChatwootGateway.test.ts` en 72/72"). Sin `.only`/`.skip`/`.todo`/`xit`/`xdescribe` en el archivo (grep negativo).

**Suite completa**: NO re-ejecutada (instrucción explícita del orquestador — ya corrida: 13289 passed, 0 failed, 0 jest processes al cierre).

**Coverage**: ➖ No corrida en esta verificación — requeriría `--coverage` sobre la suite completa, fuera del runner acotado autorizado para este worktree. No bloqueante (Strict TDD trata coverage como informational, nunca CRITICAL).

---

### TDD Compliance
| Check | Resultado | Detalle |
|---|---|---|
| Evidencia RED→GREEN reportada | ✅ | `tasks.md` documenta RED/GREEN explícito por sub-tarea (1.1 RED, 1.2 GREEN, 2.1 RED, 2.3 GREEN, etc.) y el fix wave declara "Red-green por finding" |
| Todas las tasks de código tienen test | ✅ | Fase 1/2 son 100% test-first; Fix wave F1 (FW1-FW6) cada finding tiene su test dedicado (línea citada abajo) |
| RED confirmado (archivo de test existe) | ✅ | `src/__tests__/infrastructure/HttpChatwootGateway.test.ts` modificado, 72 tests, sección `createConversationWithTemplate` líneas 456-1168 |
| GREEN confirmado (tests pasan ahora) | ✅ | 72/72 verde en esta corrida |
| Triangulación | ✅ | CHW-2 tiene 5+ tests distintos (happy path, 404→ensure, 422→search, source_id formato distinto, status≠404); FW4/FW5 triangulan 3 shapes de respuesta cada uno |
| Safety net (archivos modificados) | ✅ | Task 3.2 corrió `npx jest src/__tests__/application/messaging/` (acotado) para confirmar `SendCampaign` sin cambios — reportado verde en tasks.md |

**TDD Compliance**: 6/6 checks

---

### Assertion Quality
Revisados los 26 tests nuevos/modificados del bloque `createConversationWithTemplate` (líneas 456-1168): todos ejercitan código de producción real (invocan `gw.createConversationWithTemplate(...)`), assertan sobre la SECUENCIA exacta de `post.mock.calls`/`get.mock.calls` (paths + bodies completos, no solo "fue llamado") y sobre mensajes de error EXACTOS (`toMatchObject` con `message` literal). Sin tautologías, sin loops sobre colecciones potencialmente vacías, sin smoke-tests-solos.

**Assertion quality**: ✅ Todas las assertions verifican comportamiento real

---

## Spec Compliance Matrix

Delta spec: `openspec/changes/chatwoot-new-contact-404/specs/chatwoot-hub-sendpath/spec.md` (CHW-2 y CHW-7 MODIFIED).

| Requirement | Scenario | Test | Resultado |
|---|---|---|---|
| CHW-2 | Teléfono con `ContactInbox` existente — una sola llamada (no-regresión) | `HttpChatwootGateway.test.ts:511` "CHW-2 (2.1, no-regresión)" | ✅ COMPLIANT |
| CHW-2 | Teléfono sin contacto — crea contacto+inbox y reintenta con el `source_id` de la respuesta | `HttpChatwootGateway.test.ts:571` "2.2/2.3" | ✅ COMPLIANT |
| CHW-2 | Contacto existe pero sin `ContactInbox` — 422 → search → link, NO crea 2º Contact | `HttpChatwootGateway.test.ts:613` "2.4/2.5" | ✅ COMPLIANT |
| CHW-2 | `source_id` con formato distinto al derivado — el retry usa ESE valor | `HttpChatwootGateway.test.ts:802` "2.6" + `:660` "FW1" (mismo escenario, dos rutas de respuesta) | ✅ COMPLIANT |
| CHW-2 | Reintento de un recipient `failed` tras el fix — idempotente (no crea 2º contacto/conversación) | (ninguno dedicado — cubierto por equivalencia estructural: tras el ensure exitoso, un reintento cae en la rama "ContactInbox ya existe" ya probada en `:511`, pero no hay un test que invoque `createConversationWithTemplate` DOS veces en secuencia para probarlo directamente) | ⚠️ PARTIAL |
| CHW-7 | Chatwoot caído — one-off (`SendTemplateMessage.execute`) | Fuera de este archivo — cubierto por tests preexistentes de `SendTemplateMessage` (no modificados por este change, verdes en la suite completa del orquestador) | ✅ COMPLIANT (heredado) |
| CHW-7 | Chatwoot caído — bulk, no aborta el batch | Fuera de este archivo — cubierto por tests preexistentes de `SendCampaign` (no modificados, verdes en la suite completa) | ✅ COMPLIANT (heredado) |
| CHW-7 | El ensure falla — recipient `failed` con mensaje que nombra el paso y el status HTTP | `HttpChatwootGateway.test.ts:826` "2.8/CHW-7" (nivel adapter: mensaje exacto `crear el contacto (POST /contacts)` + `HTTP 500`) | ✅ COMPLIANT (nivel adapter) |
| CHW-7 | ...y el mensaje NO es el texto crudo de axios | `HttpChatwootGateway.test.ts:530` "1.3" (sin respuesta) + `:547` "2.7" (500 en 1er intento) + `:826` (500 en ensure) — los 3 assertan el mensaje EXACTO, nunca `Request failed with status code N` | ✅ COMPLIANT |
| CHW-7 | ...y "los recipients siguientes se siguen procesando" (batch continúa) tras ESTE modo de falla específico (ensure fallido) | No hay test end-to-end de `SendCampaign` que ejercite un 404→ensure-fallido a través de `FakeChatwootGateway` — el propio `tasks.md` documenta el gap: *"`FakeChatwootGateway` no modela `contact_inbox`/multi-inbox … si un futuro fix wave necesita testear `ensureContactInbox` desde el use case, el fake seguirá sin poder simularlo"* | ⚠️ PARTIAL (gap reconocido explícitamente por el propio equipo) |

**Resumen de compliance**: 7/9 COMPLIANT, 2/9 PARTIAL, 0/9 FAILING, 0/9 UNTESTED.

Los 2 PARTIAL no son regresiones ni bugs — son huecos de triangulación reconocidos (uno documentado explícitamente en `tasks.md` como "Gap conocido, fuera de alcance"). Ninguno bloquea: el comportamiento subyacente está cubierto por composición de otros tests verdes (la idempotencia se deriva de que el ensure solo corre en 404 + el 422-duplicado ya está probado; el "batch continúa" es una propiedad genérica de `SendCampaign.processRecipient` ya probada para OTROS tipos de error, solo no re-probada específicamente para el error nuevo de esta rama).

---

## Correctness (Static — evidencia estructural)

| Requirement | Estado | Nota |
|---|---|---|
| CHW-2 (ensure-on-404 + retry único) | ✅ Implementado | `HttpChatwootGateway.ts:337-380` (`createConversationWithTemplate`), `:431-487` (`ensureContactInbox`) |
| CHW-7 (mensaje con paso + status) | ✅ Implementado | `chatwootStepError` (`:74-79`), 4 valores de `step` exactamente como documenta `design.md` §Interfaces |
| Docblocks actualizados (task 3.1) | ✅ Implementado | `ChatwootGateway.ts:177-201` invierte la premisa; `HttpChatwootGateway.ts:320-336` idem |

---

## Coherence (Design)

| Decisión | ¿Seguida? | Nota |
|---|---|---|
| Ensure LAZY (solo en 404) | ✅ Sí | Happy path = 1 llamada, verificado por test `:511`/`:526-528` |
| Leer `source_id` de la respuesta, nunca re-derivar | ✅ Sí | `extractContactInboxSourceId` (`:779-816`), triangulado por `:802`, `:660`, FW5 (3 shapes) |
| `httpStatusOf(err)` + inspección ANTES de `this.call` | ✅ Sí | `postConversation`/`ensureContactInbox` deliberadamente NO usan `this.call` (comentado explícitamente) |
| Retry EXACTAMENTE una vez | ✅ Sí | Test `:855` "404 en el reintento... SIN loop infinito" |
| Reusar `searchContactRaw` (no `searchContact`) | ✅ Sí | Comentario `:262-267` explica por qué NO usa el público `searchContact` (pierde el status por `this.call`) |
| File Changes table (3 archivos) | ✅ Sí | `git status --short` en el worktree = exactamente esos 3 archivos + `openspec/changes/.../` (untracked, artefactos SDD) |

Sin desviaciones del design. El fix wave F1 (post-review) agregó comportamiento (FW1-FW6) no anticipado en el design original pero consistente con sus decisiones (ninguna alternativa descartada fue reintroducida).

---

## Issues Found

**CRITICAL** (deben resolverse antes de archivar):
Ninguno.

**WARNING** (deberían resolverse):
1. Scenario CHW-2 "reintento de un recipient `failed` tras el fix — idempotente" no tiene test dedicado que invoque `createConversationWithTemplate` dos veces en secuencia; la cobertura es por equivalencia estructural con el test `:511`, no una prueba directa de la propiedad de idempotencia end-to-end.
2. Scenario CHW-7 "el ensure falla ... el batch continúa" no está probado a nivel `SendCampaign` para ESTE modo de falla específico — gap ya documentado por el propio equipo en `tasks.md` (`FakeChatwootGateway` no modela `contact_inbox`).
3. Fase 4 (verificación en vivo, 5 tareas) sigue pendiente — bloquea el cierre real del bug en producción aunque no bloquea el merge/archive de este change desde el punto de vista de TDD/specs. `design.md` tiene una Open Question sin resolver (qué número usar para el smoke: `+5492324505794` real o uno de prueba) — requiere decisión del usuario/orquestador antes de ejecutar 4.1-4.5.

**SUGGESTION** (mejoras, no bloqueantes):
1. Considerar extender `FakeChatwootGateway` (fuera de alcance de este change, ya anotado en tasks.md) para poder testear la propiedad "batch continúa tras ensure fallido" a nivel de caso de uso sin depender de HTTP real.
2. Un test explícito de "llamar `createConversationWithTemplate` dos veces con el mismo teléfono tras un 404 inicial" cerraría el WARNING #1 sin mucho esfuerzo adicional (reusa el mismo harness `fakeHttp`).

---

## Verdict

**PASS WITH WARNINGS**

72/72 tests verdes en el runner acotado, `tsc --noEmit` limpio, 0 procesos jest residuales, cero desviación del design, cero regresión de scope (git status = exactamente los 3 archivos declarados). Los 2 WARNING son huecos de triangulación ya reconocidos por el propio equipo (no bugs, no drift spec↔código) y la Fase 4 pendiente es un smoke en vivo explícitamente fuera del alcance de esta verificación estática. No hay CRITICAL. Apto para archivar una vez resuelta (o aceptada como deuda) la Fase 4.
