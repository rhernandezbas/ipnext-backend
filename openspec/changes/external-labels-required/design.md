# Design: external-labels-required

> Specs: `specs/external-labels/spec.md` (LBL-1..LBL-5) + delta `specs/external-bulk-messaging/spec.md`
> (VAL-1, VAL-5, SEND-4). Repo BE, worktree `.claude\worktrees\external-labels-required-be`.
> **Restricción de rebase**: `chatwoot-new-contact-404` aterriza ANTES y toca
> `HttpChatwootGateway.createConversationWithTemplate`. Este design NO toca ese archivo, y en
> `external-messaging.routes.ts` sólo AGREGA (2 rutas + 1 schema + 1 helper), sin reordenar nada.

## Technical Approach

Molde literal de TPL-0..TPL-5 (las 4 rutas de templates externas): **cero use case nuevo, cero port
nuevo, cero migración**. Las 2 rutas se registran en `createExternalMessagingRouter` ANTES del
catch-all (`external-messaging.routes.ts:283`, que sella el prefijo por orden de registro), reusando
`ListChatwootLabels`/`CreateChatwootLabel` tal cual. Auth y auditoría llegan del mount
(`app.ts:3645-3655`: `createApiKeyMiddleware(config.externalMessaging.apiKey)` +
`machineActorMiddleware`), el kill-switch se chequea con el `isFeatureEnabled()` que ya vive en el
router (`:124-130`). La obligatoriedad del label es regla de negocio y vive en los use cases —
exclusivos de la API Externa, verificado con `rg -l ValidateExternalBulk src/`.

## Architecture Decisions

### D1 — Dónde vive el "obligatorio"
| Opción | Trade-off | Decisión |
|---|---|---|
| Zod `z.string().min(1)` | Simple, pero `parseOr400` responde **400**; el spec pide 422 | ❌ |
| `assertValidShape` de `ValidateExternalBulk` (`:476-490`) + re-chequeo en `SendExternalBulk` | Regla de negocio en la capa correcta, 422 propio, ANTES de todo I/O | ✅ |

El Zod mantiene `chatwootLabel: z.string().optional()` (valida TIPO: un `chatwootLabel: 42` sigue
siendo 400 antes de tocar el use case). El orden dentro de `execute()` no cambia: KS-1 (paso 1) →
`assertValidShape` (paso 2, donde entra el nuevo throw) → resto.

### D2 — Normalización del título: en la ruta externa, NO en el use case
`CreateChatwootLabel.ts:18-25` documenta pass-through deliberado (D5.a del change previo) y delega
la normalización al mini-modal FE. Un caller M2M no tiene FE. Normalizar dentro del use case
cambiaría el comportamiento admin (scope-out del ask) y rompería sus tests. → helper local
`normalizeLabelTitle()` en `external-messaging.routes.ts`, capa de adaptación de wire (mismo lugar
que `firstQueryValue`/`toManualClientIds` en el router admin).

```ts
// trim → lowercase → runs de whitespace → '-'  (LBL-2, regla ÚNICA y citable)
const normalizeLabelTitle = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, '-');
```

### D3 — Duplicado: pre-chequeo con `listAccountLabels`, IDEMPOTENTE (**decisión del orquestador,
2026-09-03** — reemplaza la recomendación original de 409, ver Open Questions)
`HttpChatwootGateway.createAccountLabel` (`:369-374`) envuelve TODO error de axios en
`ChatwootUnavailableError` (503) — el port lo documenta como limitación conocida
(`ChatwootGateway.ts:210-215`). Discriminar el 4xx exigiría tocar el adapter compartido (riesgo de
rebase + rompe el contrato "resultado único" del port). → La ruta lista el catálogo, compara el
título YA normalizado contra el catálogo vivo (también normalizado) y, si YA existe, responde
**200 `{...existingLabel, created:false}`** sin postear — un caller M2M (IA) que reintenta una
creación no debe tratar "ya existe" como una falla: es exactamente el resultado que quería. Si NO
existe, crea y responde **201 `{...label, created:true}`**. TOCTOU aceptado (dos creaciones
simultáneas: la segunda cae en el 503 opaco de siempre, o en el peor caso ambas crean si Chatwoot no
tiene unicidad estricta en el instante — no distinto del riesgo ya aceptado en `remainingToday`) —
mismo criterio no-atómico. La falla del LISTADO en este pre-chequeo es 503, no un "no existe"
optimista.

