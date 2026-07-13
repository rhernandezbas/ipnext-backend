/**
 * messaging-inbox-polish (F1.5) — WhatsApp-style preview for a conversation's last
 * message. The `preview`/`lastMessagePreview` of the inbox list is stored in the mirror
 * at WRITE time (webhook `ReceiveChatwootWebhook` + `SendMessage`), never re-derived on
 * read (`toConversationListItemDto` only forwards the stored string). When the last
 * message is MEDIA-ONLY (empty/blank content but ≥1 binary attachment), a bare mirror
 * preview would leave the FE showing "Sin mensajes"; this fills it with an emoji+label
 * exactly like WhatsApp. The emoji lives in the preview TEXT — it is plain text, not a
 * UI icon.
 */

/** The 4 binary media kinds that carry a downloadable file (same set as `BINARY_FILE_TYPES`). */
type MediaFileType = 'image' | 'audio' | 'video' | 'file';

const MEDIA_PREVIEW_LABEL: Record<MediaFileType, string> = {
  image: '📷 Imagen',
  video: '🎥 Video',
  audio: '🎵 Audio',
  file: '📎 Archivo',
};

/**
 * Priority (WhatsApp semantics):
 *  1. Non-empty text `content` (the caption) ALWAYS wins — returned verbatim, so
 *     text-only previews are 100% retrocompatible (a text message stores exactly what
 *     it stored before this change).
 *  2. No text but ≥1 media attachment → emoji+label of the FIRST attachment's fileType,
 *     or a count ("📎 N archivos") when there are several.
 *  3. No text AND no media → the original content (`''`/`null`) untouched — i.e. the
 *     pre-existing fallback, so a non-binary attachment (location/contact/…) or a truly
 *     empty message behaves exactly as before.
 *
 * `mediaFileTypes` MUST be already filtered to the binary set by the caller
 * (location/contact/fallback/embed never reach here) and kept in wire order.
 */
export function deriveConversationPreview(
  content: string | null | undefined,
  mediaFileTypes: string[],
): string | null {
  if (content && content.trim() !== '') return content; // caption wins, verbatim
  if (mediaFileTypes.length === 0) return content ?? null; // no media → original fallback
  if (mediaFileTypes.length === 1) {
    return MEDIA_PREVIEW_LABEL[mediaFileTypes[0] as MediaFileType] ?? MEDIA_PREVIEW_LABEL.file;
  }
  return `📎 ${mediaFileTypes.length} archivos`;
}
