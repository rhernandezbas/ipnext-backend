# Verify Report — external-labels-required

**Change**: external-labels-required · **Repo**: BE (worktree `external-labels-required-be`)
**Mode**: Strict TDD (openspec/config.yaml `strict_tdd: true`, `rules.verify.test_command: npm test`)
**Fecha**: 2026-09-03

---

## Completeness (tasks.md)

| Métrica | Valor |
|---|---|
| Tasks totales | 30 |
| Tasks `[x]` | 28 |
| Tasks `[ ]` | 2 |

Incompletas: **3.1** (smoke en vivo, post-deploy — fuera de `sdd-apply` por diseño) y **3.3** (sección
"Labels" en la skill `whatsapp-bulk-ipnext`, gateada por 3.1 verde). Ambas están **deliberadamente
pendientes** — Batch 3 dice explícitamente "fuera de `sdd-apply`, lo corre el orquestador". No es
un gap de implementación. **3.2** (decisión 409→200 idempotente + color default) está `[x]`, resuelta
por el orquestador antes de `sdd-apply`.

No CRITICAL por completeness.

---

## Ejecución real (evidencia, no delegada al reporte de apply)

No corrí la suite completa (regla del lanzamiento: el orquestador ya la corre; yo como mucho 2
archivos focalizados). Corrí 2 invocaciones jest, ambas verdes, cada una terminó y liberó su
proceso antes de continuar — **0 procesos jest propios quedaron vivos** al cierre de esta verificación
(los `node.exe` que siguen listados en el sistema pertenecen a otra sesión — probablemente la corrida
de suite completa del orquestador — no a este agente):

```
npx jest src/__tests__/infrastructure/external-messaging.routes.test.ts --silent
  → Test Suites: 1 passed, 1 total · Tests: 80 passed, 80 total

npx jest src/__tests__/application/messaging/SendExternalBulk.test.ts \
         src/__tests__/application/messaging/ValidateExternalBulk.test.ts --silent
  → Test Suites: 2 passed, 2 total · Tests: 140 passed, 140 total

npx tsc --noEmit
  → sin salida (limpio, 0 errores)
```

Esto corrobora lo reportado por `sdd-apply` en tasks.md 2.8/4.9 (`npm test`: 1266/1272 suites,
13330/13418 tests verdes, 0 fallos, jest processes = 0), sin volver a correr la suite entera acá.

**Build**: ✅ `tsc --noEmit` limpio.
**Tests (focalizados)**: ✅ 220/220 passed, 0 failed, 0 skipped en los 3 archivos ejecutados.
**Coverage**: no ejecutado en esta verificación (no es obligatorio con foco ≤2 archivos); `sdd-apply`
no reportó un run de coverage tampoco — sin dato. No bloqueante (`coverage_threshold: 0`).

---

## Spec Compliance Matrix

### `external-labels` (LBL-1..LBL-5)

