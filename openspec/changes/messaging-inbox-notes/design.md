# Design — messaging-inbox-notes (F1.5 fase D — NOTA PRIVADA) · FRONTEND

> Diseño técnico del FRONTEND para la nota privada. Repos: BE `ipnext-backend`
> (este repo, donde vive `openspec/`), FE `ipnext-frontend`. Depende del
> contrato BE descripto en `explore.md` (el DTO gana `isPrivate: boolean`; el
> `POST .../messages` acepta `private`). Este documento es la fuente de verdad
> del render de la nota y del selector Reply/Nota en el composer.
>
> **Skills aplicadas** (confirmadas en §8): `ui-ux-pro-max` (contraste, focus,
> touch, a11y) + skills de Emil `emil-design-eng` / `animation-vocabulary` /
> `review-animations` (motion).

---

## 0. Principio rector

La nota interna es la MISMA operación de envío que un reply (Chatwoot la modela
como un `create-message` con `private:true`, no un recurso aparte — ver
`explore.md` §Approaches, recomendación Opción 1). El FE reusa el 100% del
pipeline optimista maduro de Tanda 2 (`useSendWhatsappMessage` → `PendingSend`
→ `toOptimisticMessage` → `MessageBubble`) y agrega **un solo booleano
`isPrivate` que viaja INTACTO** desde el selector del composer hasta la burbuja.

La garantía central de F1 (una nota NUNCA llega al cliente) es del BE. El FE
tiene una responsabilidad espejo, igual de crítica: **si `isPrivate` se
"olvida" en cualquier capa del FE (tipo, api, hook, `toOptimisticMessage`,
`MessageBubble`), la nota se renderiza SIN el marcador de "interna"** — el
mismo leak de F1, más sutil (no se cuela, se muestra sin marcar). El flag es
load-bearing en cada salto.

---

## 1. Contrato BE del que depende el FE (resumen)

El FE asume que el BE (fase D backend) entrega:

| Superficie | Forma esperada |
|---|---|
| `ChatMessageDto` | gana `isPrivate: boolean` (siempre presente, `false` por defecto) |
| `GET .../messages` | cada item trae `isPrivate` (todas las notas de la conversación, sin distinguir origen — decisión abierta #1 del explore) |
| `POST .../conversations/:id/messages` | acepta `private` en el body: JSON (`{content, private:true}`) **y** multipart (`form.append('private','true')`) |
| Semántica de envío nota | el guard de ventana 24h (`canReply`) NO aplica; el bump de preview NO ocurre (BE) |
| `direction` de una nota | se persiste como `outbound` + `isPrivate:true` (nota escrita por el agente vía el path de envío) |

Si el BE aún no lo expone, el FE degrada seguro: `message.isPrivate` llega
`undefined` → se trata como `false` → render normal (cero regresión). El FE NO
inventa el flag.

---

## 2. Árbol de componentes

```
WhatsappInboxPage (FB4 — dueño de queryClient/conversationId, sin cambios de estructura)
└─ MessageThread            (+ pasa isPrivate en el merge; dedup considera isPrivate)
│  └─ MessageBubble         (★ NUEVA 3ra variante: .row.note — ni inbound ni outbound)
│     ├─ [label "Nota interna" + IconNote]   ★ nuevo (solo si message.isPrivate)
│     ├─ senderName / content                 (reuso)
│     └─ MediaAttachments                      (reuso — hueco para note-media v2, hoy vacío)
└─ Composer                 (★ selector de modo Reply/Nota + gating bifurcado)
   ├─ ComposeModeToggle     ★ NUEVO — radiogroup segmentado (Respuesta | Nota interna)
   ├─ [notices de ventana]  (SOLO modo Reply)
   ├─ ComposerAttachmentTray / ComposerAttachButton   (OCULTOS en modo Nota — v1 texto)
   ├─ textarea              (placeholder/aria dependen del modo)
   └─ Button "Enviar" | "Agregar nota"   (label depende del modo)
```

Componentes NUEVOS: `ComposeModeToggle` (extraído del Composer, testeable
aislado) + `IconNote` (SVG en `mediaIcons.tsx`, junto a `IconAlert`). Todo lo
demás es extensión de archivos existentes.

---

## 3. Composer — selector Reply / Nota

### 3.1 Semántica del selector — **radiogroup**, no tablist

Decisión: **radiogroup con `<input type="radio">` nativos**, estilados como
segmented control (patrón Chatwoot). NO `role="tab"`/tablist.

**Por qué radiogroup y no tabs**: un tablist revela `tabpanel`s distintos. Acá
hay UN solo composer (el textarea es compartido); lo que cambia es el MODO de
una misma superficie de escritura. "Seleccionar modo mutuamente excluyente" es
exactamente un radiogroup. Beneficios gratis: navegación por flechas ←/→,
`aria-checked` automático, y el lector anuncia "Respuesta, opción 1 de 2,
seleccionada". Sin JS de teclado custom (robusto, menos superficie de bug).

```
<fieldset role="radiogroup" aria-label="Modo de redacción">   (borde sr-only, visual = segmented)
  <label> <input type="radio" name="compose-mode" value="reply"  checked=…/> Respuesta </label>
  <label> <input type="radio" name="compose-mode" value="note"   checked=…/> Nota interna </label>
</fieldset>
```

- Estado: `const [mode, setMode] = useState<'reply' | 'note'>('reply')` en
  `Composer`. Default `'reply'` (cero cambio de comportamiento al abrir).
- Radios nativos visualmente ocultos (`sr-only`), el `<label>` es el segmento
  clickeable — cada segmento **≥44px de alto y de ancho mínimo táctil**
  (`min-height: var(--space-11)`), `cursor: pointer`.
- Indicador de activo: pill deslizante (ver §7 motion).

### 3.2 Bifurcación del gating (el punto delicado del FE)

Hoy un solo booleano gatea todo: `windowDisabled = isDetailLoading || !canReply`
(Composer:103) controla textarea + attach + envío. **En modo Nota la ventana
de 24h es irrelevante** (una nota nunca cruza a WhatsApp/Meta). Bifurcar:

```ts
// Reply: gating actual, INTACTO.
// Nota: la ventana no aplica — el composer se habilita SIEMPRE (aunque
// canReply sea false o el detalle aún cargue: el flag no depende de eso).
const windowDisabled = mode === 'reply' && (isDetailLoading || !canReply);

const canSend =
  !windowDisabled && !hasBlocking &&
  (trimmed.length > 0 || (mode === 'reply' && validFiles.length > 0));
```

- Modo Nota ⇒ `windowDisabled` es `false` ⇒ textarea habilitado, botón
  habilitado con solo texto. `validFiles` no entra (notas v1 = texto).
- Los tres avisos de ventana (`VERIFYING_WINDOW_NOTICE`,
  `VERIFY_WINDOW_ERROR_NOTICE`, `WINDOW_EXPIRED_NOTICE`) se renderizan **solo en
  `mode === 'reply'`** — en modo Nota no tienen sentido (no hay ventana que
  verificar). El aviso `isError`/`mapSendError` (fallo de envío real) SÍ se
  muestra en ambos modos.

Riesgo explícito: NO colapsar los dos gatings en un ternario que invierta la
condición. `canReply` sigue mandando en Reply; en Nota se ignora. Test para las
4 combinaciones `mode × canReply` (ver §10).

### 3.3 Copy dependiente del modo

| Elemento | Modo Reply | Modo Nota |
|---|---|---|
| Placeholder textarea | `Escribí un mensaje…` (o `Agregá un texto…` con drafts) | `Escribí una nota interna…` |
| `<label>` del textarea (sr-only) | `Mensaje` | `Nota interna` |
| Botón de envío | `Enviar` | `Agregar nota` |
| `aria-label` del form | `Responder` | `Agregar nota interna` |

### 3.4 Foco al cambiar de modo

- El contenido del textarea **se preserva** al cambiar de modo (el agente pudo
  tipear y recién ahí decidir que es nota — no perder lo escrito).
- Al cambiar de modo, mover foco al textarea (`textareaRef.current?.focus()`)
  para que pueda seguir escribiendo sin un Tab extra.
- Región `aria-live="polite"` (sr-only) anuncia el cambio: `Modo nota interna`
  / `Modo respuesta`. Así un lector de pantalla confirma el cambio de contexto
  aunque el foco haya saltado.

### 3.5 Adjuntos en nota — FUERA de alcance v1 (hueco dejado)

En modo Nota: `ComposerAttachButton` y `ComposerAttachmentTray` **no se
renderizan** (más limpio que deshabilitarlos). El pipeline de envío ya threadea
`files` — cuando note-media llegue (v2), basta con volver a montar el attach
button en modo Nota; el resto (multipart, `form.append('private')`) ya lo
soporta. Documentado como follow-up (explore §decisión abierta #6).

---

## 4. Render de la nota — variante de `MessageBubble`

### 4.1 Layout — tercera rama, ni inbound ni outbound

Hoy `rowClassName = [row, styles[message.direction], enter]`. La nota IGNORA
`direction`:

```ts
const rowClassName = [
  styles.row,
  message.isPrivate ? styles.note : styles[message.direction],
  isNew ? styles.enter : '',
].filter(Boolean).join(' ');
```

CSS de la variante (full-width, sin alineación izq/der — como Chatwoot):

```css
.row.note {
  justify-content: stretch;          /* ocupa el ancho, no se alinea a un lado */
}
.note .bubble {
  max-width: 100%;                   /* ancho completo del thread */
  width: 100%;
  background-color: var(--color-note-bg);
  color: var(--color-note-fg);
  border-radius: var(--radius-md);   /* sin la "cola" asimétrica del chat */
  border-left: 3px solid var(--color-note-accent);   /* barra de acento */
}
```

La barra de acento izquierda es la firma visual de Chatwoot y el ancho completo
la separa inequívocamente del ida-y-vuelta azul/gris. El `.bubble` reusa
padding/typography existentes.

### 4.2 Tokens nuevos + contraste (verificado, fórmula WCAG 2.1)

`variables.css` NO tiene ningún token warning/amber reusable para "nota"
(`--badge-blocked-*` significa *estado bloqueado*, NO es reusable semánticamente
para una nota — sería una mentira semántica). Se agregan 3 tokens de la rampa
amber (familia coherente, no hex sueltos), bajo un bloque nuevo:

```css
/* Note / internal annotation (messaging-inbox-notes fase D) */
--color-note-bg:     #fef3c7;  /* amber-100 — fondo suave de la nota */
--color-note-fg:     #78350f;  /* amber-900 — texto/label */
--color-note-accent: #b45309;  /* amber-700 — barra de acento izq + ícono */
```

Ratios de contraste (computados con luminancia relativa + `(L1+0.05)/(L2+0.05)`):

| Par | Ratio | Requisito | Estado |
|---|---|---|---|
| texto `#78350f` sobre fondo `#fef3c7` | **8.15:1** | ≥4.5:1 (texto) | ✅ holgado |
| texto `#78350f` sobre `#fef3c7`, burbuja optimista a `opacity:0.85` | **5.61:1** | ≥4.5:1 | ✅ pasa aun atenuada |
| acento/ícono `#b45309` sobre `#fef3c7` | **4.51:1** | ≥3:1 (UI) / ≥4.5:1 (texto) | ✅ pasa como texto |
| barra acento `#b45309` sobre página blanca | **5.02:1** | ≥3:1 (borde UI) | ✅ |
| fondo `#fef3c7` vs página blanca | 1.11:1 | — | ⚠️ el fill SOLO casi no se ve → por eso el label+ícono+barra son obligatorios como indicador (ver §4.3) |

Todo por encima del piso 4.5:1 exigido, incluido el peor caso (burbuja en vuelo
a opacity 0.85, que Tanda 2 usa para "aún no confirmado": **5.61:1**).

**Confusión a evitar (riesgo)**: el `.notice` del composer ("ventana expirada")
YA usa amber (`--badge-blocked-bg/fg`). La nota es amber también. Se distinguen
por: (a) la nota vive en el THREAD, el notice en el COMPOSER; (b) la nota lleva
label "Nota interna" + ícono + barra de acento + ancho completo; (c) tono
distinto (`#fef3c7` nota vs `#ffedd5` notice). Aun así, mantener los tokens
DEDICADOS (no reusar `--badge-blocked-*`) evita que un refactor futuro los
acople.

Nota: el FE es **light-only** (grep confirmó cero `prefers-color-scheme`/
`data-theme` en `src/`) — no se diseñan variantes dark. Si algún día llega dark
mode, estos 3 tokens son el único punto a duplicar.

### 4.3 Label + ícono = indicador NO-color (a11y)

El fill amber solo (1.11:1 vs página) es casi invisible para baja visión y nulo
para daltonismo → **el color no puede ser el único indicador**. La nota lleva un
header dentro del `.bubble`:

```
[IconNote aria-hidden] Nota interna
```

- `IconNote`: SVG inline en `mediaIcons.tsx` (candado o lápiz-en-recuadro),
  `aria-hidden="true"`, color `--color-note-accent`. NO emoji (checklist
  ui-ux-pro-max: iconos como SVG, nunca emoji).
- Label "Nota interna": texto visible, `--color-note-fg`, `font-size-xs`,
  `font-weight-semibold`. Es el nombre accesible que el lector anuncia antes del
  contenido → SR escucha "Nota interna, {senderName}, {content}".
- `senderName` (quién la escribió) y `<time>` se conservan como en la burbuja
  normal, con los colores de la nota.

### 4.4 Hueco para media en nota (v2)

`MessageBubble` YA renderiza `MediaAttachments` bajo
`message.attachments?.length > 0`. En v1 una nota nunca trae attachments, así
que el bloque simplemente no aparece — **cero código nuevo para el hueco**.
Cuando note-media llegue, `MediaAttachments` se reusa 1:1 dentro de la variante
`.note` sin tocar `MessageBubble`.

---

## 5. Envío optimista + threading de `isPrivate`

Un solo booleano cruza 5 capas. Cambios mínimos, aditivos (cero regresión en
call sites de 3 args existentes):

| Capa | Archivo | Cambio |
|---|---|---|
| Tipo mensaje | `types/whatsapp.ts` `WhatsappMessage` | `+ isPrivate?: boolean` (aditivo, como `attachments?`) |
| Tipo pending | `types/whatsapp.ts` `PendingSend` | `+ isPrivate: boolean` |
| API input | `api/whatsapp.api.ts` `SendMessageInput` | `+ private?: boolean` |
| API body | `api/whatsapp.api.ts` `sendWhatsappMessage` | JSON: `{content, private: input.private}`; multipart: `if (input.private) form.append('private','true')` |
| Hook vars | `hooks/useWhatsapp.ts` `SendVars` | `+ isPrivate: boolean`; `send(input)` propaga; `onMutate` guarda `isPrivate` en el `PendingSend`; `mutationFn` pasa `private: vars.isPrivate` a la api; `retry` conserva `pending.isPrivate` |
| Optimista | `MessageThread.tsx` `toOptimisticMessage` | `isPrivate: pending.isPrivate` en el `WhatsappMessage` devuelto → la burbuja optimista se pinta como nota AL INSTANTE |
| Composer | `Composer.tsx` `trySend` | `send({ content, files, drafts, isPrivate: mode === 'note' })` |

**Dedup** (`isLikelyDuplicateOfReal`, `MessageThread.tsx`): hoy matchea por
`direction outbound + content + ventana temporal`. Agregar `isPrivate` a la
clave de match:

```ts
if (m.isPrivate !== pending.isPrivate) return false;   // una nota no dedupea contra un reply del mismo texto
```

Sin esto, una nota y un reply con el mismo texto en la misma ventana colapsarían
a una burbuja (misma deuda heurística que ya existe, pero ahora con dos
variantes visuales — sería visible y confuso).

`onSuccess` ya filtra el pending y appendea el mensaje real; como el real trae
`isPrivate:true` del BE, la burbuja se mantiene como nota en la transición
optimista→real, sin parpadeo de estilo.

---

## 6. Estados / errores / a11y (resumen)

- **Optimista**: la nota sale al thread al instante como burbuja amber
  (`toOptimisticMessage`), reusa el estado `sending` (opacity 0.85 — contraste
  verificado 5.61:1). Sin barra de progreso (nota = solo texto, no hay upload
  con `total`).
- **Error de envío**: reusa el patrón de Tanda 2 — el `PendingSend` pasa a
  `failed`, la burbuja de nota muestra el bloque "No se pudo enviar" +
  Reintentar/Descartar (mismos controles, dentro de la burbuja amber). ⚠️ el
  `.deliveryFailed` de Tanda 2 fija `color:inherit` heredando `--color-white`
  de `.outbound` — dentro de `.note` el texto/botones heredan `--color-note-fg`
  (oscuro) sobre amber: contraste 8.15:1, OK. Verificar que el `outline` de
  foco de esos botones NO herede `--color-white` (invisible sobre amber): en
  `.note` el outline debe ser `--color-note-accent` (`#b45309`, ≥3:1 sobre
  amber-100 y blanco). Ver §10.
- **Focus**: cambio de modo → foco al textarea + `aria-live`. Segmented control
  navegable por flechas (radios nativos). Outline de foco visible en cada
  segmento (`outline: 2px solid var(--color-primary)`).
- **Touch**: segmentos y botón ≥44px (`--space-11`), ya el estándar del
  composer.
- **Screen reader**: la nota se anuncia "Nota interna, {sender}, {content}"; el
  ícono es `aria-hidden`; el modo del composer se anuncia por `aria-live`.

---

## 7. Motion (Emil — `emil-design-eng` / `animation-vocabulary` / `review-animations`)

Regla de frecuencia de Emil (`review-animations/STANDARDS.md` §"Should it
animate?"): el toggle de modo se ve **decenas de veces/día** → motion reducido y
snappy; la aparición de una nota es **ocasional** → animación estándar (reuso).

| Interacción | Término (animation-vocabulary) | Especificación | Justificación Emil |
|---|---|---|---|
| Pill activo del toggle Reply↔Nota | *Slide* / *Layout animation* | `transform: translateX()` del indicador, **150ms** `--wa-ease-out` = `cubic-bezier(0.23,1,0.32,1)` | GPU (solo `transform`); entrando/moviéndose → ease-out; <300ms; frecuente → corto (150ms) |
| Tinte del composer al cambiar de modo | *Crossfade* | `background-color`/`border-color` **150ms** `ease` | color change → `ease` (STANDARDS §Easing); comprensión, se mantiene bajo reduced-motion |
| Aparición de la nota en el thread | *Slide in* + *Fade in* (Enter) | **REUSA** `waBubbleEnter`: `translateY(8px)→0` + opacity, **220ms** `--wa-ease-out`, `both` | Nunca `scale(0)`; entrando → ease-out; <300ms; **reuso = cohesión** (misma personalidad que toda burbuja nueva) |
| Botón "Agregar nota" al presionar | *Press / Tap feedback* | **REUSA** `.sendButton:active { scale(0.97) }`, 150ms ease-out | mismo `<Button>`, feedback de press heredado |

**Detalles Emil aplicados**:
- Solo se anima `transform`/`opacity`/`color` — nada de `width`/`margin`/layout
  (STANDARDS §Performance).
- **Transición, no keyframe**, para el pill (interrumpible si el usuario
  alterna rápido Reply/Nota — retargetea suave en vez de reiniciar desde 0).
- El pill nunca desde `scale(0)`; es un slide horizontal, no un pop.
- Alternativa considerada y descartada: la técnica clip-path de "tabs con
  transición de color perfecta" (emil-design-eng §Tabs) — overkill para un
  toggle de 2 ítems; el slide del indicador + crossfade del tinte alcanza.

**`prefers-reduced-motion: reduce`** (STANDARDS §Accessibility — "menos y más
suave, no cero"; conservar opacity/color, quitar movimiento):
- Pill del toggle: se elimina el `translateX` (el cambio de activo es
  instantáneo o solo por color/opacity); el crossfade de color del tinte SE
  MANTIENE (aporta comprensión, no es movimiento).
- Entrada de la nota: hereda automáticamente `waBubbleEnterReduced` (opacity
  sola, sin `translateY`) que ya existe en `MessageBubble.module.css`.
- Press del botón (`scale`): ya se neutraliza en el media query existente de
  `Composer.module.css`.

Tokens de easing: reusar `--wa-ease-out` ya declarado en ambos módulos (cero
drift). No se introducen curvas nuevas.

---

## 8. Confirmación de skills

**`ui-ux-pro-max`** — ejecutada: `search.py "chat internal note private
annotation composer tab whatsapp" --design-system` + `search.py "internal note
amber warning color accessible annotation"` (dominio color). Aplicado del
checklist de pre-entrega: contraste texto ≥4.5:1 (verificado 8.15:1 / 5.61:1
peor caso, tabla §4.2); iconos como SVG, nunca emoji (`IconNote`);
`cursor-pointer` en segmentos clickeables; focus states visibles (outline en
toggle y botones failed); `prefers-reduced-motion` respetado (§7); touch ≥44px;
responsive (nota full-width y composer ya fluidos). La paleta amber sugerida por
la skill (`#F59E0B`/`#FBBF24`/`#78350F` "energetic amber + booking blue",
`colors.csv`) se adaptó a la rampa Tailwind amber accesible en vez de tomarla
literal (el `#F59E0B` como texto no llega a 4.5:1).

**Emil** — leídas y aplicadas: `emil-design-eng/SKILL.md` (framework de decisión
de animación, easing custom, press feedback, reuso/cohesión, transición vs
keyframe), `animation-vocabulary/SKILL.md` (términos: *Slide in*, *Fade in*,
*Crossfade*, *Layout animation*, *Press/Tap feedback*), `review-animations/
STANDARDS.md` (tablas de frecuencia/duración/easing, reduced-motion). Todas las
decisiones de §7 citan estas fuentes.

---

## 9. Decisiones abiertas / riesgos

Heredadas del explore, resueltas para el FE:
1. **Estilo visual** (explore #4): resuelto → token amber propio dedicado
   (`--color-note-*`), fiel a Chatwoot pero accesible y desacoplado de
   `--badge-blocked-*`.
2. **Adjuntos en nota** (explore #6): fuera de v1; hueco dejado en §3.5/§4.4.
3. **Selector**: resuelto → radiogroup nativo (no tablist), §3.1.

Riesgos FE:
- **`isPrivate` olvidado en una capa** = leak sutil (nota sin marcar). Mitigar
  con test end-to-end del threading (composer→bubble) y del render (§10).
- **Dos gatings con criterio opuesto** en el composer (Nota bypassa `canReply`)
  — no colapsarlos; test de 4 combinaciones.
- **Confusión amber nota vs amber notice** (§4.2) — mitigado por label+ícono+
  ubicación+tokens dedicados.
- **`.deliveryFailed` hereda `--color-white`** del outbound — dentro de `.note`
  debe heredar `--color-note-fg` y el outline de foco usar `--color-note-accent`
  (no blanco, invisible sobre amber). Chequeo explícito en §6.

---

## 10. Superficie de test (para la fase tasks)

- **Composer / gating**: 4 combinaciones `mode ∈ {reply,note}` × `canReply ∈
  {true,false}` — en `note` el textarea/botón quedan habilitados con
  `canReply:false`; en `reply` se mantiene el bloqueo actual. Avisos de ventana
  solo en `reply`.
- **Composer / copy**: placeholder, label sr-only, texto del botón y
  `aria-label` cambian por modo.
- **Toggle a11y**: `role=radiogroup`, `aria-checked` correcto, navegación por
  flechas selecciona modo, foco va al textarea, `aria-live` anuncia el cambio.
- **Threading**: `trySend` en modo Nota manda `isPrivate:true` hasta
  `sendWhatsappMessage` (JSON con `private:true` y multipart con
  `form.append('private','true')`).
- **Render nota**: `message.isPrivate` → `.row.note` (ni inbound ni outbound),
  label "Nota interna" presente, ícono `aria-hidden`, tokens amber aplicados.
- **Contraste** (test estilo `MessageBubble.contrast.test.tsx`): reafirmar
  8.15:1 y el peor caso 5.61:1 (opacity 0.85) con la fórmula WCAG.
- **Optimista**: burbuja de nota aparece como amber al instante; `failed` →
  Reintentar/Descartar dentro de la burbuja amber, con foco/contraste OK.
- **Dedup**: una nota no dedupea contra un reply del mismo texto en la misma
  ventana (`isPrivate` en la clave de match).
- **Reduced-motion**: pill sin `translateX`, nota con fade-only (heredado).
```
