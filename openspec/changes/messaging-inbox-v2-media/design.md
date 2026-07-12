# Design — messaging-inbox-v2-media · F1.5 fase A · **TANDA 1 (RECIBIR)** · FRONTEND (render de media)

> **Alcance de ESTE design**: SOLO el **render** de adjuntos que ya llegan en el thread
> (recibir). El **composer** (enviar media, picker, preview de subida, progreso) es
> **Tanda 2** y NO se diseña acá. Este doc cubre exclusivamente cómo `MessageBubble`
> pasa de texto-puro a texto + `attachments[]`, con sus estados, tokens, animaciones y
> accesibilidad. El BE (modelo, webhook, scheduler, endpoint proxy) lo diseña la fase
> BE de esta misma tanda; acá se consume el contrato del DTO tal cual.
>
> **Repos**: FE `ipnext-frontend`, BE `ipnext-backend`. Los archivos a crear/tocar viven
> TODOS en el FE bajo `src/pages/whatsapp/WhatsappInboxPage/components/` + `src/types/`
> + `src/utils/`. Ningún cambio de BE sale de este design.

---

## 0. Skills de diseño corridas (obligatorio, regla WORKFLOW-MULTI-REPO)

- **ui-ux-pro-max** — corrido:
  `search.py "chat message media attachment image video audio bubble whatsapp thread" --design-system`.
  Del reporte se toman como **reglas duras** (checklist pre-entrega): sin emojis como
  íconos → **SVG** (Heroicons/Lucide-style, mismo criterio que `TaskPhotosGallery`),
  `cursor-pointer` en todo clickable, hover 150–300ms, **contraste texto ≥ 4.5:1**,
  focus visible para teclado, `prefers-reduced-motion` respetado, responsive
  375/768/1024/1440. El "estilo" que sugiere el reporte (Video-First Hero / cinema
  dark) **se descarta**: es un patrón de landing, no aplica a un panel de inbox — acá
  manda el design system YA existente del repo (tokens `variables.css`). Lo que SÍ se
  adopta del reporte es el checklist de accesibilidad/craft.
- **Skills de Emil (leídas y aplicadas)**, en `ipnext-frontend/.agents/skills/`:
  - **emil-design-eng/SKILL.md** — framework de decisión de animación (¿anima?, propósito,
    easing, duración <300ms), "nunca `scale(0)`", `transition` sobre `@keyframes` para UI
    dinámica, "blur para enmascarar crossfades imperfectos" (base del **blur-up** del
    thumbnail), stagger 30–80ms, "solo `transform`/`opacity`" (+ `filter` acotado).
  - **apple-design/SKILL.md** — §1 Response (feedback en pointer-down), §7 spatial
    consistency / origin-aware, §12 materiales (la media card es una "superficie" propia),
    §14 reduced-motion = cross-fade gentil (no cero), §16 craft.
  - **improve-animations/SKILL.md** + **review-animations/STANDARDS.md** — tablas de
    duración/easing citadas *verbatim* abajo (§7); curva fuerte `--wa-ease-out:
    cubic-bezier(0.23, 1, 0.32, 1)` = la que YA usan `MessageBubble`/`MessageThread`.
  - **animation-vocabulary/SKILL.md** — nombres exactos de cada efecto usado: *Blur-up*
    (Blur + Fade in), *Skeleton/Shimmer*, *Scale in*, *Crossfade*, *Stagger*, *Press
    feedback*, *Reveal*. Se citan al lado de cada animación.

---

## 1. Contrato de entrada (lo que el FE consume)

DTO del BE (proposal §Contrato) → **espejo en `src/types/whatsapp.ts`** (mismo criterio
que el resto de `Whatsapp*`, prefijo para no colisionar):

```ts
export interface WhatsappChatMessageAttachment {
  id: string;
  fileType: 'image' | 'audio' | 'video' | 'file';
  contentType: string;              // MIME real (image/jpeg, video/mp4, application/pdf…)
  filename: string | null;
  fileSize: number | null;          // bytes; null si Chatwoot no lo reportó
  width: number | null;             // solo image/video → RESERVA de espacio (§6)
  height: number | null;
  status: 'pending' | 'downloaded' | 'failed';
  url: string;                      // BE-proxy: /api/messaging/attachments/:id/file
  thumbUrl: string | null;          // BE-proxy ...?variant=thumb ; null salvo image
}

// WhatsappMessage gana (aditivo, default [] en el mapper de la api):
//   attachments: WhatsappChatMessageAttachment[];
```

