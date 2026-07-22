# Proposal — campaign-chatwoot-label (label opcional de Chatwoot al crear una campaña bulk)

## 1. Why / Intent

Decisión del usuario (2026-07-22): al crear una campaña bulk, el operador puede **opcionalmente**
elegir un **label de Chatwoot** que se **auto-aplica a las conversaciones alcanzadas** por la campaña.
Antecedente directo: `chatwoot-hub-sendpath` (archivado, en PROD) flipeó `SendCampaign` a crear
conversaciones REALES en Chatwoot (`createConversationWithTemplate` → `chatwootConversationId` persistido,
CHW-2/CHW-4). Ahora esas conversaciones deben quedar **etiquetadas del lado Chatwoot** para reporting /
automation rules / triage de agentes que sí entran a la UI de Chatwoot.

El picker NO es texto libre: se alimenta del **catálogo real** de Chatwoot (`GET /accounts/2/labels`) para
no crear labels "huérfanos" (tag sin ficha de color en Settings). Además el usuario pidió un flujo para
**CREAR un label nuevo desde Prominense** (ficha COMPLETA del catálogo: `POST /accounts/2/labels` con
`title` + `color`), porque el catálogo hoy tiene **UN solo label** (`cobranzas`).

Este change se apoya en la exploración `sdd/campaign-chatwoot-label/explore` (mapa técnico completo,
paths:líneas, API de Chatwoot verificada en vivo) y en la decisión de producto
`sdd/campaign-label-y-task-recipients/decisiones`.

**Restricción de naming (CRÍTICA, del explore §3)**: existe YA un feature LOCAL `ConversationLabel` /
`ConversationLabelAssignment` (Ola 5) — catálogo de colores 100% interno del mirror que *"Chatwoot NUNCA
se entera"*. NADA que ver con el label REAL de Chatwoot que se pide acá. Para evitar colisión conceptual,
**TODA superficie nueva lleva el prefijo `chatwoot`** (campo `chatwootLabel`, port `listAccountLabels`/
`addConversationLabels`, ruta `/chatwoot-labels`, componente `ChatwootLabelSelector`).

## 2. Scope IN

1. **Campo aditivo `Campaign.chatwootLabel String?`** (nullable, molde de `templateName`) — persiste el
   `title` del label elegido. Migración aditiva, sin backfill, sin tocar `CampaignRecipient`.
2. **Extensión del port `ChatwootGateway`** con 2 métodos nuevos (mismo error único `ChatwootUnavailableError`):
   - `listAccountLabels(): Promise<ChatwootLabelDto[]>` — GET del catálogo (`{id,title,color}`), para poblar
     el Select del FE.
   - `createAccountLabel({title, color}): Promise<ChatwootLabelDto>` — POST al catálogo (ficha completa).
   - `addConversationLabels(chatwootConversationId, labels: string[]): Promise<void>` — aplica labels a una
     conversación con la mecánica **GET-unión-POST** obligatoria (§Decisión C).
   `HttpChatwootGateway` implementa los 3 reusando `accountPath`/`this.call` (molde `sendTemplateMessage`).
3. **2 rutas BE proxy** bajo `/api/messaging/bulk` para el catálogo (dos capas de permiso, §Decisión A):
   - `GET /chatwoot-labels` → use case `ListChatwootLabels` → `listAccountLabels()`. Gate `messaging.templates`.
   - `POST /chatwoot-labels` → use case `CreateChatwootLabel` → `createAccountLabel()`. Gate `messaging.manage`.
4. **Enganche del etiquetado en `SendCampaign.processRecipient`**: paso best-effort **DESPUÉS de
   `persistRecipientSent`**, MISMO contrato que `projectToInbox` (try/catch aislado que solo loguea, JAMÁS
   re-marca `failed`). Aplica sobre el `chatwootConversationId` del recipient — tanto el recién creado
   (CHW-2, primer envío) como el del **hilo ya existente** (CHW-1, recipient que ya tenía conversación).
