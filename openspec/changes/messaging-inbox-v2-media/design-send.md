# Design — messaging-inbox-v2-media · F1.5 fase A · **TANDA 2: ENVIAR MEDIA** · **FRONTEND**

> Alcance de ESTE design: **SOLO el FRONTEND del ENVÍO** de media — el composer con
> adjuntar (file picker + preview), la validación client-side, el hook de envío
> `multipart` con optimistic UI + progreso, y el render optimista del mensaje saliente.
> El BE (multer + gateway multipart + espejo MinIO + self-heal) está en `proposal-send.md`
> y su `spec-send.md` — acá NO se re-diseña; solo se consume su contrato.
>
> **RECIBIR media = Tanda 1 (YA en prod/repo).** Esta tanda **reusa sus componentes de
> render** (`MediaAttachment` y sus hojas, `mediaIcons`, `formatFileSize`, `MediaAttachments`,
> `MessageBubble`, `ImageLightbox`) SIN reescribirlos, y **extiende** el composer, el hook
> `useSendWhatsappMessage` y `whatsapp.api.ts`.
>
> Stamps de contexto: FE commit `93088a24`, BE commit `93088a24`-equiv (rama `main`).
> Skills corridas (obligatorio, regla WORKFLOW-MULTI-REPO):
> - ✅ **ui-ux-pro-max** — `search.py "chat composer file upload attachment preview send whatsapp" --design-system` + checklist pre-delivery (ver §7). Aplicados: SVG-no-emoji, cursor-pointer, hover 150-300ms, contraste ≥4.5:1, focus visible, `prefers-reduced-motion`, responsive 375/768/1024/1440, touch ≥44px.
> - ✅ **Emil (Kowalski) skills** leídas y aplicadas: `emil-design-eng/SKILL.md` (framework de decisión de animación, easings custom, `:active scale(0.97)`, never `scale(0)`, transiciones sobre keyframes para UI dinámica, blur-mask, asymmetric enter/exit, stagger, solo `transform`/`opacity`), `animation-vocabulary/SKILL.md` (nombro cada efecto: *Scale in*, *Stagger*, *Spatial consistency*, *Shake/Wiggle*, etc.), `improve-animations/SKILL.md` (posture de auditor: severidad por frecuencia, reduced-motion = tonar, no matar).

---

## 1. Qué se reusa (Tanda 1) vs. qué es nuevo

| Pieza Tanda 1 (repo, NO se toca) | Cómo la usa el ENVÍO |
|---|---|
| `MediaAttachment.tsx` (+ `MediaImage`/`MediaVideo`/`MediaAudio`/`MediaFile`) | Render del **outbound optimista**: el draft local se mapea a un `WhatsappChatMessageAttachment` con `status:'downloaded'` + `url = objectURL` → cada hoja pinta el binario local sin cambios. |
| `MediaAttachments.tsx` + `.module.css` | Layout de grupo (stack / grid álbum) de los adjuntos del mensaje saliente — idéntico al inbound. |
| `MessageBubble.tsx` | Burbuja outbound; se **extiende aditivamente** con `deliveryStatus`/`uploadProgress`/`onRetry`/`onDiscard` (todo opcional → cero regresión inbound). |
| `mediaIcons.tsx` (`FileTypeIcon`, `IconDownload`, SVG inline) | Ícono por `contentType` en el preview del composer y en `MediaFile`. **Sirve el `IconAlert` para el estado de error por archivo.** |
| `formatFileSize.ts` | Tamaño legible en cada chip del preview. |
| `Media.module.css` (blur-up `--i` stagger, spinner, tokens) | El blur-up de `MediaImage` corre igual sobre el objectURL local. |
| `ImageLightbox` | Ya lo abre `MediaImage` — el preview del composer NO abre lightbox (es edición, no consumo). |
| `mapUploadError.ts` (util task-photos) | **Molde** del mapper de errores; se agrega un `mapSendError` hermano (§6.4) con los códigos del envío (413/415/422/503/400). |
| `TaskPhotosGallery.tsx` + `taskAttachments.api.ts` | **Molde probado** del file-picker (input hidden + botón + reset `value`), del `FormData` multipart y del `onChange` handler. |

**Nuevo (5 archivos + 3 extensiones):**

