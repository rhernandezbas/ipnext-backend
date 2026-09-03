# Exploration: external-labels-required

> Ask (usuario, 2026-09-03, LOCKED): "Crea un servicio para consultar/crear los labels y que sea
> obligatorio al mandar un mensaje." Sobre la API Externa `/api/external/v1/messaging/bulk`
> (key dedicada + kill-switch `messaging-external-bulk-enabled`): `GET /labels`, `POST /labels`,
> y `chatwootLabel` OBLIGATORIO en `validate` + re-chequeado en `send`.
> Defaults del orquestador (obligatorio SOLO en la API Externa; el composer admin sigue con label
> opcional; se REVIERTE la decisión previa "el sistema nunca crea el label desde la API") se
> adoptan salvo que el código diga lo contrario — este documento los contrasta contra el código.

## Resumen ejecutivo

- **CERO use case nuevo.** `ListChatwootLabels` (`ListChatwootLabels.ts:12`) y
  `CreateChatwootLabel` (`CreateChatwootLabel.ts:27`) ya existen, ya están testeados
  (`src/__tests__/application/messaging/{ListChatwootLabels,CreateChatwootLabel}.test.ts`) y ya
  hablan con el port `ChatwootGateway.listAccountLabels()` / `.createAccountLabel()`
  (`ChatwootGateway.ts:208,216`). Este change es 100% del molde TPL-0..TPL-5 (las 4 rutas de
  templates de la API Externa, que también reusan use cases admin sin crear ninguno).
- **`ValidateExternalBulk` y `SendExternalBulk` son EXCLUSIVOS de la API Externa.** Verificado con
  `rg -l ValidateExternalBulk src/`: el único consumidor de producción es
  `external-messaging.routes.ts` (+ el wiring en `app.ts:3645-3696`). El composer admin usa
  `CreateCampaign` por otro camino (`messagingBulk.routes.ts`). **Hacer el label obligatorio dentro
  de esos dos use cases NO toca el composer admin** — no hace falta ninguna flag ni parámetro
  `required` para separar los dos mundos. Es el hallazgo que define el diseño.
- **⚠️ La normalización lowercase/espacios→guiones NO existe en el backend.** El ask la describe
  "como hace la ruta admin", pero `CreateChatwootLabel.ts:18-25` documenta explícitamente lo
  contrario: *"Este use case pasa-through el `title` TAL CUAL — NO normaliza, NO valida charset;
  Chatwoot downcasea/rechaza del lado servidor. La normalización visible es responsabilidad del FE
  (mini-modal, tarea FE.3)"*. Y la ruta admin (`messagingBulk.routes.ts:290-297`) sólo castea tipos.
  **Un caller M2M (una IA) no tiene mini-modal FE** → si `POST /labels` no normaliza, mandar
  `"Prueba API Externa"` termina en un `ChatwootUnavailableError` opaco (503) en vez de crear
  `prueba-api-externa`. La normalización tiene que vivir en la ruta EXTERNA (aditiva, sin tocar el
  use case compartido ni el comportamiento admin).