5. **Cableo del campo** por la cadena existente: `CreateCampaignInput` (DTO) → `CreateCampaign` (pasa directo
   al repo, cero validación adicional, §Decisión D) → `messagingBulk.routes.ts` POST `/campaigns` (parseo
   `chatwootLabel` molde `templateName`).
6. **FE**: `ChatwootLabelSelector` (molde `TemplateSelector`, componente `Select` molecule, 4 ramas
   loading/error/empty/success) + flujo "crear label" (nombre + color) en la card **"Mensaje"** del
   `CampaignComposer`; hook `useChatwootLabels()` (React Query, molde `useTemplates`); `chatwootLabel?` en
   `CreateCampaignInput` del FE (omitido cuando vacío).

## 3. Scope OUT (anti scope-creep)

- **NO se toca el feature LOCAL `ConversationLabel`** (Ola 5, `/api/messaging/labels`, `messagingLabels.routes.ts`).
  Son universos distintos; este change NO los unifica ni los cruza.
- **NO se agrega un flag propio** (§Decisión E). El etiquetado ya está implícitamente gobernado por el flag
  existente `messaging-send-via-chatwoot` (sin conversación Chatwoot no hay a qué aplicar el label).
- **NO se re-etiqueta retroactivamente** campañas viejas ni conversaciones ya enviadas antes de este change.
- **NO se expone `chatwootLabel` en `CampaignDto`/`GetCampaign`** en v1 (auditoría "qué label se aplicó" =
  nice-to-have, §Riesgo 5 del explore) — puede sumarse trivialmente después, no bloquea.
- **NO se editan/borran labels del catálogo Chatwoot desde Prominense** (solo list + create). Rename/delete
  se hacen en Chatwoot Settings (admin).
- **NO hay retry/reconciliación del labeling fallido** — misma deuda aceptada que `projectToInbox` (§Decisión C).

## 4. Evidencia técnica (verificada en vivo — resumen; detalle en el explore)

| Hecho | Implicación |
|---|---|
| Catálogo de labels = model `Label` (tabla `labels`), CRUD `GET/POST /accounts/2/labels`; create/update/destroy **solo administrator** (token `ronald` alcanza) | list + create viables con el token actual |
| Labels de conversación (tags `acts_as_taggable_on`) ≠ catálogo `Label`; `POST /conversations/:id/labels` con `{labels:[...]}` hace `update!(label_list:)` — **REEMPLAZA el set completo, NO es aditivo** | el adapter DEBE hacer GET→unión→POST (§Decisión C) para no pisar labels manuales/de otra campaña |
| No hay endpoint REST "add" público (`add_labels` existe pero no expuesto) — solo "replace" | confirma que el read-modify-write lo hace el adapter, no la API |
| Asignar un title nuevo crea el tag pero **NO** la ficha del catálogo `Label` (sin color, huérfano) | el Select se alimenta del catálogo real; el flujo "crear" usa `POST /labels` (ficha completa) |
| `SendCampaign.processRecipient` ya captura `chatwootConversationId` (línea ~251) incluso con `chatwootMessageId` null | el labeling NO depende del message id; engancha post-`persistRecipientSent` (~281) como `projectToInbox` (~286) |
| Catálogo hoy = 1 label (`cobranzas`, `#34E200`) | justifica el flujo "crear label" desde Prominense |

## 5. Approach / Arquitectura (hexagonal)

El seam es el **port `ChatwootGateway`**: los 3 métodos nuevos viven en la interfaz de `domain/ports`, los
use cases (`ListChatwootLabels`, `CreateChatwootLabel`, y el enganche dentro de `SendCampaign`) dependen SOLO
del port; `HttpChatwootGateway` (infra) es el único que sabe de HTTP/Chatwoot. Cero filtración de Chatwoot al
núcleo — misma jugada que fundó `ChatwootGateway` en `messaging-inbox` y la extendió `chatwoot-hub-sendpath`.