```
NUEVOS
  src/pages/whatsapp/WhatsappInboxPage/components/ComposerAttachButton.tsx     (+ test)
  src/pages/whatsapp/WhatsappInboxPage/components/ComposerAttachmentTray.tsx   (+ test)
  src/pages/whatsapp/WhatsappInboxPage/components/AttachmentPreviewItem.tsx    (+ test)
  src/pages/whatsapp/WhatsappInboxPage/components/Composer.attachments.module.css
  src/hooks/useComposerAttachments.ts         (estado local de drafts + ciclo objectURL)  (+ test)
  src/utils/mapSendError.ts                                                     (+ test)
  src/utils/validateAttachment.ts   (espejo FE de fileType + MAX_BYTES_BY_FILE_TYPE)  (+ test)

EXTENDIDOS
  src/api/whatsapp.api.ts            (sendWhatsappMessage: FormData + onUploadProgress)
  src/hooks/useWhatsapp.ts           (useSendWhatsappMessage: FormData + optimistic pending slice
                                      + usePendingSends + retry/discard)
  src/pages/whatsapp/WhatsappInboxPage/components/Composer.tsx  (tray + attach + submit media)
  src/pages/whatsapp/WhatsappInboxPage/components/MessageBubble.tsx  (deliveryStatus/progress/retry)
  src/pages/whatsapp/WhatsappInboxPage/components/MessageThread.tsx  (merge server + pending)
  src/types/whatsapp.ts              (DraftAttachment, PendingSend, deliveryStatus)
```

---

## 2. Árbol de componentes

```
WhatsappInboxPage                      (dueña de conversationId + queryClient; ya threadea onRetryAttachment)
│
├─ MessageThread                       (EXT: merge server-messages + pending-sends)
│   ├─ MessageBubble (server, inbound/outbound)          ← Tanda 1 sin cambio funcional
│   └─ MessageBubble (OPTIMISTA, deliveryStatus)         ← EXT aditiva
│        ├─ MediaAttachments → MediaAttachment → MediaImage/Video/Audio/File   ← REUSO puro
│        └─ <DeliveryOverlay>  (progress bar / "Reintentar" / "Descartar")     ← nuevo, dentro de la burbuja
│
└─ Composer                            (EXT: dueño del textarea + tray + attach + mutation)
    ├─ [banners: verificando / ventana expirada / error de envío]   ← ya existen
    ├─ ComposerAttachmentTray          (NUEVO — visible solo si hay drafts)
    │    └─ AttachmentPreviewItem ×N   (NUEVO — thumbnail|icono + nombre + tamaño + quitar + estado)
    └─ .row
        ├─ ComposerAttachButton        (NUEVO — botón clip + <input type=file multiple accept> hidden)
        ├─ <textarea>                  (ya existe — ahora "caption", opcional si hay files)
        └─ <Button "Enviar">           (ya existe — habilitado si content.trim() O files válidos)
```

**Container/presentational (convención del repo):**
- `Composer` = container liviano: posee estado (content + drafts via `useComposerAttachments`), la mutation, la lógica `disabled`/`canSend`. NO fetch de red directo (pasa por el hook).
- `ComposerAttachButton`, `ComposerAttachmentTray`, `AttachmentPreviewItem` = **presentacionales puros** (props in, callbacks out) → triangulables sin red ni queryClient.
- `useComposerAttachments` = hook de **estado local** (no react-query): agrega/quita/valida drafts y **es dueño del ciclo de vida de los `objectURL`** (crea al agregar, `revokeObjectURL` al quitar y al desmontar). Aísla el efecto-sucio (createObjectURL) del componente → testeable y sin leaks.

---

## 3. Tipos nuevos (`src/types/whatsapp.ts`)

```ts
// ── Draft local del composer (FE-only, nunca viaja al wire tal cual) ──────────
export interface DraftAttachment {
  /** clave estable local (crypto.randomUUID(); fallback contador si no existe). */
  id: string;
  file: File;
  /** derivado del mimetype, ESPEJO del BE (image|video|audio|file). */
  fileType: WhatsappChatMessageAttachment['fileType'];
  /** objectURL para image/video (preview inline); null para audio/file (chip icono). */
  previewUrl: string | null;
  /** validación client-side ANTES de subir (§6.2). null = válido. */
  error: null | { code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE'; message: string };
}

// ── Envío optimista en vuelo (FE-only, vive en un slice de cache no polleado) ──
export interface PendingSend {
  /** id temporal del mensaje optimista (`optimistic:{uuid}`). */
  tempId: string;
  content: string;
  drafts: DraftAttachment[];   // conserva los File para reintentar (Decisión 3 del proposal)
  progress: number;            // 0..1 (onUploadProgress de axios)
  status: 'sending' | 'failed';
  createdAt: string;           // ISO — orden estable en el merge del thread
}
```

`WhatsappMessage` **no** cambia de forma (el 201 sigue siendo un `WhatsappMessage` con `attachments`).
El estado de entrega es del `PendingSend`, no del `WhatsappMessage` real — se pasa a `MessageBubble` como props, no se contamina el DTO del server.

---

## 4. Composer extendido

### 4.1 Estado y reglas

