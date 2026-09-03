/**
 * external-labels-required (fix wave F1, finding 2, decisión del orquestador
 * 2026-09-03) — normalización COMPARTIDA de un título de label de Chatwoot:
 * `trim` → `toLowerCase` → cada run de whitespace interno → un único `-`. La
 * regla es LITERAL a la de `design.md` D2 — el título normalizado ES el
 * identificador del label, tanto para crearlo (`POST .../labels`) como para
 * resolverlo (`ValidateExternalBulk`/`SendExternalBulk`).
 *
 * Antes vivía DUPLICADA como una constante local de `external-messaging.routes.ts`,
 * usada SOLO por `POST /labels`. `ValidateExternalBulk` comparaba el
 * `chatwootLabel` del caller apenas con `.trim()` contra un catálogo cuyos
 * títulos YA estaban normalizados — un caller que reusaba el título "bonito"
 * que acababa de crear (`"Cobranzas Agosto"`) recibía 422
 * `CHATWOOT_LABEL_NOT_FOUND` contra su PROPIO label recién creado
 * (`"cobranzas-agosto"`): el round-trip create→validate estaba roto. Este
 * helper es la ÚNICA fuente de la regla — `POST /labels` y
 * `ValidateExternalBulk` (donde entra el valor del CALLER) la aplican por
 * igual; `SendExternalBulk` la re-aplica de forma DEFENSIVA sobre
 * `preview.chatwootLabel` para cubrir un preview persistido con un valor no
 * normalizado (ventana de deploy, D5).
 *
 * NO se usa en `CreateChatwootLabel.ts` (admin, pass-through deliberado — ver
 * el comentario de ese archivo) ni en `messagingBulk.routes.ts`: esa ruta
 * conserva su comportamiento preexistente (LBL-5).
 */
export const normalizeLabelTitle = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '-');