**Reglas de consumo (invariantes que el FE respeta):**
- `url`/`thumbUrl` son **rutas relativas al mismo origen** → `<img src>`/`<video src>`/
  `<audio src>`/`<a href>` las usan **directo** (la cookie de sesión viaja sola, sin
  `Authorization` header, sin fetch manual). Nunca se ve una URL de Chatwoot.
- El FE **NO pega al endpoint mientras `status !== 'downloaded'`**. Usa `status` para
  decidir qué pinta. Setear `<img src>` en `pending` provocaría un **409** inútil por
  cada poll → ese `src` solo se monta cuando `status === 'downloaded'`.
- El **poll del thread ya existe** (`useWhatsappMessages`, THREAD-1, ~5s). El cambio
  `pending → downloaded` llega solo en el próximo `messages` → React re-renderiza →
  el placeholder se reemplaza por la media real. **Cero lógica de sincronización nueva
  en estos componentes** (son 100% presentacionales).

---

## 2. Árbol de componentes (container-presentational)

El "container" que hace data-fetching **ya existe** y NO se toca: `WhatsappInboxPage`
(FB4) llama `useWhatsappMessages` (fetch-on-open + polling). De ahí para abajo, TODO es
presentacional puro. Este design agrega solo hojas presentacionales:

```
WhatsappInboxPage            (container, EXISTE — fetch + polling, sin cambios)
└─ MessageThread             (presentacional, EXISTE — sin cambios de lógica)
   └─ MessageBubble          (presentacional, EXTENDIDO)  ← único archivo existente que se toca
      ├─ {senderName}                         (existe)
      ├─ {content && <span>…</span>}          (existe, ahora CONDICIONAL — §5 bug del span fantasma)
      └─ <MessageAttachments attachments={…}/> (NUEVO, si attachments.length > 0)
         └─ por cada att → <MediaAttachment attachment={att}/>   (NUEVO — router por status/tipo)
            ├─ status 'pending'   → <MediaPlaceholder fileType width height/>   (NUEVO)
            ├─ status 'failed'    → <MediaError fileType/>                       (NUEVO)
            └─ status 'downloaded' → switch(fileType):
               ├─ 'image' → <MediaImage att onOpenLightbox/>   (NUEVO → thumb → lightbox)
               ├─ 'video' → <MediaVideo att/>                  (NUEVO → <video controls>)
               ├─ 'audio' → <MediaAudio att/>                  (NUEVO → <audio controls>)
               └─ 'file'  → <MediaFile att/>                   (NUEVO → card + descarga)

Compartido / reusado:
└─ <ImageLightbox url alt onClose/>   (EXTRAÍDO de TaskPhotosGallery — §4)
```

**Decisión de estructura — `MediaAttachment` como router.** Un único componente decide
por `status` primero (pending/failed son transversales a todos los tipos) y por
`fileType` después. Así cada `Media*` de tipo es una hoja tonta que asume
`status === 'downloaded'` y no repite el manejo de estados. Espeja el patrón `Tile` de
`TaskPhotosGallery` (una hoja por ítem) pero con la dimensión extra de `status` que acá
existe porque la descarga es async (allá es síncrona).

**`MediaAttachments` (plural) — layout de grupo.** Cuando un mensaje trae varios
adjuntos, este contenedor decide el layout (§6.3): stack vertical por defecto; grid 2-col
cuando hay ≥2 imágenes. Es un contenedor de presentación (no fetch), no rompe el patrón.

**Archivos nuevos** (todos junto a los componentes del thread, mismo folder):
`MediaAttachments.tsx` (+ `.module.css`), `MediaAttachment.tsx`, `MediaImage.tsx`,
`MediaVideo.tsx`, `MediaAudio.tsx`, `MediaFile.tsx`, `MediaPlaceholder.tsx`,
`MediaError.tsx`, `mediaIcons.tsx` (SVG inline), `Media.module.css` (compartido por las
hojas — un solo módulo para no fragmentar tokens). `ImageLightbox.tsx` + `.module.css`
(extraído, §4). Util `src/utils/formatFileSize.ts`. Tipo en `src/types/whatsapp.ts`.

> Nota de granularidad: los `.module.css` pueden consolidarse en **un** `Media.module.css`
> compartido por las 6 hojas (menos archivos, tokens en un lugar). `ImageLightbox` sí lleva
> su módulo propio porque es compartido con scheduling.

---

## 3. Diseño por tipo de media + estados