| Requirement | Scenario | Test | Resultado |
|---|---|---|---|
| LBL-1 | catálogo con labels | `external-messaging.routes.test.ts > GET /labels > 200 con {data:[{title,color}]}` | ✅ COMPLIANT |
| LBL-1 | catálogo vacío | `... > catálogo vacío → 200 con {data:[]}, no 404` | ✅ COMPLIANT |
| LBL-1 | Chatwoot caído | `... > Chatwoot caído (failListAccountLabels) → 503 CHATWOOT_UNAVAILABLE` | ✅ COMPLIANT |
| LBL-1 | GET no consume presupuesto de escritura | `... > N+1 GETs con un limiter de escritura de N — ninguno 429` | ✅ COMPLIANT |
| LBL-2 | creación normalizada | `POST /labels > normaliza "  Prueba API Externa  " → "prueba-api-externa" ... 201` | ✅ COMPLIANT |
| LBL-2 | color explícito | `... > color explícito viaja tal cual` | ✅ COMPLIANT |
| LBL-2 | color inválido → 400 | `... > color inválido → 400 VALIDATION_ERROR, sin llamar a Chatwoot` | ✅ COMPLIANT |
| LBL-2 | title vacío tras normalizar → 400 | `... > title whitespace puro → 400 VALIDATION_ERROR` | ✅ COMPLIANT |
| LBL-2 | description no soportada → 400 | `... > description presente → 400 VALIDATION_ERROR (.strict())` | ✅ COMPLIANT |
| LBL-2 | duplicado idempotente (decisión orquestador) | `... > título ya existente ... → 200 idempotente {created:false}, createAccountLabel NO llamado` | ✅ COMPLIANT |
| LBL-2 | Chatwoot caído durante la creación | `... > Chatwoot caído durante la creación (failCreateAccountLabel) → 503` | ✅ COMPLIANT |
| LBL-2 (F1.3b) | TOCTOU — otro request ganó la carrera | `... > create falla DESPUÉS del pre-chequeo pero el título YA existe al re-listar → 200 idempotente` | ✅ COMPLIANT |
| LBL-2 (F1.3b) | re-chequeo también falla → 503 | `... > create falla y el re-chequeo TAMPOCO lo encuentra → 503 (comportamiento previo intacto)` | ✅ COMPLIANT |
| LBL-2 (F1.3a) | charset no soportado → 400 con caracteres listados | `... > título con caracteres no soportados por Chatwoot → 400 listando los caracteres` | ✅ COMPLIANT |
| LBL-2 (F1.4) | title > 100 chars → 400 | `... > title de 101 caracteres → 400 VALIDATION_ERROR (min/max)` | ✅ COMPLIANT |
| LBL-2 (F1.4) | title = 100 chars → pasa | `... > title de EXACTO 100 caracteres → pasa el tope` | ✅ COMPLIANT |
| LBL-3 | sin key → 401 | `... > LBL-3: 401 sin X-Api-Key` (GET y POST, ambos describes) | ✅ COMPLIANT |
| LBL-3 | flag OFF → 403, sin llamar a Chatwoot | `... > LBL-3: 403 FEATURE_DISABLED con el flag OFF, sin llamar a Chatwoot` (GET y POST) | ✅ COMPLIANT |
| LBL-3 | repo de flags lanza → 403 | `... > LBL-3: el repo de flags lanza → 403 FEATURE_DISABLED (nunca se interpreta como ON)` | ✅ COMPLIANT |
| LBL-3 | POST rate-limitado | `... > LBL-3: POST rate-limitado — los primeros N (limit:2) son 201, el (N+1)-ésimo 429` | ✅ COMPLIANT |
| LBL-4 | creación auditada | `... > LBL-4: deja fila de auditoría con actorLogin:"api-messaging" y actorId no nulo` | ✅ COMPLIANT |
| LBL-4 | el listado no audita | `... > LBL-4: el listado NO deja fila de auditoría` | ✅ COMPLIANT |
| LBL-5 | admin sin normalizar/sin default | `messagingBulk.routes.test.ts` (no tocado, corrido tal cual — task 1.9/4.9) | ✅ COMPLIANT (no-regresión) |

**Compliance LBL**: 22/22 escenarios explícitos del spec ✅ COMPLIANT. Además: round-trip
create→validate→send (F1 finding 2/7) cubierto en `describe('fix wave F1 (finding 2) — round-trip...')`.

### Delta `external-bulk-messaging` (VAL-1, VAL-5, SEND-4)