### D4 — `color` default y `description`
`CreateChatwootLabel` exige hex válido y no tiene default. La ruta externa resuelve
`color ?? DEFAULT_LABEL_COLOR = '#1f93ff'` (el azul default de Chatwoot; NO se usa el naranja de
marca: el label vive en el inbox de Chatwoot, no en una pieza de IPNEXT). `description` NO existe en
`ChatwootLabelDto` (`{title,color}`) ni en el POST del adapter → el Zod lo declara y lo RECHAZA
(400), en vez de aceptarlo y descartarlo mudo (fail-loud, criterio del repo).

### D5 — Preview viejo sin label (ventana de deploy)
`SendExternalBulk:167` pasa de `if (preview.chatwootLabel)` a: `null`/vacío → `ChatwootLabelRequiredError`
(422), si no → `assertLabelExists` incondicional. TTL 15 min ⇒ ventana acotada; el caller re-hace
`validate`. Un 500 o un envío sin etiqueta serían peores.

## Data Flow

```
POST /labels ──► apiKey(dedicada) ──► machineActor ──► writeLimit ──► isFeatureEnabled()
                                                                          │ false → 403
                                                                          ▼
                        Zod(title, color?, description prohibido) ──400──►│
                                                                          ▼
                     normalizeLabelTitle() ──► listAccountLabels() ──► ¿existe? ──sí──► 200 {...existingLabel, created:false}
                                                     │ throw → 503          │ no
                                                     ▼                      ▼
                                            CreateChatwootLabel.execute() ──► 201 {...label, created:true}

POST /validate ──► Zod(tipos) ──► ValidateExternalBulk
                                    1 KS-1 → 403
                                    2 assertValidShape → 400 | **422 CHATWOOT_LABEL_REQUIRED**
                                    …
                                    6 assertLabelExists (SIEMPRE) → 422 NOT_FOUND | 503
```

## File Changes

| Archivo | Acción | Descripción |
|---|---|---|
| `src/infrastructure/http/routes/external-messaging.routes.ts` | Modify (aditivo) | `CreateLabelBodySchema`, `normalizeLabelTitle`, `DEFAULT_LABEL_COLOR`, `GET /labels`, `POST /labels` (antes del catch-all, idempotente 200/201), 2 deps nuevas en `ExternalMessagingRouterDeps` |
| `src/domain/errors/external-bulk-messaging.ts` | Modify | `ChatwootLabelRequiredError` (`CHATWOOT_LABEL_REQUIRED`) + actualizar el comentario del mapping. **Sin `ChatwootLabelExistsError`** (decisión del orquestador: el duplicado ya NO es un error, es 200 idempotente) |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modify | `CHATWOOT_LABEL_REQUIRED: 422` |
| `src/application/dto/external-bulk-messaging.dto.ts` | Modify | `chatwootLabel: string` (sin `?`) en `ValidateExternalBulkInput` |
| `src/application/use-cases/messaging/ValidateExternalBulk.ts` | Modify | `assertValidShape` exige label no-vacío; paso 6 incondicional; `const chatwootLabel = input.chatwootLabel.trim()` |
| `src/application/use-cases/messaging/SendExternalBulk.ts` | Modify | `:167` incondicional + guard de `null` (D5) |
| `src/infrastructure/http/app.ts` | Modify | `listChatwootLabels: new ListChatwootLabels(chatwootGatewayForBulk)`, `createChatwootLabel: new CreateChatwootLabel(chatwootGatewayForBulk)` dentro del mount. **NO tocar el marcador `[external-bulk-mount-end]`** (`:3696`) |
| `src/__tests__/infrastructure/external-messaging.routes.test.ts` | Modify | `VALID_BODY` suma `chatwootLabel`; `buildApp` siembra ese título en `chatwootLabels`; deps nuevas; describes nuevos |
| `src/__tests__/application/messaging/{ValidateExternalBulk,SendExternalBulk}.test.ts` | Modify | fixture/helper compartido con label default + catálogo sembrado |

