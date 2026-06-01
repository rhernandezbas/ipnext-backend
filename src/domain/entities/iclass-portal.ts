/**
 * Structures scraped from the IClass SEAM portal closure page
 * (`baixa_os_validada.seam`). The API v2 is photo-blind, so the portal HTML is
 * the only source for checklist photo URLs and the signature.
 */

/** One survey ("Encuesta") question as rendered in the portal HTML. */
export interface ScrapedQuestion {
  /**
   * 0-based position within the survey, taken from the `perguntaDecoration{N}`
   * id. Aligns 1:1 with the API checklist `resposta.ordem`, which is the join
   * key used to attach a photoUrl to the right answer.
   */
  ordem: number;
  /** text (textarea) | choice (select) | photo (image link or "No Disponible"). */
  kind: 'text' | 'choice' | 'photo';
  /** Question label (the bold span text). */
  label: string;
  /** Answer text for text/choice questions; null for photo. */
  answerText: string | null;
  /** S3 URL for a photo question that has an uploaded image; null otherwise. */
  photoUrl: string | null;
  /** Original filename shown next to a photo, when present. */
  fileName: string | null;
  /** true for a photo question with no uploaded image ("No Disponible"). */
  photoMissing: boolean;
}

/** An attachment from the "Adjuntos" section (e.g. the OS signature). */
export interface ScrapedAttachment {
  url: string;
  label: string;
}

/** Parsed closure-page detail: survey questions + attachments. */
export interface ScrapedOSDetail {
  questions: ScrapedQuestion[];
  attachments: ScrapedAttachment[];
}
