# Proposal: external-labels-required — servicio de labels en la API Externa + label obligatorio

## Intent

Hoy la API Externa (`/api/external/v1/messaging/bulk`) acepta `chatwootLabel` OPCIONAL y no expone
forma alguna de ver ni crear labels: una IA que quiera etiquetar su campaña tiene que adivinar un
título existente (422 `CHATWOOT_LABEL_NOT_FOUND` si falla) o mandar el lote SIN etiqueta. Campañas
sin label son invisibles en el inbox de Chatwoot: no se puede medir, filtrar ni auditar qué
conversación salió de qué envío. Este change cierra el ciclo: **el caller M2M consulta el catálogo,
crea el label que necesita, y no puede mandar un mensaje sin etiquetarlo.**

## Scope

### In Scope
- `GET /api/external/v1/messaging/bulk/labels` — catálogo vivo de Chatwoot (`{data:[{title,color}]}`),
  reusando `ListChatwootLabels` TAL CUAL.
- `POST .../labels` `{title, color?}` — crea el label reusando `CreateChatwootLabel` TAL CUAL, con
  **normalización del título en la ruta externa** (trim → lowercase → runs de whitespace → `-`),
  color default cuando no viene, y 409 `CHATWOOT_LABEL_EXISTS` por pre-chequeo del catálogo.
- Ambas rutas: key dedicada (del mount), kill-switch `messaging-external-bulk-enabled` explícito
  (molde `GET /credit`), `writeRateLimiter` sólo en el POST, auditoría gratis del mount (AUDIT-2).
- `chatwootLabel` **obligatorio** en `POST /validate` y re-chequeado en `POST /send`:
  ausente/vacío → 422 `CHATWOOT_LABEL_REQUIRED` (error de dominio nuevo); inexistente → 422
  `CHATWOOT_LABEL_NOT_FOUND` (ya existe); Chatwoot caído → 503, fail-closed (ya existe).
- Wiring en `app.ts` (2 deps nuevas, reusando `chatwootGatewayForBulk`) + actualización de los
  fixtures compartidos de test.

### Out of Scope
- **El composer admin** (`messagingBulk.routes.ts`, `CreateCampaign`): el label sigue OPCIONAL. Cero
  cambios de comportamiento ahí.
- Cambios en `CreateChatwootLabel`, `ListChatwootLabels`, el port `ChatwootGateway` o
  `HttpChatwootGateway` (evita el conflicto de rebase con `chatwoot-new-contact-404`).
- `description` en el label: `ChatwootLabelDto` es `{title, color}` y el port no lo soporta →
  el Zod lo **rechaza** explícitamente en vez de descartarlo mudo.
- Borrado/edición de labels; labels por conversación (ya cubierto por `addConversationLabels`).
- Sección "Labels" de la skill `whatsapp-bulk-ipnext` — fase POSTERIOR, tras el smoke en vivo.

## Capabilities

### New Capabilities
- `external-labels`: catálogo de labels de Chatwoot expuesto por la API Externa M2M — listado,
  creación con normalización y duplicados, auth+kill-switch, auditoría.

### Modified Capabilities
- `external-bulk-messaging`: VAL-1 pasa `chatwootLabel` de opcional a **requerido** (nuevo 422
  `CHATWOOT_LABEL_REQUIRED`); VAL-5 deja de estar condicionado a "si vino" y pierde la frase "el
  sistema MUST NUNCA crear el label" (revertida por pedido explícito); SEND-4 re-chequea el label
  siempre.

## Approach

Molde TPL-0..TPL-5 (las 4 rutas de templates externas): **cero use case nuevo**, rutas aditivas al
final del router externo, ANTES del catch-all que sella el prefijo. La normalización y el default
de color viven en la capa HTTP externa (adaptación de wire, no negocio compartido). La
obligatoriedad es regla de NEGOCIO y vive en `assertValidShape` de `ValidateExternalBulk` +
el re-chequeo de `SendExternalBulk` — ambos use cases son exclusivos de la API Externa, así que el
admin queda intacto por construcción, sin flags ni parámetros nuevos. El Zod mantiene
`chatwootLabel` opcional (un `.min(1)` daría 400, no el 422 pedido).