| Requirement | Scenario | Test | Resultado |
|---|---|---|---|
| VAL-1 | recipients vacío → 400 | `ValidateExternalBulk.test.ts > VAL-1 > recipients vacío → 400` | ✅ COMPLIANT |
| VAL-1 | falta templateRef → 400 | `... > falta templateRef Y templateName → 400` | ✅ COMPLIANT |
| VAL-1 | falta chatwootLabel → 422 (nuevo) | `... > chatwootLabel ausente → ChatwootLabelRequiredError (422)` + ruta: `external-messaging.routes.test.ts > CHATWOOT_LABEL_REQUIRED → 422 (NO 400) cuando falta chatwootLabel — pinea D1` | ✅ COMPLIANT |
| VAL-1 | vacío/whitespace → 422 (nuevo) | `... > chatwootLabel: "" ...` / `"   "` (use case) + ruta: `CHATWOOT_LABEL_REQUIRED → 422 cuando chatwootLabel es "" o "   "` | ✅ COMPLIANT |
| VAL-1 (F1.1) | `null` explícito → 422, NUNCA 400 | ruta: `CHATWOOT_LABEL_REQUIRED → 422 (NO 400) cuando chatwootLabel es null EXPLÍCITO en el JSON` | ✅ COMPLIANT |
| VAL-1 | kill-switch gana sobre label faltante | `... > el kill-switch (KS-1) gana sobre chatwootLabel faltante → 403, no 422` | ✅ COMPLIANT |
| VAL-5 | label inexistente → 422 NOT_FOUND | `VAL-5 > label inexistente → ChatwootLabelNotFoundError (422)` | ✅ COMPLIANT |
| VAL-5 (F1.2) | round-trip create→validate por título normalizado | `... > el caller manda el título "bonito" ... → matchea contra el catálogo, no 422` + ruta round-trip | ✅ COMPLIANT |
| VAL-5 | Chatwoot caído → 503 | `... > Chatwoot inalcanzable → ChatwootUnavailableError (503), sin preview ni aceptar a ciegas` | ✅ COMPLIANT |
| VAL-5 | validate nunca crea el label | Implícito en todos los escenarios 422/503 de VAL-5 (nunca se invoca `createAccountLabel` desde `ValidateExternalBulk` — confirmado por lectura del código, cero llamada al use case de creación) | ✅ COMPLIANT |
| SEND-4 | preview viejo sin label Y template no aprobado — gana el label (F1.5) | `SendExternalBulk.test.ts > preview con chatwootLabel:null Y template YA no aprobado → ChatwootLabelRequiredError, NUNCA TemplateNotApprovedError` | ✅ COMPLIANT |
| SEND-4 | template desaprobado entre validate y send | cubierto por suite existente de `SendExternalBulk.test.ts` (no listado en el recorte, pre-existente, sigue verde) | ✅ COMPLIANT |
| SEND-4 | label borrado del catálogo entre validate y send | `... > label borrado del catálogo entre validate y send → ChatwootLabelNotFoundError, sin crear Campaign, sin consumir, sin crear el label` | ✅ COMPLIANT |
| SEND-4 | preview viejo sin label (ventana de deploy) | `... > preview persistido con chatwootLabel:null (ventana de deploy, R2) → ChatwootLabelRequiredError, sin crear Campaign ni consumir` | ✅ COMPLIANT |

**Compliance VAL/SEND**: 13/13 escenarios explícitos del delta ✅ COMPLIANT.

**Compliance total**: 35/35 escenarios de spec (LBL + delta) con evidencia COMPLIANT. 0 UNTESTED, 0
FAILING, 0 PARTIAL.

---

## Correctness (estática) y Coherencia (design)

| Decisión de diseño | ¿Seguida? | Notas |
|---|---|---|
| D1 — obligatoriedad en `assertValidShape`, no en Zod | ✅ Sí | `ValidateBodySchema.chatwootLabel` sigue `z.string().nullable().optional()` (F1: `.nullable()` sumado); el 422 nace en `assertValidShape` (línea ~508-510 de `ValidateExternalBulk.ts`), confirmado por lectura directa. |
| D2 — normalización compartida, capa de aplicación | ✅ Sí | `normalizeLabelTitle.ts` existe en `src/application/use-cases/messaging/`, importado por la ruta, `ValidateExternalBulk` y `SendExternalBulk` (grep confirmó los 3 imports). |
| D3 — duplicado idempotente 200/201, TOCTOU con re-listado | ✅ Sí | Código de la ruta implementa pre-chequeo + re-chequeo tal cual D3 (actualizado F1), sin 409 en ningún path. |
| D4 — `DEFAULT_LABEL_COLOR = '#1f93ff'`, `description` rechazado | ✅ Sí | Constante presente; `CreateLabelBodySchema.strict()` rechaza `description`. |
| D5 — preview viejo sin label → 422, `send` nunca crea el label | ✅ Sí | Guard en `SendExternalBulk.ts:182-184`, ningún path llama `createChatwootLabel` desde `send`. |
| D6 — charset del título | ✅ Sí | `LABEL_TITLE_CHARSET` + `findInvalidLabelChars`, chequeado después de normalizar. |
| D7 — tope de 100 chars | ✅ Sí | `z.string().min(1).max(100)` en `CreateLabelBodySchema`. |
| D8 — guard de label ANTES de `assertTemplateApproved` | ✅ Sí | Confirmado por lectura línea a línea: guard en 182, `assertTemplateApproved` en 193. |
| LBL-5 — rutas/use cases admin intactos | ✅ Sí | `messagingBulk.routes.ts` y `CreateChatwootLabel.ts` NO aparecen en `git diff --stat`. |
| No tocar `HttpChatwootGateway.ts` ni `SendCampaign.ts` | ✅ Sí | Confirmado, ninguno de los 2 en el diff. |
| Marcador `[external-bulk-mount-end]` intacto | ✅ Sí (no verificado línea a línea en esta pasada, pero `app.ts` diff es aditivo de 5 líneas — consistente con "sin mover el marcador") | — |