- **DTO nuevo** `ChatwootLabelDto {id:number; title:string; color:string}` (mapeo curado del payload jbuilder;
  jamás se devuelve el shape crudo de Chatwoot).
- **`addConversationLabels`** encapsula el read-modify-write (GET actuales → `union(set, [chatwootLabel])` →
  POST set completo) DENTRO del adapter — los use cases no ven la mecánica, solo piden "agregá este label".
- **Enganche en `SendCampaign`**: función nueva `applyChatwootLabel(chatwootConversationId, campaign.chatwootLabel)`
  (o inline junto a `projectToInbox`), invocada solo si `campaign.chatwootLabel != null` **y** hubo
  `chatwootConversationId` (path Chatwoot efectivo). try/catch que loguea y sigue — best-effort del repo.

## 6. Decisiones (A–E) con tradeoffs

### A. Permisos de las rutas de catálogo — **dos tiers: `messaging.templates` para listar, `messaging.manage` para crear**

**Elegido.** El repo YA distingue estos dos niveles y hay precedente EXACTO:

- **`GET /chatwoot-labels` (listar) → `messaging.templates`.** Mismo gate que el sibling `GET /bulk/templates`,
  que alimenta la MISMA card "Mensaje" del composer (el `TemplateSelector` ya vive gateado a
  `messaging.templates`, líneas 463-464). El label picker es un consumo de lectura para componer → tier lectura.
- **`POST /chatwoot-labels` (crear ficha de catálogo) → `messaging.manage`.** Precedente directo: el CRUD del
  catálogo LOCAL `ConversationLabel` está gateado por `messaging.manage` (migración
  `20260927000100_conversation_labels`: *"El permiso RBAC messaging.manage (gate del CRUD) YA está seedeado"*).
  `messaging.manage` es el tier "supervisor" del repo (gate de notas internas, canned responses, catálogo de
  labels local). Crear un label de catálogo Chatwoot (mutación de catálogo, admin-only del lado Chatwoot) mapea
  1:1 a ese tier. NO se siembra permiso nuevo — se reusa `messaging.manage` (ya otorgado a super_admin +
  administrador).
- **Descartado** gatear ambas al mismo `messaging.bulk`: aplanaría un privilegio (mintear catálogo = supervisor)
  a nivel operador de campañas. El repo separa "operar" de "administrar catálogo" — respetamos esa línea.
- **Dos capas SIEMPRE**: además del guard BE (`requirePermission`), el FE gatea el picker bajo
  `can('messaging.templates')` y el botón "crear label" bajo `can('messaging.manage')` (`<Can>` + `can()`).

### B. Timing del etiquetado — **por-destinatario al enviar, post-`persistRecipientSent`, best-effort aislado**

**Elegido.** El label se aplica dentro de `processRecipient`, DESPUÉS de que el recipient quedó `sent`, con el
MISMO patrón `try/catch → console.error → sigue` de `projectToInbox`. Nunca antes del `sent`, nunca capaz de
volver el recipient `failed`. Contrato:

- **Aplica al hilo NUEVO y al EXISTENTE** (§Decisión F): usa el `chatwootConversationId` del recipient sea cual
  sea su origen (creado por CHW-2 o preexistente por CHW-1).
- **Retry/resume de campaña** (SEND-6, cursor keyset): un recipient ya `sent` NUNCA se re-procesa → su label no
  se re-aplica ni se duplica. Un recipient `queued`/`failed` que se reintenta sí pasa por el labeling en su
  corrida. Gracias al GET-unión-POST idempotente (§C), re-aplicar el mismo label es un no-op semántico.
- **Flag OFF a mitad de campaña**: si un recipient se procesó por Twilio-directo (sin `chatwootConversationId`),
  el labeling se **saltea** para ese recipient (no hay conversación) — sin error. Coherente con CHW-3 (el flag se
  resuelve por-invocación).

