import { SoChecklist } from '@domain/entities/iclass-closed-order';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';

/**
 * Attach SEAM-scraped photo URLs to API checklist answers by `ordem`
 * (`answerOrder` ↔ scraped `question.ordem`). The API v2 is photo-blind; the
 * portal scrape is the only source of photo URLs. Pure — no network.
 *
 * Assumes a single survey per OS (verified across the sampled SO types): the
 * scraped `perguntaDecoration{N}` index aligns with the API `resposta.ordem`.
 * Only photo questions with a URL contribute; text/choice answers are untouched.
 */
export function correlateChecklistPhotos(
  checklists: SoChecklist[],
  scraped: ScrapedOSDetail,
): SoChecklist[] {
  const urlByOrdem = new Map<number, string>();
  for (const q of scraped.questions) {
    if (q.kind === 'photo' && q.photoUrl) urlByOrdem.set(q.ordem, q.photoUrl);
  }
  if (urlByOrdem.size === 0) return checklists;

  return checklists.map(c => ({
    ...c,
    answers: c.answers.map(a => {
      const url = urlByOrdem.get(a.answerOrder);
      return url ? { ...a, photoUrl: url } : a;
    }),
  }));
}