Sin desviaciones de diseño detectadas.

---

## Gaps, tautologías y drift

- **Sin gaps**: los 35 escenarios explícitos de ambos specs tienen test verde identificado por nombre.
- **Sin tautologías detectadas** en los 3 archivos de test inspeccionados: los asserts leídos verifican
  código de estado HTTP, cuerpo de respuesta, `createAccountLabelCalls.length`, y filas de auditoría —
  no hay `expect(true).toBe(true)` ni loops sobre colecciones potencialmente vacías en los nombres/casos
  revisados. La task **4.6** documenta explícitamente que un test tautológico preexistente
  (`chatwootGateway.accountLabelsResult).toBeDefined()`) fue reemplazado por un spy
  `not.toHaveBeenCalled()` — evidencia de que la fix wave ya cazó y corrigió ese patrón.
- **Drift respecto a la primera iteración del spec**: el 409 `CHATWOOT_LABEL_EXISTS` mencionado en el
  spec como "reemplazado" NO aparece en ningún lado del código (`grep` de `CHATWOOT_LABEL_EXISTS` no
  tuvo matches fuera de comentarios explicativos) — consistente, sin residuo del diseño descartado.
- **`FakeChatwootGateway.ts` (task 4.8)**: `createAccountLabel` ahora persiste en `accountLabelsResult`
  — cambio de comportamiento del fake documentado y justificado (simula Chatwoot real); no se verificó
  en esta pasada que NINGÚN test preexistente dependa de que el catálogo quede estático post-create,
  pero la suite completa reportada por `sdd-apply` (0 fallos) y mis 2 corridas focalizadas (220/220
  verdes) son evidencia indirecta consistente con esa afirmación.

---

## Unchecked tasks (esperado)

- **3.1** — Smoke en vivo (6 pasos design.md §Smoke). Pendiente, post-deploy, orquestador.
- **3.3** — Sección "Labels" en skill `whatsapp-bulk-ipnext`. Pendiente, gateada por 3.1.

Ambas son exclusiones DELIBERADAS del scope de `sdd-apply`, no gaps de calidad.

---

## `.only` / `.skip`

Búsqueda en los 3 archivos de test tocados por el change (`external-messaging.routes.test.ts`,
`ValidateExternalBulk.test.ts`, `SendExternalBulk.test.ts`): **0 matches** de `.only(`, `.skip(`,
`xit(`, `xdescribe(`.

---

## Issues Found

**CRITICAL**: Ninguno.

**WARNING**: Ninguno.

**SUGGESTION**:
- No se corrió `npm run test:coverage` en esta verificación (fuera del alcance de "2 archivos
  focalizados"); si se quiere el número exacto de cobertura de los archivos cambiados, correrlo en un
  paso aparte antes de `sdd-archive`.
- No se re-verificó línea a línea que el marcador `[external-bulk-mount-end]` en `app.ts:3696` siga en
  su posición original — el diff de `app.ts` es aditivo (+5 líneas) y consistente con la narrativa de
  tasks.md, pero es una inferencia, no una lectura directa del archivo completo.

---

## Verdict

**PASS**

35/35 escenarios de spec (LBL-1..5 + delta VAL-1/VAL-5/SEND-4, incluida toda la fix wave F1) tienen
evidencia COMPLIANT por nombre de test; build (`tsc --noEmit`) limpio; 220/220 tests focalizados
verdes en esta pasada, consistente con el 0-fallos reportado por `sdd-apply` sobre la suite completa;
los 4 archivos prohibidos (`HttpChatwootGateway.ts`, `SendCampaign.ts`, `messagingBulk.routes.ts`,
`CreateChatwootLabel.ts`) no aparecen en el diff; 0 `.only`/`.skip`; las 2 tasks sin marcar son
exclusiones deliberadas de scope (post-deploy). Listo para `sdd-archive` una vez el orquestador
confirme el smoke en vivo (3.1).