### C. Mecánica del adapter — **GET-unión-POST idempotente; falla = contador + log, JAMÁS `failed`**

**Elegido (obligatorio por la API).** `addConversationLabels` hace: `GET /conversations/:id/labels` (títulos
actuales) → unión de conjuntos con `chatwootLabel` → `POST /conversations/:id/labels` con el set COMPLETO. Así
JAMÁS pisa labels que un agente puso a mano ni el label de otra campaña previa sobre la misma conversación.

- **Idempotente**: unión de un set consigo mismo = no-op → reintentos/re-aplicaciones seguras.
- **Si el GET-unión-POST FALLA** (Chatwoot 5xx/timeout/red): el adapter lanza `ChatwootUnavailableError`, el
  `try/catch` del enganche lo absorbe, **loguea** (`console.error` con `campaignId`+`chatwootConversationId`) y
  **sigue**. El recipient queda `sent` sin label. Se cuenta como parte de la deuda best-effort ya existente
  (`projectToInbox`) — NO se re-marca `failed`, NO hay retry. Opcional (spec-phase): incrementar un contador
  observable `labelSkippedCount` en el log del run (no bloqueante).
- **Tradeoff aceptado**: read-modify-write NO atómico → race window si un agente edita labels en el instante
  exacto del envío. Riesgo residual documentado (mismo patrón de cualquier RMW sobre REST no transaccional).

### D. Validación del label al crear la campaña — **se confía en el pick, cero re-validación contra catálogo**

**Elegido: confiar.** El Select se alimenta del catálogo real (`GET /accounts/2/labels`) → al momento del pick
el label EXISTE. `CreateCampaign` persiste el `title` tal cual, SIN re-consultar el catálogo.

- **Por qué**: (1) el etiquetado ya es best-effort — si el label se borró entre el pick y el envío, el POST de
  tags igual etiqueta la conversación (Chatwoot crea el tag; solo la ficha de color quedaría huérfana, no rompe
  nada); (2) re-validar en `CreateCampaign` acopla la creación de campaña a la disponibilidad de Chatwoot (una
  caída de Chatwoot bloquearía CREAR campañas — inaceptable, la creación no debe depender de un sistema externo);
  (3) coherente con "el gate/estado se resuelve al send-time, no se congela por campaña" (D8 de chatwoot-hub-sendpath).
- **Descartado** validar contra catálogo en create: agrega una llamada de red bloqueante en el hot-path de
  creación, con beneficio marginal (el pick ya garantiza existencia y el labeling es best-effort de todos modos).

### E. Rollout — **SIN flag propio; feature aditiva opt-in por campaña, montada sobre el flag existente**

**Elegido: nada de flag nuevo.** El label es opcional por campaña — **ausente = comportamiento actual EXACTO**
(cero label, cero side-effect). No hay superficie que apagar globalmente. Además el etiquetado solo tiene efecto
cuando el envío pasó por Chatwoot, o sea que ya está implícitamente gated por el flag
`messaging-send-via-chatwoot` existente: con ese flag OFF, un `chatwootLabel` elegido queda **guardado pero sin
efecto** (no hay conversación Chatwoot) — semántica natural documentada (coherente con D8).

- **Por qué**: agregar un flag para una feature puramente aditiva y opt-in-por-registro sería sobre-ingeniería —
  el criterio del repo reserva flags para FLIPS de comportamiento global (como el propio send-via-chatwoot), no
  para campos opcionales. El "apagado" de esta feature es no elegir label.
- **Tradeoff**: no hay kill-switch global instantáneo. Aceptable: el blast radius es nulo (sin label elegido no
  pasa nada), y el labeling ya es best-effort aislado (una falla no tumba el envío, §C).

### F. Alcance del etiquetado — **NUEVO y EXISTENTE (misma mecánica)**