```ts
const { drafts, add, remove, clear, hasBlocking } = useComposerAttachments();
const [content, setContent] = useState('');
const { mutate, retry, discard } = useSendWhatsappMessage(conversationId);

const trimmed = content.trim();
const validFiles = drafts.filter(d => d.error === null).map(d => d.file);

// disabled de red/ventana (igual que hoy) + guarda de contenido nueva:
const windowDisabled = isDetailLoading || !canReply;   // (mutation.isPending YA no bloquea todo — ver abajo)
const canSend =
  !windowDisabled &&
  !hasBlocking &&                        // ningún draft con error de validación
  (trimmed.length > 0 || validFiles.length > 0);   // "al menos uno" (proposal Decisión 4/F)
```

**Cambio clave vs. hoy — el composer NO se bloquea durante la subida.** Con optimistic UI el
mensaje sale al thread al instante y el composer **se limpia y queda listo para el siguiente**
(patrón WhatsApp). Por eso `mutation.isPending` **ya no** entra en `disabled` global; el spinner
de "enviando" vive en la **burbuja optimista**, no en el botón. (Regresión-guard: el envío de
texto conserva su comportamiento; solo cambia que no se congela el input mientras sube.)

### 4.2 `trySend`

```ts
function trySend() {
  if (!canSend) return;
  mutate(
    { content: trimmed, files: validFiles },
    { onSuccess: () => { setContent(''); clear(); } }   // limpia SOLO al 201; en error los drafts viven en el pending (retry desde la burbuja)
  );
}
```