## Interfaces / Contracts

```ts
// external-messaging.routes.ts (ADITIVO)
const CreateLabelBodySchema = z.object({
  title: z.string(),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
}).strict();          // `.strict()` ⇒ `description` (o cualquier extra) → 400 (LBL-2)

interface ExternalMessagingRouterDeps {           // + 2 campos, ambos REQUERIDOS
  listChatwootLabels: ListChatwootLabels;
  createChatwootLabel: CreateChatwootLabel;
}
```

`GET /labels` → `200 {data: ChatwootLabelDto[]}` (envelope, molde `GET /templates`).
`POST /labels` → **decisión del orquestador**: idempotente. Título nuevo ⇒ `201 {title, color,
created:true}`. Título YA existente (tras normalizar) ⇒ `200 {title, color, created:false}` con la
ficha DEL CATÁLOGO (no la del body — si el caller mandó un `color` distinto del existente, gana el
existente: no se pisa nada). FLAT + `created` (molde de la ruta admin extendido, sin envelope).

## Error mapping

| Situación | Error | Code | HTTP |
|---|---|---|---|
| Sin key / key global | (middleware) | `UNAUTHORIZED` | 401 |
| Flag OFF / repo de flags tira | `FeatureExternalBulkDisabledError` | `FEATURE_DISABLED` | 403 |
| Body inválido (`title` no string, color no hex, extra key) | zod `parseOr400` | `VALIDATION_ERROR` | 400 |
| `title` vacío tras normalizar | `InvalidChatwootLabelError` (ya existe) | `VALIDATION_ERROR` | 400 |
| Título ya en el catálogo | — (sin error, decisión del orquestador) | — | **200** `{...existingLabel, created:false}` |
| Chatwoot inalcanzable (list o create) | `ChatwootUnavailableError` | `CHATWOOT_UNAVAILABLE` | 503 |
| `validate`/`send` sin label | `ChatwootLabelRequiredError` **(nuevo)** | `CHATWOOT_LABEL_REQUIRED` | 422 |
| Label inexistente en `validate`/`send` | `ChatwootLabelNotFoundError` | `CHATWOOT_LABEL_NOT_FOUND` | 422 |
| POST por encima del rate limit | (middleware) | `RATE_LIMITED` | 429 |

## Testing Strategy