## Affected Areas

| Área | Impacto | Descripción |
|---|---|---|
| `src/infrastructure/http/routes/external-messaging.routes.ts` | Modified (ADITIVO) | 2 rutas + 1 Zod schema + normalizador |
| `src/application/use-cases/messaging/ValidateExternalBulk.ts` | Modified | `assertValidShape` exige label; el `if` de VAL-5 se vuelve incondicional |
| `src/application/use-cases/messaging/SendExternalBulk.ts` | Modified | re-chequeo incondicional del label del preview |
| `src/application/dto/external-bulk-messaging.dto.ts` | Modified | `chatwootLabel: string` (sin `?`) |
| `src/domain/errors/external-bulk-messaging.ts` | Modified | `ChatwootLabelRequiredError`, `ChatwootLabelExistsError` |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modified | `CHATWOOT_LABEL_REQUIRED:422`, `CHATWOOT_LABEL_EXISTS:409` |
| `src/infrastructure/http/app.ts` | Modified | 2 deps en el mount (marcador `[external-bulk-mount-end]` intacto) |
| `src/__tests__/**` | Modified | fixtures compartidos + tests nuevos |

## Risks

| Riesgo | Prob. | Mitigación |
|---|---|---|
| Breaking change: callers que hoy mandan `validate` sin label → 422 | Alta (esperado) | Es el ask. Documentar en la skill tras el smoke; el único caller conocido es la propia IA |
| Previews en vuelo (TTL 15 min) con `chatwootLabel:null` mueren en `send` | Media | Aceptado y documentado: ventana ≤15 min, el caller re-hace `validate`. `send` responde 422 `CHATWOOT_LABEL_REQUIRED`, no un 500 |
| Fixtures compartidos rojos en masa (~60 `execute(`) | Alta | Arreglar en el HELPER (label default + catálogo del fake sembrado), nunca test por test; test explícito del 422 para no comprar verde falso |
| TOCTOU en el pre-chequeo de duplicado | Baja | Dos creaciones simultáneas: la segunda cae en el 503 opaco de siempre. Mismo criterio no-atómico que `remainingToday` |
| Rebase con `chatwoot-new-contact-404` | Baja | Ese change toca `HttpChatwootGateway.createConversationWithTemplate`; éste no toca ese archivo |

## Rollback Plan

Revertir el commit del change. No hay migración de DB ni columna nueva, no hay env var nueva, no
hay dato persistido con forma nueva (`ExternalBulkPreview.chatwootLabel` ya existe y ya admite
`null`). Rollback parcial en caliente: no aplica un feature flag propio — el kill-switch existente
`messaging-external-bulk-enabled` apaga TODO el capability (rutas nuevas incluidas) en un PATCH.

## Dependencies

- `chatwoot-new-contact-404` aterriza ANTES (planificado en paralelo). Sin dependencia funcional.
- Chatwoot alcanzable con token de administrador (ya es requisito de `POST /chatwoot-labels` admin).
- `RbacUser` `api-messaging` ya bootstrappeado (ya lo usa el mount).

## Success Criteria

- [ ] `GET .../labels` con la key dedicada devuelve el MISMO catálogo que `GET /api/messaging/bulk/chatwoot-labels`.
- [ ] `POST .../labels {title:"Prueba API Externa"}` crea `prueba-api-externa` en Chatwoot (201) y
      repetirlo devuelve 409 `CHATWOOT_LABEL_EXISTS`.
- [ ] `POST .../validate` sin `chatwootLabel` → 422 `CHATWOOT_LABEL_REQUIRED`, sin tocar Chatwoot ni persistir preview.
- [ ] `POST .../validate` con el label recién creado → 200 con preview.
- [ ] `POST .../send` de un preview cuyo label fue borrado de Chatwoot → 422 `CHATWOOT_LABEL_NOT_FOUND`.
- [ ] `messagingBulk.routes.ts` sin una sola línea modificada; sus tests verdes sin tocar.
- [ ] Smoke en vivo de los 5 puntos anteriores contra producción, antes de tocar la skill.