Principio transversal (**apple-design §12 materiales**): **toda** superficie de media es
una **superficie propia** (fondo `--color-surface` / `--color-gray-50`, texto
`--color-text-primary`) **independiente de si la burbuja es inbound o outbound**. Motivo
duro de contraste: el bubble outbound es `--color-primary-hover` (#0b5ed7); poner texto de
filename/tamaño sobre ese azul es un campo minado de contraste (el propio
`MessageBubble.contrast.test.tsx` documenta cuánto cuesta). Al darle a la media su propia
tarjeta clara, el contraste del texto queda controlado (~13:1) en ambas direcciones. Es
además el modelo mental de WhatsApp: la foto/el documento es un "objeto" pegado sobre la
burbuja, no pintado con su color.

### 3.1 `image` — `MediaImage`

- **Downloaded**: `<button>` (para abrir el lightbox — clickable, teclado) que envuelve
  `<img src={thumbUrl ?? url} alt={filename ?? 'Imagen adjunta'} loading="lazy"
  decoding="async">`. `object-fit: cover`. Al click/Enter → abre `<ImageLightbox url={url}
  …>` (la versión GRANDE = `url` original, no el thumb).
  - **Espacio reservado** por `aspect-ratio: {width} / {height}` en el wrapper (§6). Si
    faltan `width`/`height` → fallback `aspect-ratio: 4 / 3`, `max-height: 260px`.
  - **Blur-up** al cargar (§7.1): `filter: blur(8px)` + `opacity: 0` → `blur(0)` +
    `opacity: 1` cuando dispara `onLoad` (attr `data-loaded`). Nombre exacto
    (*animation-vocabulary*): **Blur-up** = *Blur* + *Fade in*.
  - **`onError`** → estado roto local (mismo patrón `broken` de `Tile`): cuadro
    `--color-gray-100` con ícono `IconImageOff` + "No se pudo mostrar". Cubre el edge de
    409-race (el DTO dijo `downloaded` pero el binario aún no está) sin romper el layout.
- **Lightbox**: `ImageLightbox` extraído (§4) — focus-trap + Escape + portal + fallback de
  imagen rota, tal cual `TaskPhotosGallery`.

### 3.2 `video` — `MediaVideo`

- `<video controls preload="metadata" src={url}>` nativo. **Sin poster generado** (no hay
  ffmpeg en fase A, Decisión 4 del proposal) → `poster` solo si algún día hubiera
  `thumbUrl` (hoy es `null` para video). `controls` nativo = accesibilidad de teclado
  gratis (**no** se reinventa el player).
- Espacio reservado por `aspect-ratio: {width}/{height}` (fallback `16/9`), `max-height:
  320px`, `max-width: 100%`. `background: var(--color-black)` (letterbox natural del video).
- **No animación custom** dentro del player (Emil §"¿anima?": un player se ve/opera
  seguido → sin motion decorativo). La entrada la da la burbuja (`.row.enter`, ya existe).

### 3.3 `audio` — `MediaAudio`

- `<audio controls preload="metadata" src={url}>` nativo, `width: 100%` dentro de un
  contenedor de ancho acotado (min 240px, max 320px). Debajo, meta opcional: filename (si
  hay) + tamaño (`formatFileSize`) en `--font-size-xs` / `--color-text-secondary`.
- Alto **fijo** conocido (el control nativo mide ~40–54px) → el contenedor reserva
  `min-height: 54px` (§6) — cero shift entre pending y downloaded.
- Sin animación custom (mismo criterio que video).

### 3.4 `file` — `MediaFile`

Card horizontal (patrón "documento" de WhatsApp), **superficie propia**:
`[ ícono-por-tipo ]  [ filename (2 líneas máx, ellipsis) ]   [ botón descargar ]`
                     `[ TIPO · tamaño ]`

- **Ícono por `contentType`** (SVG, nunca emoji): `application/pdf` → `IconFilePdf`;
  `application/zip`/`x-rar` → `IconFileArchive`; `msword`/`officedocument.wordprocessing`
  → `IconFileDoc`; `spreadsheet`/`excel` → `IconFileSheet`; default → `IconFileGeneric`.
  Mapa chico y honesto (no inventar 20 tipos). Ícono en 40×40, color `--color-text-secondary`.
- **filename**: `--color-text-primary`, `--font-weight-medium`, `word-break` + `-webkit-
  line-clamp: 2`. Fallback si `filename === null`: "Archivo adjunto".
- **meta**: extensión en mayúsculas (derivada de `contentType`/`filename`) + `·` +
  `formatFileSize(fileSize)`; `--font-size-xs`, `--color-text-secondary`. Si `fileSize ===
  null`, se omite el tamaño (no "null bytes").
- **Descargar**: `<a href={url} download>` estilizado como botón-ícono (`IconDownload`),
  `aria-label={"Descargar " + filename}`. El BE ya manda `Content-Disposition` → el
  browser descarga. Press feedback `scale(0.97)` (§7.4). Touch target ≥44px (invisible
  `::before` inset, como `.tileDelete`).
- Card entera clickable NO (evita ambigüedad con el botón); solo el botón descarga.
- Altura **fija** (~72px) → reserva total (§6).

### 3.5 `status === 'pending'` — `MediaPlaceholder` (type-aware)

"Descargando…" mientras el job del BE baja el binario. **Ocupa exactamente la misma caja
reservada** que ocupará la media real (por eso recibe `fileType`, `width`, `height`) → el
reemplazo pending→downloaded es **cero layout shift**.

- Reusa el primitivo **`Skeleton`** (shimmer ya existente, `Skeleton.tsx`) como base.
  Nombre (*animation-vocabulary*): **Skeleton / Shimmer**.
- `image`/`video`: `Skeleton` del tamaño de la caja (aspect-ratio de `width/height`), con
  un `IconDownload`/spinner centrado + texto "Descargando adjunto…" (`--color-text-primary`
  para pasar contraste sobre el gris). `role="status"` `aria-live="polite"`.
- `audio`: barra `Skeleton` `min-height: 54px`.
- `file`: card `Skeleton` altura 72px con ícono genérico tenue.
- Spinner: `transform: rotate` linear (única excepción a "<300ms" — un spinner es *loop*
  constante, `linear`, correcto por STANDARDS §Easing). Bajo reduced-motion → el shimmer
  y el spinner se congelan y queda el texto "Descargando…" (feedback sin movimiento).

### 3.6 `status === 'failed'` — `MediaError`

- Card compacta (misma caja reservada) fondo `--color-danger-bg-hover`, borde
  `--color-danger`, ícono `IconAlert`, texto **"No se pudo cargar el adjunto"**
  (`--color-text-primary`, contraste garantizado) + subtexto opcional del filename.
- **Reintentar**: botón secundario "Reintentar". Semántica honesta — la descarga real la
  reintenta el **scheduler del BE** (proposal Decisión 2) y el poll refleja el cambio;
  el botón del FE solo **fuerza un re-check inmediato** (invalida la query de mensajes /
  re-monta con `key` para volver a leer `status`). Se documenta en el componente que NO
  re-dispara la descarga en el BE — evita prometer algo que el FE no puede cumplir.
  `role="alert"` para que el lector lo anuncie.

---

## 4. Lightbox — reuso del patrón de task-photos (decisión + tradeoff)

El lightbox a reusar hoy vive **embebido y NO exportado** dentro de
`TaskPhotosGallery.tsx` (`function Lightbox`, **líneas 52–144**) con su CSS en
`TaskPhotosGallery.module.css` (`.lightboxOverlay/.lightboxImage/.lightboxBroken/
.lightboxClose`, **líneas 225–301**). Tiene ya: `createPortal` a `document.body`, `role=
"dialog"` + `aria-modal`, **focus-trap** con `Tab`/`Shift+Tab`, cierre por **Escape** y por
click en overlay, `onError` → fallback "No se pudo cargar la imagen", y **restauración de
foco al opener** al cerrar (`handleCloseLightbox` guarda `opener` y lo re-enfoca).

**Decisión: EXTRAER a un componente compartido** `src/components/media/ImageLightbox.tsx`
(+ `ImageLightbox.module.css`), consumido por AMBOS: `TaskPhotosGallery` y el nuevo
`MediaImage`. API mínima: `{ url: string; alt: string; onClose: () => void }` (idéntica a
la actual). El manejo de `opener`/restauración de foco se queda en el consumidor (como hoy
en `TaskPhotosGallery`), o se sube al componente — a definir en tasks; recomendado dejarlo
en el consumidor para no cambiar el contrato actual.

**Tradeoff (para el arquitecto):**
| Opción | Pro | Contra |
|---|---|---|
| **Extraer a `components/media/ImageLightbox`** (recomendado) | DRY real, un solo focus-trap testeado, la mejora de uno beneficia al otro | toca `TaskPhotosGallery` (prod, F1.5-B) → sus tests deben seguir verdes; blast radius chico pero no cero |
| Clonar dentro de `whatsapp/components` | cero blast radius sobre scheduling | duplica focus-trap/portal/fallback → dos copias que divergen |

Recomendación: **extraer** — el repo valora reuso (CLAUDE.md, DIP), y el lightbox es
exactamente el tipo de primitivo que no debe existir dos veces. Si el arquitecto prioriza
blast-radius-cero sobre DRY, el fallback es clonar (el design soporta ambas; `MediaImage`
consume la misma API en cualquier caso).

**Animación del lightbox** (§7.3): reusa `overlayIn` (fade 180ms ease-out, ya en el CSS) +
se le agrega **scale-in** de la imagen desde `scale(0.96)` (nunca `scale(0)` — Emil). Es un
**modal** → `transform-origin: center` (correcto por STANDARDS §Physicality: "modals are
exempt"). Reduced-motion: `animation: none` (ya contemplado, línea 296–300 del CSS).

---

## 5. `MessageBubble` extendido — cambios puntuales

1. **Texto condicional (bug del `<span>` fantasma, ya anotado por el review adversarial de
   F1)**: hoy renderiza `<span>{message.content}</span>` siempre. Con adjuntos, un mensaje
   solo-media trae `content === ''` → NO pintar un `<span></span>` vacío (deja un hueco y
   un nodo de texto fantasma). Regla: `{content.trim() !== '' && <span>{content}</span>}`.
2. **Render de adjuntos**: debajo del texto (o en lugar de él), si
   `message.attachments?.length`, renderizar `<MessageAttachments attachments={…}
   direction={message.direction}/>`. `direction` se pasa solo por si el layout del grupo
   quiere alinearse (las superficies de media NO cambian de color por dirección, §3).
3. **`time`** (hora) queda **debajo** de la media, igual que hoy. En mensaje solo-media, la
   hora se ancla abajo-derecha sobre la última media (patrón WhatsApp) — a resolver en CSS
   sin romper el caso solo-texto.
4. El bubble **conserva su animación de entrada** (`.row.enter`, translateY(8px)→0 220ms,
   ya existe). La media NO agrega su propia entrada de burbuja — hereda la del row. Lo único
   que anima adentro es el **blur-up del thumbnail** cuando la imagen carga (§7.1).

`max-width: 70%` del bubble se mantiene; la media se acota a ese ancho (`max-width: 100%`
dentro del bubble; imágenes/videos con su `max-height` propio).

---

## 6. Anti-layout-shift (reserva de espacio) — el punto crítico

**Objetivo: CLS = 0.** El espacio de cada adjunto se **reserva antes** de que el binario
cargue, para que el paso `pending → downloaded` y el `onLoad` de la imagen **no muevan
nada**.

### 6.1 Imágenes/videos con dimensiones
El DTO trae `width`/`height` (Chatwoot los reporta). Se aplican como **`aspect-ratio`** al
wrapper, con un ancho acotado — el alto sale solo de la relación, sin JS, sin medir:

```css
.mediaImage {           /* wrapper — MISMA caja en pending, downloaded y error */
  aspect-ratio: var(--media-ar, 4 / 3);   /* --media-ar = `${width} / ${height}` inline */
  max-width: min(100%, 240px);            /* single; en grid ver §6.3 */
  overflow: hidden;
  border-radius: var(--radius-md);
}
.mediaImage img { width: 100%; height: 100%; object-fit: cover; }
```

El `aspect-ratio` se setea inline: `style={{ '--media-ar': `${width} / ${height}` }}`
cuando ambos existen; si no, el fallback del token (`4 / 3` imagen, `16 / 9` video). Como
`MediaPlaceholder` recibe los mismos `width`/`height`, **la caja del skeleton es idéntica a
la de la imagen** → reemplazo sin salto.

### 6.2 Audio / file (alto fijo conocido)
No tienen dimensiones de imagen; su alto es determinístico: audio `min-height: 54px`, file
`~72px`. El placeholder usa el mismo `min-height` → cero shift.

### 6.3 Múltiples adjuntos — layout de grupo (`MediaAttachments`)
- **1 adjunto**: como §6.1/§6.2 (single, `max-width` 240–320px).
- **≥2 imágenes**: **grid** 2 columnas (`grid-template-columns: repeat(2, 1fr)`, `gap:
  var(--space-1)`), cada tile forzado a `aspect-ratio: 1/1` (`object-fit: cover`) — estilo
  álbum de WhatsApp. Alto del grid = determinístico por nº de filas → reservado.
- **mixto** (imágenes + file/audio/video): stack vertical (`flex-direction: column`,
  `gap: var(--space-2)`), cada uno con su reserva propia.
- Tope pragmático: si hay > 4 imágenes, mostrar 4 + overlay "+N" sobre la 4ª (abre el
  lightbox en esa imagen). Evita bubbles gigantes; opcional para tasks (no bloqueante).

---

## 7. Animaciones (Emil) — con duración, easing y skill de origen

Token de curva (reusar el YA declarado en `MessageBubble`/`MessageThread`):
`--wa-ease-out: cubic-bezier(0.23, 1, 0.32, 1)` (STANDARDS §Easing "strong ease-out for
UI"). Todo lo de abajo anima **solo `transform`/`opacity`/`filter`** (STANDARDS
§Performance) y queda **<300ms** (STANDARDS §Duration).

### 7.1 Blur-up del thumbnail al cargar — la aparición principal
- **Qué**: cuando el `<img>` termina de cargar, pasa de `blur(8px)+opacity:0` a
  `blur(0)+opacity:1`. El espacio ya estaba reservado (§6) → **no hay shift**, solo la
  imagen "materializa".
- **Skill**: emil-design-eng §"Use blur to mask imperfect transitions" ("blur bridges the
  visual gap… tricking the eye into perceiving a single smooth transformation"). Vocabulario
  (*animation-vocabulary*): **Blur-up** = *Blur* + *Fade in*.
- **Cómo**: `transition: opacity 260ms var(--wa-ease-out), filter 260ms var(--wa-ease-out);`
  disparado por `data-loaded="true"` seteado en `onLoad`. `will-change: opacity, filter`
  mientras carga; se limpia al terminar.
- **Duración/easing**: **260ms** (entra → ease-out; STANDARDS "modals/media" ≤300ms).
- **Reduced-motion**: se **dropea el blur** (filter es "movimiento" visual), queda un
  `opacity` fade **200ms ease** — "fewer and gentler, not zero" (apple §14 / STANDARDS §A11y).
  `.mediaImage img { filter: none; transition: opacity 200ms ease; }` en el media-query.

### 7.2 Stagger de adjuntos que llegan juntos
- **Qué**: si un mensaje trae varios adjuntos, sus blur-ups NO disparan todos a la vez —
  cascada de **40ms** entre ítems (mismo `STAGGER_MS = 40` que ya usa `MessageBubble` para
  las burbujas nuevas). Skill: emil §Stagger (30–80ms). Vocabulario: **Stagger**.
- **Cómo**: `animation-delay`/`transition-delay: calc(var(--i) * 40ms)` con `--i` = índice
  dentro del grupo. Es decorativo → nunca bloquea interacción (STANDARDS §Stagger).
- **Reduced-motion**: delay = 0 (evita el bug ya documentado en `MessageBubble` donde el
  delay bajo `fill:both` deja ítems invisibles ~800ms).

### 7.3 Lightbox open/close
- **Qué**: overlay *Fade in* (`overlayIn`, **180ms ease-out**, YA en el CSS) + imagen
  *Scale in* desde `scale(0.96)` → `1` (nunca `scale(0)`; Emil). Modal → `transform-origin:
  center` (STANDARDS: modales exentos de origin-aware).
- **Skill**: emil §"Never animate from scale(0)"; apple §7 (spatial). Vocabulario:
  **Scale in** + **Fade in**.
- **Duración/easing**: overlay 180ms, imagen 200ms, ambos `var(--wa-ease-out)` (entrada).
- **Close**: fade-out más corto (~140ms) — asimetría "enter suave / exit snappy"
  (emil §"Asymmetric enter/exit timing"). Reduced-motion: `animation: none` (ya en CSS
  línea 296).

### 7.4 Hover / press en media clickable
- **Hover** (solo image tile y botón descargar): reusa el patrón `.tileOpen:hover` de
  task-photos → `translateY(-1px)` + `box-shadow: var(--shadow-md)` + `border-color`,
  `transition: 180ms ease`. **Gate `@media (hover: hover) and (pointer: fine)`** para que
  el tap en touch NO dispare un falso hover (STANDARDS §A11y; ui-ux-pro-max checklist).
  Vocabulario: **Hover effect**.
- **Press** (botón descargar, tile de imagen): `:active { transform: scale(0.97) }`,
  `transition: transform 120ms var(--wa-ease-out)` — feedback en pointer-down (apple §1;
  emil §"Buttons must feel responsive"). Vocabulario: **Press / Tap feedback**.

### 7.5 Crossfade pending→downloaded (opcional, polish)
- Como el skeleton y la imagen ocupan la MISMA caja, el swap puede ser un *Crossfade* de
  160ms (el skeleton hace fade-out mientras el blur-up entra). Riesgo de "dos estados
  visibles" → el **blur** del blur-up ya lo enmascara (emil §blur). Es LOW/polish; si
  complica, basta con que la imagen entre por blur-up y el skeleton desaparezca (el ojo no
  lo nota porque el blur cubre el corte). Feel-check en slow-motion antes de dar por bueno.

**Tabla resumen de motion:**

| Efecto | Elemento | Dur. | Easing | Props | Skill | Reduced-motion |
|---|---|---|---|---|---|---|
| Blur-up | `MediaImage img` onLoad | 260ms | `--wa-ease-out` | opacity, filter | emil (blur) | solo opacity 200ms, sin blur |
| Stagger | adjuntos del mismo msg | +40ms/ítem | — | delay | emil (stagger) | delay 0 |
| Overlay in | lightbox | 180ms | ease-out | opacity | emil/apple | none |
| Scale in | lightbox img | 200ms | `--wa-ease-out` | transform, opacity | emil | none |
| Close | lightbox | 140ms | ease-out | opacity | emil (asimétrico) | none |
| Hover | tile / botón | 180ms | ease | transform, box-shadow | STANDARDS | gated `hover:hover` |
| Press | botón / tile | 120ms | `--wa-ease-out` | transform | apple §1 | (transform mínimo, se mantiene) |
| Shimmer/spinner | placeholder | loop | linear | transform/bg | vocab (skeleton) | congelado + texto |

---

## 8. Design system aplicado (tokens `variables.css`, cero hex nuevo)

| Uso | Token |
|---|---|
| Superficie de media (card/tile) | `--color-surface` / `--color-gray-50` |
| Borde de tile/card | `--color-gray-200` (`--color-primary` en hover) |
| Texto principal (filename, "Descargando…", labels) | `--color-text-primary` (contraste ≥ 4.5:1 garantizado) |
| Meta secundaria (tamaño, extensión) | `--color-text-secondary` (solo texto NO esencial) |
| Skeleton | primitivo `Skeleton` (shimmer existente) |
| Error card | fondo `--color-danger-bg-hover`, borde/ícono `--color-danger` |
| Radios | tile/card `--radius-md`, imagen grande `--radius-lg` |
| Spacing | grid gap `--space-1`, stack gap `--space-2`, padding card `--space-2/3` |
| Íconos | SVG inline (mismo estilo `stroke=currentColor` que `TaskPhotosGallery`), 40×40 file, 15–18 acciones |
| Curva motion | `--wa-ease-out` (ya declarado local) |
| Sombra hover | `--shadow-md` |
| Touch target | ≥ `--space-11` (44px) en todo botón/link; invisible `::before` inset donde el visible sea menor |

**Sin `--color-primary-hover` como fondo de texto** en media (lección del contrast test) —
la media vive en superficie clara propia. Tipografía: filename `--font-size-sm`
`--font-weight-medium`; meta `--font-size-xs`; `line-height-normal`. (apple §15: peso >
tamaño para jerarquía; acá alcanza con weight-medium en el filename.)

---

## 9. Accesibilidad (ui-ux-pro-max checklist + apple §14)

- **`alt` en toda imagen**: `alt={filename ?? 'Imagen adjunta'}`. Lightbox: `aria-label=
  "Vista ampliada de {alt}"` (reusa el del componente extraído).
- **`<video controls>` / `<audio controls>`**: controles nativos → teclado y lectores
  gratis; no se reimplementa el player. `preload="metadata"` (no descarga el binario entero
  hasta que el usuario da play — respeta datos móviles).
- **Lightbox**: `role="dialog"` `aria-modal="true"`, **focus-trap** (Tab/Shift+Tab),
  **Escape** cierra, foco vuelve al opener al cerrar (todo ya resuelto en el patrón extraído).
- **Estados anunciados**: placeholder `role="status"` `aria-live="polite"` ("Descargando
  adjunto…"); error `role="alert"` ("No se pudo cargar el adjunto").
- **Botones/links**: `aria-label` descriptivo ("Descargar {filename}", "Ver {filename} en
  grande", "Reintentar cargar {filename}"). `cursor: pointer`, focus-visible con
  `outline: 2px solid` (mismo patrón del repo).
- **Contraste ≥ 4.5:1**: todo el texto informativo en `--color-text-primary` sobre
  superficie clara; el secundario solo para meta prescindible. Verificable con el mismo
  criterio que `MessageBubble.contrast.test.tsx`.
- **Reduced-motion**: blur-up → opacity; stagger delay 0; lightbox sin animación; shimmer
  congelado con texto. Nunca "cero feedback" (apple §14: gentler, not none).
- **Touch 44px**, hover gated `@media (hover: hover) and (pointer: fine)`.

---

## 10. Formato de tamaño — `src/utils/formatFileSize.ts` (nuevo, no existe)

No hay util de bytes→humano en el repo (`src/utils/` verificado: no hay `formatFileSize`/
`formatBytes`). Se agrega uno chico y testeable:

```ts
// bytes → "820 B" | "12.3 KB" | "4.1 MB". Base 1024, 1 decimal desde KB.
// null/NaN/negativo → null (el consumidor omite el tamaño, no muestra "null").
export function formatFileSize(bytes: number | null): string | null { … }
```

Consumido por `MediaFile` y `MediaAudio`. Unit test propio (TDD, red→green).

---

## 11. Testing (TDD — red → green → refactor)

Espeja `TaskPhotosGallery.test.tsx` / `MessageBubble.test.tsx` (Vitest + Testing Library,
adapters/props in-memory, sin red). Casos mínimos:
- `MediaAttachment` **enruta** por status (pending→placeholder, failed→error,
  downloaded→tipo correcto) y por `fileType`.
- `MediaImage`: `alt` presente, click abre lightbox, `onError`→estado roto, `src` = thumb.
- **`src` NO se monta si `status !== 'downloaded'`** (no pega al endpoint en pending) —
  test de regresión del 409.
- `MediaFile`: ícono por `contentType`, filename fallback, `formatFileSize`, `href`+`download`.
- `MediaPlaceholder`: reserva la caja (aspect-ratio de width/height) — cero-shift.
- `MessageBubble`: mensaje solo-media NO pinta `<span>` vacío; texto+media renderiza ambos.
- `formatFileSize`: bordes (0, null, <1KB, límites KB/MB, negativo).
- `ImageLightbox` (extraído): focus-trap, Escape, restauración de foco, fallback — los
  tests actuales de `TaskPhotosGallery` deben seguir verdes tras la extracción.
- Contraste: reafirmar ≥4.5:1 de los labels sobre superficie de media.

---

## 12. Riesgos / bordes (FE)

- **409-race** (DTO `downloaded` pero binario aún ausente): `<img onError>` → estado roto
  local; el próximo poll re-renderiza. No rompe layout (caja reservada). Cubierto.
- **`width`/`height` ausentes** en alguna imagen: fallback `aspect-ratio 4/3` → puede haber
  un shift MENOR si la relación real difiere mucho. Aceptable (mayoría de imágenes de
  Chatwoot traen dims); documentado, no bloqueante.
- **Extracción del lightbox toca `TaskPhotosGallery`** (prod): mitigado por sus tests +
  API idéntica. Si el arquitecto lo prohíbe → clonar (§4).
- **Grid de muchas imágenes**: tope "+N" opcional para no romper el ancho del bubble.
- **`preload="metadata"`** en video/audio evita bajar binarios pesados sin play — importante
  en el contexto ISP (agentes con datos móviles).

---

## 13. Checklist de cierre (todo verde antes de tasks)

- [x] ui-ux-pro-max corrido (`--design-system`) — checklist a11y/craft adoptado.
- [x] emil-design-eng / apple-design / improve-animations / review-animations /
      animation-vocabulary leídas y aplicadas (cada animación cita su skill + duración +
      easing en §7).
- [x] Container-presentational: fetch en el container existente; hojas 100% presentacionales.
- [x] Anti-layout-shift por `aspect-ratio` (width/height del DTO) + placeholder mismo tamaño.
- [x] Lightbox reusado (extracción de `TaskPhotosGallery` L52–144 / CSS L225–301).
- [x] Íconos SVG (nunca emoji), contraste ≥4.5:1, touch 44px, focus, `alt`, reduced-motion.
- [x] Motion solo `transform`/`opacity`/`filter`, <300ms, curva `--wa-ease-out`.
- [x] Cero hex nuevo (todo con tokens `variables.css`).
- [x] Sin tocar el composer (Tanda 2) ni el BE.
```