TDD estricto (RED → GREEN → refactor). **Use cases REALES + `FakeChatwootGateway`** — jamás mockear
el use case ni Prisma (lección #27/#28 del repo). El fake YA soporta todo lo necesario:
`accountLabelsResult`, `failListAccountLabels` (`:220`), `createAccountLabelResult`,
`createAccountLabelCalls` (`:231`), `failCreateAccountLabel` → **cero cambios en el helper**.

| Capa | Qué | Cómo |
|---|---|---|
| Routes (supertest) | LBL-1..LBL-4: 200/vacío/503, 201 normalizado (`created:true`), color default/explícito/inválido, `description` → 400, 200 idempotente duplicado (asserteando `createAccountLabelCalls.length === 0` y `created:false`), 401, 403 flag OFF, 429 del POST y NO del GET, auditoría del POST vía `InMemoryAuditEventRepository` | `external-messaging.routes.test.ts`, `buildApp` extendido |
| Use case | VAL-1: falta/vacío/whitespace → `ChatwootLabelRequiredError`; KS-1 gana sobre el 422; `listAccountLabels` NO se llamó | `ValidateExternalBulk.test.ts` |
| Use case | SEND-4: label borrado → `ChatwootLabelNotFoundError`; preview `chatwootLabel:null` → `ChatwootLabelRequiredError`; ni `Campaign` ni `markConsumed` | `SendExternalBulk.test.ts` |
| No-regresión | `messagingBulk.routes.test.ts` y `CreateChatwootLabel.test.ts` verdes **sin tocarse** (LBL-5) | correrlos tal cual |
| Composición | el mount sigue registrado antes del global y el marcador intacto | `external-bulk-messaging-composition.test.ts` |

**Trampa de fixtures**: `VALID_BODY` (`:213`) y las ~60 `execute(` de `ValidateExternalBulk.test.ts`
se ponen rojas de golpe. Arreglar **en el helper** (un `chatwootLabel` default + el catálogo del
fake sembrado con ese mismo título), NUNCA test por test — y dejar tests explícitos del 422, o el
verde no prueba nada.

## Migration / Rollout

Sin migración: `ExternalBulkPreview.chatwootLabel` ya existe y ya admite `null`; sin env var nueva;
sin flag nuevo (el kill-switch existente apaga todo). Rollout = deploy del commit. Callers M2M
existentes que validen sin label empiezan a recibir 422 — es el ask.

## Smoke en vivo (post-deploy, ANTES de tocar la skill)

1. `GET .../labels` con la key dedicada → 200, catálogo real.
2. `POST .../labels {"title":"Prueba API Externa"}` → 201 `prueba-api-externa`, `created:true`;
   verificar en Chatwoot.
3. Repetir (2) → 200 `prueba-api-externa`, `created:false` (idempotente, decisión del orquestador).
4. `POST .../validate` SIN `chatwootLabel` → 422 `CHATWOOT_LABEL_REQUIRED`.
5. `POST .../validate` con `chatwootLabel:"prueba-api-externa"` → 200 con `previewId`.
6. `POST .../labels {"title":"x","description":"y"}` → 400.

Recién con los 6 verdes: sección "Labels" en la skill `whatsapp-bulk-ipnext` (SKILL.md único),
tarea del orquestador.

## Open Questions

- [x] ¿El 409 por duplicado debería ser en cambio un 200 idempotente devolviendo el label existente?
      **Resuelto — decisión del orquestador (2026-09-03)**: SÍ, 200 idempotente
      `{...existingLabel, created:false}` (título nuevo ⇒ 201 `{...label, created:true}`). Se
      descarta el 409 `CHATWOOT_LABEL_EXISTS` (nunca llega a implementarse). Ver D3.
- [x] `DEFAULT_LABEL_COLOR = '#1f93ff'` — **confirmado por el orquestador (2026-09-03)**: se
      mantiene el azul default de Chatwoot, sin cambios.

## Fix wave F1 (review post-apply, 2026-09-03)

7 findings del review adversarial, todos resueltos EN EL MISMO worktree (staged, sin commitear —
lo commitea el orquestador). Actualiza D1/D2/D3 de arriba; el resto del design queda vigente.

### D1 (actualización) — Zod pasa a `nullable().optional()`
`chatwootLabel: z.string().optional()` dejaba pasar un `chatwootLabel: null` EXPLÍCITO como un tipo
no contemplado por el schema → Zod lo rechazaba con **400** `VALIDATION_ERROR`, no el 422
`CHATWOOT_LABEL_REQUIRED` que exige VAL-1 (la obligatoriedad es de NEGOCIO). Fix: `z.string().nullable().optional()`
— el Zod sigue validando SOLO tipo (`null` es un tipo legítimo de "ausente"), `assertValidShape`
sigue siendo la única fuente de la regla 422.

### D2 (actualización) — `normalizeLabelTitle` se mueve a capa de aplicación, compartido
El D2 original ubicaba el helper como una constante LOCAL de `external-messaging.routes.ts`, usada
solo por `POST /labels`. Bug descubierto en el review: `ValidateExternalBulk` comparaba
`chatwootLabel` contra el catálogo con SOLO `.trim()` (sin normalizar) — un caller que reusaba el
título "bonito" que acababa de crear (`"Cobranzas Agosto"`) recibía 422
`CHATWOOT_LABEL_NOT_FOUND` contra su propio label recién creado (`"cobranzas-agosto"`): el
round-trip create→validate estaba roto. Fix: `normalizeLabelTitle` se mueve a
`src/application/use-cases/messaging/normalizeLabelTitle.ts` (capa de aplicación, exportado) y lo
usan `POST /labels` (ruta), `ValidateExternalBulk` (normaliza el `chatwootLabel` del caller ANTES de
matchear contra el catálogo y ANTES de persistir el preview) y `SendExternalBulk` (normaliza
`preview.chatwootLabel` de forma DEFENSIVA, por si el preview viene de la ventana de deploy con un
título sin normalizar) — la `Campaign` creada por `send` recibe el título CANÓNICO, no el crudo del
preview. `ValidateExternalBulkOutput` gana el campo `chatwootLabel` (aditivo, D12) — el caller ve el
título normalizado que quedó persistido. `CreateChatwootLabel.ts` (admin) NO se toca — sigue con
pass-through deliberado (LBL-5).

### D3 (actualización) — TOCTOU del pre-chequeo: re-listado ANTES del 503
El D3 original aceptaba el TOCTOU "tal cual" (503 opaco si `createAccountLabel` fallaba tras el
pre-chequeo). Fix: si `createAccountLabel` falla con algo que NO es `InvalidChatwootLabelError`, la
ruta re-lista el catálogo UNA vez antes de declarar `CHATWOOT_UNAVAILABLE` — si el título YA existe
(otro request ganó la carrera), responde el MISMO 200 idempotente `{...existingLabel, created:false}`
del pre-chequeo; si sigue sin existir (o el re-listado también falla), 503 como antes.

### D6 (nuevo) — Charset del título, chequeado en la ruta
Chatwoot solo acepta `[letras unicode, números, "_", "-"]` en el título de un label.
`createAccountLabel` (adapter real) envuelve CUALQUIER error de axios en `ChatwootUnavailableError`
(503) — un título con un carácter no soportado (emoji, `#`, `/`, etc.) llegaba hasta el proveedor y
volvía como "Chatwoot está caído", cuando el problema real es el input del caller. Fix: regex
`/^[\p{L}\p{N}_-]+$/u` chequeada DESPUÉS de `normalizeLabelTitle` (el `-` que introduce la
normalización es válido) y ANTES de tocar el catálogo/Chatwoot → 400 `VALIDATION_ERROR` con un
mensaje que lista los caracteres ofensores.

### D7 (nuevo) — Tope de longitud del título
`title` no tenía cota superior — un string de miles de caracteres viajaba hasta `createAccountLabel`
antes de fallar por cualquier motivo. Fix: `z.string().min(1).max(100)` en `CreateLabelBodySchema`
(100 = mismo límite que Chatwoot aplica del lado del server para el nombre de un label).

### D8 (nuevo) — Orden de guards en `SendExternalBulk` (SEND-4)
El guard `CHATWOOT_LABEL_REQUIRED` (preview con `chatwootLabel:null`) corría DESPUÉS de
`assertTemplateApproved`. Un preview de la ventana de deploy puede traer `chatwootLabel:null` Y
apuntar a un template que mientras tanto dejó de estar aprobado — el caller veía
`TEMPLATE_NOT_APPROVED` en vez del motivo real y más accionable. Fix: el guard de label se movió
ANTES del chequeo de template, dentro del mismo paso 4 de D0.

### Archivos tocados por la fix wave (además de los de la tabla original)
| Archivo | Acción |
|---|---|
| `src/application/use-cases/messaging/normalizeLabelTitle.ts` | Nuevo — helper compartido |
| `src/application/use-cases/messaging/ValidateExternalBulk.ts` | Normaliza + echo `chatwootLabel` |
| `src/application/use-cases/messaging/SendExternalBulk.ts` | Normaliza defensivo + reordena guard |
| `src/application/dto/external-bulk-messaging.dto.ts` | `ValidateExternalBulkOutput.chatwootLabel` (aditivo) |
| `src/infrastructure/http/routes/external-messaging.routes.ts` | `.nullable()`, charset, `.max(100)`, TOCTOU recheck |
| `src/__tests__/helpers/FakeChatwootGateway.ts` | `createAccountLabel` ahora persiste en `accountLabelsResult` (simula Chatwoot real) |