- **Enter-to-send** (Bug #11, ya existe) se conserva: Enter envía, Shift+Enter salto de línea.
  Matiz nuevo: si el textarea está vacío pero hay files válidos, Enter **igual** envía (media-sola).
- El banner de error de envío (`mutation.isError` → `resolveErrorMessage`) se conserva para el
  camino texto-solo; para media el error se muestra **en la burbuja optimista** (§5.3) porque ahí
  quedó la media para reintentar. (Se puede unificar: si el último error fue de un send con files,
  no duplicar el banner — el thread ya lo muestra. Ver §11 Decisión FE-2.)

### 4.3 Estructura JSX (delta sobre el actual)

```tsx
<form className={styles.composer} onSubmit={handleSubmit} aria-label="Responder">
  {/* banners existentes (verificando / ventana / error) … */}

  {drafts.length > 0 && (
    <ComposerAttachmentTray drafts={drafts} onRemove={remove} />
  )}

  <div className={styles.row}>
    <ComposerAttachButton
      onFiles={add}                         // add(files: File[]) → useComposerAttachments valida + crea objectURLs
      disabled={windowDisabled}
      count={drafts.length}
      max={MAX_FILES}
    />
    <label className={styles.srOnly} htmlFor="whatsapp-composer-input">Mensaje</label>
    <textarea id="whatsapp-composer-input" … placeholder={drafts.length ? 'Agregá un texto…' : 'Escribí un mensaje…'} disabled={windowDisabled} />
    <Button type="submit" variant="primary" disabled={!canSend} aria-label="Enviar mensaje">Enviar</Button>
  </div>
</form>
```

---

## 5. Sub-componentes

### 5.1 `ComposerAttachButton`

Botón "clip" (paperclip SVG inline, `stroke=currentColor`, nunca emoji) que dispara un `<input
type="file" multiple accept>` **oculto** (molde `TaskPhotosGallery`). Props:
`{ onFiles(files: File[]): void; disabled?: boolean; count: number; max: number }`.

- Ícono nuevo `IconPaperclip` → se agrega a `mediaIcons.tsx` (mismo estilo que los demás).
- Handler: `Array.from(e.target.files ?? [])` → `e.target.value = ''` (re-permite re-elegir el mismo archivo) → `onFiles(files)`.
- Si `count >= max`, el botón NO se deshabilita duro; `useComposerAttachments.add` recorta al tope
  y emite un draft-error/feedback "máximo N archivos" (no perder el resto silenciosamente).
- **A11y**: `type="button"`, `aria-label="Adjuntar archivos"`; el `<input>` es `srOnly` con `id` y
  `<label htmlFor>` srOnly ("Adjuntar archivos"). El botón NO es submit (evita mandar el form).
- Touch ≥44px (`min-height/min-width: var(--space-11)`), `:active { transform: scale(0.97) }`.

`accept` (allowlist WhatsApp — **espejo del `spec-send`; fuente de verdad = constante BE**):
```
image/jpeg,image/png,image/webp,
video/mp4,video/3gpp,
audio/mpeg,audio/ogg,audio/aac,audio/amr,
application/pdf,
application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,
application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
text/plain,application/zip
```
`accept` es un **filtro de conveniencia** del picker, NO seguridad — la validación real es §6.2 (client) + BE.

### 5.2 `ComposerAttachmentTray` + `AttachmentPreviewItem`

`ComposerAttachmentTray`: grid horizontal scrollable de chips. Props `{ drafts, onRemove(id) }`.
- Layout: `display:flex; gap:var(--space-2); overflow-x:auto` (no rompe el body en 375px — scroll
  interno, regla responsive de ui-ux-pro-max). Máx-alto fijo, `scroll-snap` suave opcional.
- `role="list"`, cada item `role="listitem"`; `aria-label="Archivos adjuntos ({n})"`.

`AttachmentPreviewItem`: un chip. Props `{ draft, onRemove(id) }`.
- **image/video** → thumbnail (`<img src={draft.previewUrl}>`, `object-fit:cover`, ratio 1/1, ~64-72px).
  Video: thumbnail = primer frame no trivial → mostrar `previewUrl` en un `<video muted preload=metadata>`
  o, más simple/robusto, un tile con `IconFileGeneric`-video + nombre (evita costo de poster). **Recomendado**:
  imagen = `<img>`; video/audio/file = tile ícono+nombre (§11 Decisión FE-3).
- **audio/file** → tile: `FileTypeIcon(contentType)` (o ícono audio) + `filename` (line-clamp 2) +
  `formatFileSize(file.size)`.
- **Botón quitar** (× / `IconTrash` SVG) esquina sup-der, `aria-label="Quitar {filename}"`, ≥44px
  touch (patrón `::before inset:-6px` de `.mediaFileDownload`).
- **Estado por archivo**:
  - válido → chip normal.
  - `error` (type/size) → borde `--color-danger`, `IconAlert` + `draft.error.message`, `role="alert"`.
    **El color NO es señal única** (ícono + texto), regla contraste/daltonismo.
  - *(subiendo/error de red viven en la BURBUJA, no en el tray — el tray es pre-envío; al enviar se limpia)*.

### 5.3 `MessageBubble` extendido (render outbound optimista)

`MessageThread` mapea cada `PendingSend` a un `WhatsappMessage` optimista:
```ts
const optimisticMessage: WhatsappMessage = {
  id: pending.tempId,
  direction: 'outbound',
  content: pending.content,
  senderName: null,
  sentAt: pending.createdAt,
  attachments: pending.drafts
    .filter(d => d.error === null)
    .map(d => ({
      id: `${pending.tempId}:${d.id}`,
      fileType: d.fileType,
      contentType: d.file.type,
      filename: d.file.name,
      fileSize: d.file.size,
      width: null, height: null,
      status: 'downloaded',          // ← clave: NO 'pending' (eso pintaría el skeleton); el binario local YA existe
      url: d.previewUrl ?? '',       // objectURL — MediaImage/Video lo sirve directo
      thumbUrl: null,                // fallback al original (proposal Decisión 7)
    })),
};
```
Se renderiza con el **mismo** `MediaAttachments`/`MediaAttachment` del inbound (reuso puro). El
estado de entrega se pasa **por props nuevas y opcionales** a `MessageBubble`:
```ts
deliveryStatus?: 'sending' | 'failed';   // undefined = mensaje real, comportamiento actual intacto
uploadProgress?: number;                 // 0..1, solo con 'sending'
onRetry?: () => void;                    // 'failed'
onDiscard?: () => void;                  // 'failed'
```
Dentro de la burbuja, debajo de la media:
- `sending` → **barra de progreso determinada** (`role="progressbar" aria-valuenow` + live region) +
  la burbuja al `opacity: 0.85` (indica "aún no confirmado", Emil *state indication*).
- `failed` → fila `IconAlert` + "No se pudo enviar" + botón "Reintentar" (`onRetry`) + "Descartar"
  (`onDiscard`). La media local sigue visible (no se pierde — proposal Decisión 3).
- `undefined` → render actual, sin overlay (inbound y outbound-confirmado no cambian).

---

## 6. Hook de envío + API + validación

### 6.1 `whatsapp.api.ts` — `sendWhatsappMessage` (FormData + progreso)

Firma nueva **aditiva** (retrocompat texto = camino JSON, cero regresión):
```ts
export interface SendMessageInput {
  content: string;
  files?: File[];
  onUploadProgress?: (fraction: number) => void;   // 0..1
}

export const sendWhatsappMessage = (id: string, input: SendMessageInput): Promise<WhatsappMessage> => {
  // Sin files → JSON (idéntico a hoy: { content })
  if (!input.files || input.files.length === 0) {
    return axiosClient.post<WhatsappMessage>(`${BASE}/conversations/${id}/messages`, { content: input.content })
      .then(r => r.data);
  }
  // Con files → multipart. Field name 'attachments' = multer .array('attachments') del BE (proposal §3).
  const form = new FormData();
  form.append('content', input.content);
  for (const f of input.files) form.append('attachments', f);
  return axiosClient
    .post<WhatsappMessage>(`${BASE}/conversations/${id}/messages`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },   // axios 1.x agrega el boundary solo
      onUploadProgress: (e) => { if (e.total) input.onUploadProgress?.(e.loaded / e.total); },
    })
    .then(r => r.data);
};
```
Nota: axios reporta `e.total` para FormData en browser. Si por algún proxy `total` viene 0/undefined,
el progreso cae a **indeterminado** (spinner) en vez de barra — la UI degrada, no rompe.

### 6.2 Validación client-side (`validateAttachment.ts`) — ESPEJO del BE

```ts
export const MAX_FILES = 10;                            // proposal Decisión 2 / tu instrucción
export const MAX_BYTES_BY_FILE_TYPE = {                 // ESPEJO de la constante BE (Tanda 1)
  image: 5  * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  file:  100 * 1024 * 1024,
} as const;

export function deriveFileType(mime: string): 'image'|'video'|'audio'|'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}
export function validateFile(file: File): DraftAttachment['error'] {
  // (allowlist opcional acá; el BE es la autoridad de tipo — 415)
  const type = deriveFileType(file.type);
  if (file.size > MAX_BYTES_BY_FILE_TYPE[type])
    return { code: 'TOO_LARGE', message: `Supera el límite de ${formatFileSize(MAX_BYTES_BY_FILE_TYPE[type])} para ${type}.` };
  return null;
}
```
**Contrato de verdad = BE.** El FE valida por **feedback inmediato** (no molestar al agente
subiendo 100MB para que rebote 413), pero el BE re-valida SIEMPRE (415/413). Los límites y la
allowlist deben **derivarse del `spec-send`**; si divergen, gana el BE (el mapper §6.4 traduce su
error). *Riesgo documentado:* mantener FE↔BE en sync (test de contrato sugerido en §10).

### 6.3 `useSendWhatsappMessage` extendido + slice optimista

Problema a resolver: `useWhatsappMessages` pollea cada 5s; una subida de varios MB **dura más que
un ciclo de poll**, y el poll reemplaza el array entero → **borraría la burbuja optimista**. La
solución del texto-actual (`cancelQueries`+dedup en `onSuccess`) NO alcanza porque el mensaje aún no
existe en el server durante la subida.

**Solución: los envíos en vuelo viven en un slice de cache PROPIO que nadie pollea.**
```ts
export const whatsappPendingSendsKey = (id: string) => ['whatsapp', 'pendingSends', id] as const;

// hook de lectura reactivo — cache-como-store: sin queryFn, enabled:false → nunca refetchea,
// pero el observer SÍ re-renderiza ante cada setQueryData (patrón react-query "external store").
export function usePendingSends(id: string): PendingSend[] {
  return useQuery({ queryKey: whatsappPendingSendsKey(id), enabled: false, initialData: [] as PendingSend[] }).data ?? [];
}
```

```ts
export function useSendWhatsappMessage(id: string) {
  const qc = useQueryClient();
  const pendingKey = whatsappPendingSendsKey(id);

  const patch = (tempId: string, fn: (p: PendingSend) => PendingSend) =>
    qc.setQueryData<PendingSend[]>(pendingKey, (old = []) => old.map(p => p.tempId === tempId ? fn(p) : p));

  const mutation = useMutation({
    mutationFn: (vars: { content: string; files: File[]; drafts: DraftAttachment[]; tempId: string }) =>
      api.sendWhatsappMessage(id, {
        content: vars.content,
        files: vars.files,
        onUploadProgress: (f) => patch(vars.tempId, p => ({ ...p, progress: f })),
      }),

    onMutate: (vars) => {
      qc.setQueryData<PendingSend[]>(pendingKey, (old = []) => [
        ...old,
        { tempId: vars.tempId, content: vars.content, drafts: vars.drafts, progress: 0, status: 'sending', createdAt: new Date().toISOString() },
      ]);
    },

    onSuccess: async (message: WhatsappMessage, vars) => {
      vars.drafts.forEach(d => d.previewUrl && URL.revokeObjectURL(d.previewUrl));   // no leaks
      qc.setQueryData<PendingSend[]>(pendingKey, (old = []) => old.filter(p => p.tempId !== vars.tempId));
      await qc.cancelQueries({ queryKey: whatsappMessagesKey(id) });                 // gana la carrera al poll (bug #5)
      qc.setQueryData<WhatsappMessage[]>(whatsappMessagesKey(id), (old) => {
        const list = old ?? [];
        return list.some(m => m.id === message.id) ? list : [...list, message];      // dedup por id
      });
      void qc.invalidateQueries({ queryKey: WHATSAPP_CONVERSATIONS_ROOT });
    },

    onError: (_e, vars) => { patch(vars.tempId, p => ({ ...p, status: 'failed' })); },  // NO relanza; queda en la burbuja
  });

  // API de composer: content + files → arma tempId + drafts
  const send = (input: { content: string; files: File[]; drafts: DraftAttachment[] }, opts?) =>
    mutation.mutate({ ...input, tempId: `optimistic:${crypto.randomUUID()}` }, opts);

  const retry = (pending: PendingSend) => {
    patch(pending.tempId, p => ({ ...p, status: 'sending', progress: 0 }));
    mutation.mutate({ content: pending.content, files: pending.drafts.filter(d => !d.error).map(d => d.file), drafts: pending.drafts, tempId: pending.tempId });
  };
  const discard = (pending: PendingSend) => {
    pending.drafts.forEach(d => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
    qc.setQueryData<PendingSend[]>(pendingKey, (old = []) => old.filter(p => p.tempId !== pending.tempId));
  };

  return { send, retry, discard, isError: mutation.isError, error: mutation.error };
}
```

**Merge en `MessageThread`** (orden estable):
```ts
const server = useWhatsappMessages(id).data ?? [];
const pending = usePendingSends(id);
// server ya viene ordenado por sentAt asc; los pending van DESPUÉS (son los más nuevos, aún sin confirmar)
const rows = [...server, ...pending.map(toOptimisticMessage)];   // sort defensivo por sentAt si hiciera falta
```
Edge (documentado): si el **poll trae el mensaje real ANTES** de que resuelva el POST (mirror más
rápido que la respuesta), se ve un instante el real + el optimista (contenido idéntico) hasta que
`onSuccess` remueve el pending. Ventana = 1 round-trip; aceptable (misma clase de race que el texto).

### 6.4 `mapSendError.ts` (molde `mapUploadError`)

```ts
export function mapSendError(err: unknown): string {
  const code = (err as any)?.response?.data?.code ?? (err as any)?.response?.data?.error;
  switch (code) {
    case 'UNSUPPORTED_ATTACHMENT_TYPE': return 'Ese tipo de archivo no se puede enviar por WhatsApp.';
    case 'ATTACHMENT_TOO_LARGE':
    case 'FILE_TOO_LARGE':             return 'Un archivo supera el tamaño máximo permitido.';
    case 'TOO_MANY_FILES':             return `Máximo ${MAX_FILES} archivos por mensaje.`;
    case 'MESSAGING_WINDOW_EXPIRED':   return 'La ventana de 24 horas expiró. Se necesita una plantilla.';
    case 'CHATWOOT_UNAVAILABLE':       return 'El servicio de mensajería no está disponible. Reintentá en unos minutos.';
    case 'CONVERSATION_NOT_FOUND':     return 'Esta conversación ya no existe.';
    default:                           return 'No se pudo enviar el mensaje. Reintentá.';
  }
}
```
(Los códigos exactos se toman del `errorHandler`/`spec-send` del BE — alinear en apply.)

---

## 7. Design system aplicado (ui-ux-pro-max + tokens del repo)

El "design system recomendado" que devolvió `ui-ux-pro-max` es para landing/form; acá manda el
**sistema real del repo** (tokens ya usados en `Composer.module.css` / `Media.module.css`). Se
aplica su **checklist pre-delivery** contra esos tokens:

| Regla ui-ux-pro-max | Aplicación concreta (token del repo) |
|---|---|
| Sin emojis como íconos → SVG | `IconPaperclip`/`IconTrash`/`IconAlert`/`FileTypeIcon` inline `stroke=currentColor` (mediaIcons). |
| `cursor-pointer` en clickables | Botón adjuntar, quitar, reintentar, descartar. |
| Hover con transición 150-300ms | `transition: background .18s ease, border-color .18s ease` (mismo que `.errorRetryBtn`), gateado `@media (hover:hover) and (pointer:fine)`. |
| Contraste ≥4.5:1 | Chip sobre `--color-surface`/`--color-gray-50`; **texto secundario NUNCA sobre `--color-primary-hover` (bubble outbound) ni sobre `--color-danger-bg-hover`** → usar `--color-text-primary` ahí (pitfalls ya documentados en `Media.contrast.test.tsx` / `MessageBubble.contrast.test.tsx`). Barra de progreso `--color-primary` sobre pista `--color-gray-200`. |
| Focus visible | `:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px }` (patrón del módulo). Error/danger → outline `--color-danger`. |
| `prefers-reduced-motion` | §8 (toda los transforms; conserva opacity + la barra determinada = feedback funcional). |
| Responsive 375/768/1024/1440 | Tray `overflow-x:auto` (nunca desborda el body); chips `min-width: min(72px,100%)`; el composer ya es `flex` fluido. |
| Touch ≥44px | Adjuntar/quitar/reintentar `min-height:var(--space-11)` (44px) o hit-area `::before inset:-6px` sobre un visible menor. |

Tokens concretos: `--color-primary`, `--color-primary-hover`, `--color-surface`, `--color-gray-50/100/200/300`, `--color-border`, `--color-text-primary`, `--color-text-secondary`, `--color-danger`, `--color-danger-bg-hover`, `--badge-*`, `--space-1..3/11`, `--radius-md/full`, `--font-size-xs/sm`, `--font-weight-medium`, `--shadow-md`, y el ease local `--wa-ease-out: cubic-bezier(0.23, 1, 0.32, 1)` (declarado local en cada raíz, mismo criterio que los módulos existentes).

---

## 8. Animaciones (Emil) — tabla de decisión

Frecuencia: adjuntar/enviar son acciones **ocasionales** del agente → animación estándar OK (no es
tecla repetida 100×/día → no se mata). Todo **<300ms**, solo `transform`/`opacity` (GPU), CSS
transitions (interrumpibles) sobre keyframes para lo dinámico.

| Efecto (vocabulario) | Propiedad | Duración | Easing | Nota Emil |
|---|---|---|---|---|
| **Scale in** del thumbnail al adjuntar | `opacity 0→1`, `transform: scale(.95)→1` | 200ms | `--wa-ease-out` `cubic-bezier(0.23,1,0.32,1)` | Nunca `scale(0)` (nada aparece de la nada). Entrada = ease-out (responde ya). |
| **Stagger** cuando se eligen varios de una | `animation-delay` | 40ms/ítem | — | Reusa el patrón `--i` de `Media.module.css`; 30-80ms, corto (no ralentiza). |
| **Exit** del chip al quitar | `opacity 1→0`, `transform: scale(.95)` | 150ms | ease-out | **Asymmetric**: exit más rápido que enter (200→150). |
| **Press feedback** botón adjuntar/quitar | `transform: scale(0.97)` | 120-150ms | ease-out | `:active` — "la UI escucha". |
| **Progress bar** subida (determinada) | `transform: scaleX(progress)` `transform-origin:left` | tween 120ms entre valores | `linear` | Movimiento constante = linear; `scaleX` (no `width`) = GPU, sin layout thrash. `aria-valuenow`. |
| **"enviando"→"enviado"** (swap optimista→real) | `opacity` del overlay 1→0; media queda en su lugar | 200ms | ease | **Spatial consistency / Continuity**: la burbuja real toma la MISMA posición; NO se re-dispara el `enter` (`isNew`) del bubble para un mensaje que reemplaza un optimista (evita doble animación). Blur(2px) opcional para enmascarar el crossfade si se nota. |
| **Shake / Wiggle** en fallo | `transform: translateX(±3px)` one-shot | 200ms | ease | Señal de error (Emil/glossary). **Sutil**, one-shot, gateado por reduced-motion. Opcional (§11). |
| Blur-up del thumbnail (imagen) | `filter blur(8px)→0 + opacity` | 260ms | `--wa-ease-out` | **Ya existe** en `MediaImage`; corre igual sobre el objectURL. |

**`prefers-reduced-motion: reduce`** (Emil: *tonar, no matar*; feedback funcional se queda):
```css
@media (prefers-reduced-motion: reduce) {
  .previewItem, .previewItem.exiting { transform: none; transition: opacity 150ms ease; }
  .attachBtn:active, .removeBtn:active { transform: none; }
  .progressFill { transition: none; }        /* la barra sigue mostrando el valor — es INFO, no adorno */
  .failed { animation: none; }               /* sin wiggle */
}
```

---

## 9. Accesibilidad (detalle)

- **Input file**: `<input type="file" id="composer-attach-input" class=srOnly …>` + `<label htmlFor="composer-attach-input" class=srOnly>Adjuntar archivos</label>`; el botón visible reenvía el click y lleva `aria-label="Adjuntar archivos"`, `type="button"`.
- **Progreso**: `<div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress*100)} aria-label="Enviando archivo">` **+** región `aria-live="polite"` que anuncia hitos ("Enviando… 50%", "Enviado", "No se pudo enviar") — **throttled** (inicio, ~cada 25-50%, fin) para no spamear al lector (Emil: *handle edge cases invisibly*).
- **Foco**:
  - Tras adjuntar → foco **permanece en el botón adjuntar** (permite seguir agregando) + live region "N archivos adjuntos". (No robar foco al primer chip: menos disruptivo.)
  - Tras quitar un chip → foco al botón "quitar" del **chip siguiente**; si era el último, al **botón adjuntar** (patrón lista de chips borrables). Evita el "foco perdido al `document.body`".
  - En `failed` → el botón "Reintentar" es foco-able y anunciado por el `role="alert"` del overlay.
- **Botón quitar**: `aria-label="Quitar {filename}"`.
- **Error por archivo** (type/size): `role="alert"`, y **el color no es la única señal** (`IconAlert` + texto).
- **Botón enviar**: conserva `aria-label="Enviar mensaje"`; cuando `!canSend` por ventana, el banner `role="status"` ya explica el motivo.

---

## 10. Testing (Strict TDD — vitest + RTL, red→green→refactor)

Superficie mínima de tests (empezar por el test):

- `validateAttachment.test.ts` (pura): `deriveFileType` por prefijo; `validateFile` rechaza >límite por tipo, acepta borde exacto, tipos raros → 'file'/100MB.
- `mapSendError.test.ts` (pura): cada code → copy; default.
- `useComposerAttachments.test.ts`: add valida + crea objectURL; add sobre el tope recorta; remove **revoca** el objectURL (spy sobre `URL.revokeObjectURL`); unmount revoca todos. **Mock `URL.createObjectURL`/`revokeObjectURL`** (jsdom no los trae — mismo tipo de gap que `matchMedia`, ya guardado en `MessageBubble`).
- `ComposerAttachButton.test.tsx`: click abre picker; onChange mapea files + resetea `value`; a11y label.
- `AttachmentPreviewItem.test.tsx`: image → `<img>`; file → icono+nombre+size; error → `role="alert"` + icono; quitar dispara `onRemove(id)` con aria-label correcto.
- `Composer.test.tsx` (extender): send habilitado con solo-files (sin texto); disabled si algún draft con error; Enter envía media-sola; `onSuccess` limpia content+drafts.
- `useWhatsapp.send.test.ts`: `onMutate` mete el pending; progreso patchea; `onSuccess` remueve pending + appendea real + dedup + `cancelQueries`; `onError` → `status:'failed'` (no relanza); `retry` re-mutar; `discard` revoca+remueve. **El poll no borra el pending** (setQueryData sobre `whatsappMessagesKey` no toca `pendingSends`).
- `MessageBubble.test.tsx` (extender): `deliveryStatus:'sending'` → progressbar; `'failed'` → Reintentar/Descartar; `undefined` → sin overlay (regresión inbound/outbound intacta).
- Contract test sugerido: `MAX_BYTES_BY_FILE_TYPE`/`MAX_FILES` FE == valores del `spec-send` BE (evita drift §6.2).

---

## 11. Decisiones FE abiertas (necesitan OK antes de tasks/apply)

- **FE-1 · Optimistic bubble vs. progreso-en-composer.** Recomiendo **bubble optimista** (WhatsApp-grade, lo pide el proposal Decisión 3) con el **pending-slice** que sobrevive al poll (§6.3). Alternativa de menor riesgo/scope: NO bubble, progreso en el tray y appendear el real al 201 (como el texto hoy) — más simple, peor percepción con archivos grandes. *Recomendado: bubble.*
- **FE-2 · Dónde se muestra el error de un send-con-files.** Recomiendo **en la burbuja** (ahí quedó la media para reintentar) y **suprimir** el banner del composer para ese caso (evita doble mensaje). Alternativa: ambos.
- **FE-3 · Preview de video/audio.** Recomiendo **imagen = `<img>` thumbnail; video/audio/file = tile ícono+nombre** (barato, robusto). Alternativa: poster-frame de video con `<video preload=metadata>` (más "lindo", más costo/edge). *Recomendado: tile para no-imagen.*
- **FE-4 · Drag & drop.** **Queda para follow-up (fuera del MVP de esta tanda)** — es una capa aditiva delgada: `onDragOver`/`onDrop` sobre `.composer` que llama al mismo `add(files)` + un overlay "Soltá para adjuntar". No bloquea nada; se puede sumar sin tocar el hook ni la validación. Marco: **NO entra ahora**, sí el click-picker (cubre 100% del caso).
- **FE-5 · `MAX_FILES` y límites por tipo.** Tomo **10 archivos** + **5/16/16/100MB** (image/video/audio/file) como espejo del BE; **confirmar contra el `spec-send`** — si el BE define otros, gana el BE y el FE los mirror-ea (single source of truth).
- **FE-6 · Cache-slice (`enabled:false`) vs. Context para el pending.** Recomiendo el **slice de react-query** (reusa `qc`, consistente con los 4 hooks del archivo, re-render por observer). Alternativa: `useSyncExternalStore`/Context (más explícito, más boilerplate). *Recomendado: slice.*

---

## 12. Riesgos (FE)

- **Poll (5s) borra el optimista** — mitigado por el pending-slice no polleado (§6.3). Sin esa pieza, una subida >5s "parpadea".
- **Leak de `objectURL`** — mitigado: `useComposerAttachments` revoca al quitar/desmontar; el hook revoca en `onSuccess`/`discard`. Test explícito (§10).
- **jsdom sin `createObjectURL`/`revokeObjectURL`/`matchMedia`** — mockear en setup (evidencia: el guard `matchMedia` ya vive en `MessageBubble`).
- **Drift FE↔BE de límites/allowlist** — el FE valida por UX pero el BE es autoridad; contract-test + derivar del `spec-send` (§6.2).
- **`e.total` ausente en algún proxy** — la barra determinada cae a spinner indeterminado (degrada, no rompe).
- **Doble-burbuja transitoria** (poll gana al POST) — ventana de 1 round-trip, contenido idéntico; aceptable.
- **Contraste sobre bubble outbound / danger-bg** — ya es campo minado documentado; el diseño mantiene toda meta-tipografía sobre superficie propia (`--color-surface`/`--color-gray-50`), nunca sobre `--color-primary-hover`.