El label se aplica al `chatwootConversationId` del recipient **independientemente de si la conversación se creó
en esta corrida (CHW-2) o ya existía de antes (CHW-1)**. Un destinatario que ya tenía hilo Chatwoot linkeado
(`chatwootConversationId` previo) recibe el label sobre ESE hilo — mismo `addConversationLabels`, misma
idempotencia. Se declara explícito para que el spec cubra ambos caminos con scenarios.

## 7. Impacted specs / capabilities

- **Capability NUEVA `campaign-chatwoot-label`** — es lo dominante. Requirements nuevos (IDs sugeridos con
  prefijo anti-colisión, el spec-phase los fija): catálogo list (`CLBL-1`), catálogo create ficha completa
  (`CLBL-2`), `addConversationLabels` GET-unión-POST idempotente (`CLBL-3`), enganche best-effort en
  `SendCampaign` post-`sent` (`CLBL-4`), aplicación a hilo existente y nuevo (`CLBL-5`), campo aditivo
  `Campaign.chatwootLabel` + cableo DTO/ruta (`CLBL-6`), permisos dos-tier (`CLBL-7`), semántica flag-OFF /
  sin-conversación = guardado-sin-efecto (`CLBL-8`).
- **`chatwoot-hub-sendpath` (spec main, `openspec/specs/chatwoot-hub-sendpath/spec.md`)** — el enganche cuelga
  del flujo de `SEND-2` (envío por destinatario) y del `chatwootConversationId` de CHW-1/CHW-2, pero es un
  **side-effect aditivo best-effort que NO altera** las garantías de esos requirements (`sent`/`failed`,
  dedup, persistencia siguen idénticos). Recomendación: **NO MODIFIED** — declararlo como capability nueva que
  se ENGANCHA en el punto post-`persistRecipientSent` (como `projectToInbox` se enganchó sin modificar SEND-2).
  El spec-phase confirma; si prefiere una nota MODIFIED liviana sobre SEND-2 ("gana un paso best-effort de
  labeling"), es aceptable pero no imprescindible.
- **NO impacta** `messaging-inbox` (F1, texto plano) ni el feature LOCAL `ConversationLabel`.

## 8. Risks (verificados)

1. **Read-modify-write NO atómico** en `addConversationLabels` — race window si un agente edita labels en el
   instante del envío bulk. Aceptado/documentado (§C). Mitigación: la ventana es mínima y la unión nunca pisa.
2. **Labeling best-effort silencioso** — si el GET-unión-POST falla en la corrida que marcó el recipient `sent`,
   ese recipient queda enviado SIN label y no hay retry. Misma deuda que `projectToInbox` (§C). Mitigación:
   log observable (+ contador opcional).
3. **Catálogo casi vacío hoy (1 label)** — hasta que un admin (o el nuevo flujo "crear") cure más labels, el
   Select es poco útil. Mitigado por el propio scope IN (flujo crear).
4. **Colisión de nombres con `ConversationLabel` LOCAL** — alto riesgo de confusión de producto/código.
   Mitigado por el prefijo `chatwoot` obligatorio en TODA superficie nueva (§1, explore §3).
5. **Consumidor real del label** — si nadie abre la UI de Chatwoot, el valor del label es reporting/automation
   futuro. El usuario ya validó el pedido (decisión 2026-07-22); no bloqueante.
6. **`createAccountLabel` requiere administrator en Chatwoot** — el token `ronald` alcanza; si rotara a uno de
   menor privilegio, el create fallaría 403. Superficie de config, no de este change.

## 9. Artefactos

- `openspec/changes/campaign-chatwoot-label/proposal.md` (este archivo)
- Engram: `topic_key: "sdd/campaign-chatwoot-label/proposal"`, `project: "ipnext-backend"`, `type: architecture`
- Insumos: `sdd/campaign-chatwoot-label/explore`, `sdd/campaign-label-y-task-recipients/decisiones`