- **⚠️ Chatwoot NO distingue duplicado de caída.** `HttpChatwootGateway.createAccountLabel()`
  (`HttpChatwootGateway.ts:369-374`) envuelve TODO error de axios en `ChatwootUnavailableError`
  (503) vía `this.call()`; el propio port lo documenta como limitación conocida
  (`ChatwootGateway.ts:210-215`: *"Un `title` duplicado responde 4xx → cae en el mismo
  `ChatwootUnavailableError` (D2/D8: no se distingue un 409 semántico)"*). **El 409/422 "ya existe"
  que pide el ask NO sale gratis del mapping actual.** Hay que decidir cómo obtenerlo (ver
  Approaches, punto clave del change).
- **El obligatorio NO puede ser Zod.** `parseOr400` (`external-messaging.routes.ts:41-48`) responde
  **400 `VALIDATION_ERROR`**; el ask pide **422 `CHATWOOT_LABEL_REQUIRED`**. El schema Zod debe
  seguir con `chatwootLabel: z.string().optional()` (tipos) y la regla de NEGOCIO va en
  `assertValidShape` de `ValidateExternalBulk` (`ValidateExternalBulk.ts:476-490`) — exactamente el
  reparto que ya documenta el comentario VAL-1 de la ruta (`:58-61`).
- **Blast radius de tests: alto pero mecánico.** `VALID_BODY`
  (`external-messaging.routes.test.ts:213-219`) NO trae `chatwootLabel`, y
  `ValidateExternalBulk.test.ts` tiene ~60 `execute(` casi todos sin label. Con el label
  obligatorio, TODOS pasan a 422 salvo que se toquen los fixtures compartidos. Es la tarea de mayor
  volumen del change (y la de mayor riesgo de "verde falso" si se arregla test por test en vez de
  en el helper).

## Estado actual

### Lo que ya funciona (admin, `messagingBulk.routes.ts`)

| Pieza | Ubicación | Nota |
|---|---|---|
| `GET /api/messaging/bulk/chatwoot-labels` | `messagingBulk.routes.ts:262-279` | gate `auth` + `perms.templates`; responde `{data}`; se monta sólo si `listChatwootLabels` está inyectado |
| `POST /api/messaging/bulk/chatwoot-labels` | `messagingBulk.routes.ts:281-303` | gate `auth` + `perms.manage`; 201 con el DTO FLAT; castea `title`/`color` a `''` si no son string |
| `ListChatwootLabels.execute()` | `ListChatwootLabels.ts:15-17` | passthrough puro de `listAccountLabels()` |
| `CreateChatwootLabel.execute()` | `CreateChatwootLabel.ts:30-38` | valida title no-vacío + color hex `#RGB`/`#RRGGBB` → `InvalidChatwootLabelError` (código `VALIDATION_ERROR` → **400**), después llama al gateway |
| `ChatwootLabelDto` | `ChatwootGateway.ts:94-97` | `{title, color}` — SIN `id` (YAGNI, D1.a) |

**El color no tiene default en el backend**: `CreateChatwootLabel` exige un hex válido; la ruta
admin manda `''` si el body no lo trae → 400. El default que pide el ask (`color?` opcional) es
NUEVO y debe vivir en la ruta externa.

### Lo que ya funciona (API Externa, `external-messaging.routes.ts`)

- Auth: `createApiKeyMiddleware(config.externalMessaging.apiKey)` en el MOUNT (`app.ts:3646`),
  no en el router. Orden load-bearing (COMP-1): antes del mount global `/api/external/v1`.
- Auditoría: `machineActorMiddleware(rbacUserRepo, API_MESSAGING_USER_LOGIN)` en el mount
  (`app.ts:3653`) + `auditMutationsMiddleware` global → **todo POST bajo el prefijo ya queda
  auditado con `actorLogin:'api-messaging'`, sin escribir una línea nueva** (AUDIT-2, mismo molde
  que `POST /templates`).
- Kill-switch: para `validate`/`send` vive DENTRO de los use cases (KS-1); para las rutas sin use
  case propio (templates, `GET /credit`) el router lo chequea con `isFeatureEnabled()`
  (`:124-130`, fail-safe a OFF) **antes de tocar el proveedor**. `GET/POST /labels` caen en esta
  segunda categoría.
- `writeRateLimiter` (`:114`, `:121`) se aplica SOLO a los POST. `POST /labels` debe llevarlo;
  `GET /labels` no (molde `GET /credit`, `GET /templates`).
- Catch-all `router.use(...)` (`:283-285`) SELLA el prefijo — **las rutas nuevas MUST registrarse
  ANTES de él** (Express matchea por orden de registro), o devuelven 404.

### El label hoy, en `validate`/`send`

```
ValidateExternalBulk.execute()   (ValidateExternalBulk.ts:85-130)
  1. KS-1 flag                → FeatureExternalBulkDisabledError (403)
  2. assertValidShape(input)  → ExternalBulkValidationError (400)   ← acá va CHATWOOT_LABEL_REQUIRED
     const chatwootLabel = input.chatwootLabel ?? null              (:93)
  3. config (caps)
  4. VAL-4 template approved
  5. VAL-2 clasificación de recipients
  6. if (chatwootLabel) assertLabelExists(...)                      (:118-121)  ← el `if` desaparece
  ...
 10. VAL-8 persiste el preview con `chatwootLabel` DENTRO del payloadHash (:196, :211)

assertLabelExists()              (ValidateExternalBulk.ts:313-322)
  try listAccountLabels() catch → ChatwootUnavailableError (503, fail-closed)
  !labels.some(l => l.title === label) → ChatwootLabelNotFoundError (422)

SendExternalBulk                 (SendExternalBulk.ts:167-168, 419)
  MISMO patrón `if (preview.chatwootLabel)` + su propio `assertLabelExists` privado
```

El preview YA persiste el label y `send` YA lo re-verifica contra el catálogo vivo — la parte
"la preview persiste el label y `send` verifica que siga existiendo" del ask **ya está
implementada**; lo único que cambia es que el `if` deja de ser opcional.

### Mapeo de errores vigente (`errorHandler.ts` statusMap)

| Código | HTTP | Origen |
|---|---|---|
| `VALIDATION_ERROR` | 400 (`:122`) | `ExternalBulkValidationError`, `InvalidChatwootLabelError` |
| `CHATWOOT_LABEL_NOT_FOUND` | 422 (`:263`) | `ChatwootLabelNotFoundError` |
| `CHATWOOT_UNAVAILABLE` | 503 (`:183`) | `ChatwootUnavailableError` (incl. duplicado, hoy) |
| `FEATURE_DISABLED` | 403 | `FeatureExternalBulkDisabledError` |

`CHATWOOT_LABEL_REQUIRED` **no existe** — hay que agregar la clase de error + la entrada del
statusMap (→ 422).

## Áreas afectadas

- `src/infrastructure/http/routes/external-messaging.routes.ts` — 2 rutas nuevas + normalización +
  default de color + mapeo del duplicado. **ADITIVO** (nada existente cambia de forma), para que el
  rebase sobre `chatwoot-new-contact-404` (que toca `HttpChatwootGateway.createConversationWithTemplate`,
  otro archivo) sea trivial.
- `src/application/use-cases/messaging/ValidateExternalBulk.ts` — `assertValidShape` exige el label;
  el `if (chatwootLabel)` del paso 6 pasa a incondicional.
- `src/application/use-cases/messaging/SendExternalBulk.ts` — `if (preview.chatwootLabel)` (:167)
  pasa a incondicional (defensivo: un preview viejo, pre-deploy, puede tener `chatwootLabel:null`
  → decidir en design si eso es 422 `CHATWOOT_LABEL_REQUIRED` o se deja pasar; **riesgo real**, los
  previews viven 15 min y un deploy puede caer en el medio).
- `src/application/dto/external-bulk-messaging.dto.ts` — `chatwootLabel` deja de ser `?` en
  `ValidateExternalBulkInput` (`:34`).
- `src/domain/errors/external-bulk-messaging.ts` — clase `ChatwootLabelRequiredError`
  (código `CHATWOOT_LABEL_REQUIRED`).
- `src/infrastructure/http/middleware/errorHandler.ts` — `CHATWOOT_LABEL_REQUIRED: 422` (+ el
  código del duplicado si se elige uno nuevo).
- `src/infrastructure/http/app.ts` — 2 deps nuevas en el mount (`listChatwootLabels`,
  `createChatwootLabel`) reusando `chatwootGatewayForBulk` (la instancia YA está ahí).
  ⚠️ `external-bulk-messaging-composition.test.ts` recorta el bloque entre
  `app.use('/api/external/v1/messaging/bulk'` y el marcador `[external-bulk-mount-end]`
  (`app.ts:3696`) — no romper el marcador.
- Tests: `src/__tests__/infrastructure/external-messaging.routes.test.ts` (`VALID_BODY`,
  `buildApp.chatwootLabels`), `src/__tests__/application/messaging/ValidateExternalBulk.test.ts`
  (~60 `execute(`), `SendExternalBulk.test.ts`, y los composition tests que hagan `POST /validate`.
- `src/__tests__/helpers/FakeChatwootGateway.ts` — YA tiene todo lo necesario:
  `accountLabelsResult`, `failListAccountLabels` (:220), `createAccountLabelResult`,
  `createAccountLabelCalls`, `failCreateAccountLabel` (:228-236). **Cero cambios previstos**
  (salvo que se elija el Approach C para el duplicado).

## Enfoques evaluados

### A. Rutas `GET/POST /labels` en el router externo, reusando los 2 use cases (molde TPL)

1. **A — reuso directo** (recomendado). `GET /labels` → `isFeatureEnabled()` + `listChatwootLabels.execute()`
   → `{data}`. `POST /labels` → `writeLimit` + `isFeatureEnabled()` + Zod (`title` requerido,
   `color?`, `description?`) + normalización en la ruta + default de color + `createChatwootLabel.execute()`
   → 201.
   - Pros: cero use case nuevo, cero port nuevo, idéntico al precedente TPL-3; auditoría y auth
     salen gratis del mount; el admin no se entera.
   - Cons: la normalización queda en la capa HTTP (aceptable: es adaptación de wire, igual que
     `firstQueryValue`/`toManualClientIds` en el router admin).
   - Esfuerzo: **Bajo**.

2. **B — normalizar dentro de `CreateChatwootLabel`**.
   - Pros: una sola implementación para admin y externo.
   - Cons: **cambia el comportamiento admin** (scope-out explícito del ask) y contradice la
     decisión D5.a documentada en el propio use case; rompería sus tests actuales.
   - Esfuerzo: Bajo, pero fuera de scope. **Descartado.**

3. **C — use case nuevo `CreateExternalChatwootLabel`** que normalice + resuelva el duplicado.
   - Pros: la lógica queda testeable sin supertest.
   - Cons: duplica un use case por dos líneas de string-munging; el precedente TPL-3 dice
     explícitamente "CERO use case nuevo".
   - Esfuerzo: Medio. **Descartado salvo que design decida que el duplicado necesita lógica real.**

### B. Cómo devolver 409/422 en "el label ya existe"

1. **Pre-chequeo con `listAccountLabels()` antes de crear** (recomendado).
   El título normalizado ya existe en el catálogo vivo → responder 409 `CHATWOOT_LABEL_EXISTS`
   (o 200 idempotente con el label existente — decidir en design) sin tocar el POST de Chatwoot.
   - Pros: usa SÓLO capacidades que el port ya tiene; determinista y testeable con el fake;
     Chatwoot ya es la fuente de verdad del catálogo (mismo criterio que VAL-5).
   - Cons: TOCTOU (dos creadores concurrentes) → el segundo cae en el 503 opaco de siempre.
     Aceptable: mismo riesgo que `remainingToday` (documentado como no-atómico en el change previo).
   - Esfuerzo: **Bajo**.
2. **Discriminar el 4xx dentro de `HttpChatwootGateway`** (nuevo error de dominio desde el adapter).
   - Pros: sin TOCTOU, semánticamente correcto.
   - Cons: toca el adapter compartido con el admin y con `chatwoot-new-contact-404` (el change que
     aterriza ANTES) → conflicto de rebase justo en el archivo que ese change modifica.
     Rompe el contrato "resultado único" documentado del port.
   - Esfuerzo: Medio-Alto. **Descartado por el riesgo de rebase.**

### C. Dónde vive el "obligatorio"

1. **`assertValidShape` de `ValidateExternalBulk` + re-chequeo en `SendExternalBulk`** (recomendado):
   422 `CHATWOOT_LABEL_REQUIRED`, antes de tocar Chatwoot/DB, después del gate KS-1.
   Estos use cases son exclusivos de la API Externa (verificado) → el admin queda intacto por
   construcción, sin flags.
2. Zod `z.string().min(1)`: da **400**, no el 422 pedido. **Descartado.**

## Recomendación

**A1 + B1 + C1.** Dos rutas aditivas al final del router externo (antes del catch-all), reusando
`ListChatwootLabels`/`CreateChatwootLabel` tal cual; normalización + default de color + pre-chequeo
de duplicado en la capa HTTP externa; obligatoriedad como regla de negocio dentro de
`ValidateExternalBulk`/`SendExternalBulk` con un `ChatwootLabelRequiredError` nuevo mapeado a 422.
Cero cambios en `messagingBulk.routes.ts`, en `CreateChatwootLabel` ni en `HttpChatwootGateway` →
el rebase sobre `chatwoot-new-contact-404` no toca ninguna línea compartida.

## Riesgos

- **R1 — Fixtures compartidos (alto volumen).** `VALID_BODY` y las ~60 llamadas de
  `ValidateExternalBulk.test.ts` se ponen rojas de golpe. Arreglarlas en el HELPER (un
  `chatwootLabel` default + el catálogo del fake sembrado con ese título), NO test por test.
  Y dejar al menos un test que ejercite el 422 explícitamente, o el "verde" no prueba nada.
- **R2 — Previews en vuelo durante el deploy.** Un preview creado 10 min antes del deploy tiene
  `chatwootLabel:null` y su `payloadHash` lo incluye como `null`. Si `send` pasa a exigir el label,
  ese preview muere con 422. TTL 15 min ⇒ ventana corta y el caller re-hace `validate`; hay que
  decidirlo explícitamente en design (no dejarlo implícito).
- **R3 — Breaking change de contrato para el caller M2M.** Todo cliente que hoy llame `validate`
  sin `chatwootLabel` empieza a recibir 422. Es EXACTAMENTE lo que pide el ask, pero debe quedar
  escrito en el proposal y en la skill `whatsapp-bulk-ipnext` (fase posterior, tras el smoke).
- **R4 — Rebase con `chatwoot-new-contact-404`.** Mitigado por diseño: ese change toca
  `HttpChatwootGateway.createConversationWithTemplate`; éste no toca ese archivo.
- **R5 — Normalización divergente FE vs API Externa.** El mini-modal FE normaliza en el browser;
  la API Externa normalizaría en la ruta. Si las dos reglas difieren, dos caminos crean títulos
  distintos para el mismo input. Design debe fijar la regla exacta (trim → lowercase →
  espacios/whitespace runs → `-`) y citarla.
- **R6 — `description` no existe en el modelo.** `ChatwootLabelDto` es `{title, color}` y
  `createAccountLabel` sólo postea esos dos campos. El `description?` del ask NO tiene dónde ir sin
  tocar el port. Design debe decidir: (a) aceptarlo en el Zod y descartarlo silenciosamente (malo),
  (b) rechazarlo, o (c) extender port+adapter+DTO (fuera del "cero cambios compartidos").

## Ready for Proposal

**Yes.** Tres decisiones quedan abiertas para `sdd-propose`/`sdd-design`, todas con recomendación:
el tratamiento del duplicado (409 vs 200 idempotente), el destino de `description` (R6), y los
previews en vuelo (R2).
