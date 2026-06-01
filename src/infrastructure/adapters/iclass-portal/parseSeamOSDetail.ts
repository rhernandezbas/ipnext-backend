import * as cheerio from 'cheerio';
import {
  ScrapedOSDetail,
  ScrapedQuestion,
  ScrapedAttachment,
} from '@domain/entities/iclass-portal';

/** Matches image hrefs (checklist photos + signature). Host-agnostic on purpose. */
const IMG_RE = /\.(jpe?g|png)(\?|$)/i;

/**
 * Pure parser for the IClass SEAM closure page HTML. No network — the adapter
 * fetches the HTML and hands it here.
 *
 * Survey questions are scoped by the `perguntaDecoration{N}` id, where N is the
 * `ordem`. This excludes the closure-header fields (Motivo/Responsable/Relación,
 * which use other `*Decoration` prefixes) so the ordem stays aligned with the
 * API v2 checklist. A question is `text` (textarea), `choice` (select) or `photo`
 * (image link, or "No Disponible" → photoMissing).
 */
export function parseSeamOSDetail(html: string): ScrapedOSDetail {
  const $ = cheerio.load(html);
  const questions: ScrapedQuestion[] = [];

  $('div.prop').each((_i, el) => {
    const $el = $(el);
    const decorated = $el.find('[id*="perguntaDecoration"]').first();
    if (!decorated.length) return; // header field / empty prop — not a survey question
    const m = /perguntaDecoration(\d+)/.exec(decorated.attr('id') || '');
    if (!m) return;
    const ordem = parseInt(m[1], 10);

    const label = $el.find('label').first().text().replace(/\s+/g, ' ').trim();

    const textarea = $el.find('textarea').first();
    const select = $el.find('select').first();

    let kind: ScrapedQuestion['kind'];
    let answerText: string | null = null;
    let photoUrl: string | null = null;
    let fileName: string | null = null;
    let photoMissing = false;

    if (textarea.length) {
      kind = 'text';
      answerText = textarea.text().trim() || null;
    } else if (select.length) {
      kind = 'choice';
      const selected = select.find('option[selected]').first();
      answerText = (selected.length ? selected.text() : '').trim() || null;
    } else {
      kind = 'photo';
      const link = $el
        .find('a')
        .filter((_j, a) => IMG_RE.test($(a).attr('href') || ''))
        .first();
      if (link.length) {
        photoUrl = link.attr('href') || null;
        fileName = $el.find('[id*=":name"]').first().text().trim() || null;
      } else {
        photoMissing = true; // "No Disponible"
      }
    }

    questions.push({ ordem, kind, label, answerText, photoUrl, fileName, photoMissing });
  });

  questions.sort((a, b) => a.ordem - b.ordem);

  // Attachments (e.g. the signature in "Adjuntos"): image links that are NOT part
  // of a survey question.
  const attachments: ScrapedAttachment[] = [];
  $('a').each((_i, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    if (!IMG_RE.test(href)) return;
    if ($a.closest('div.prop').length) return; // belongs to a checklist photo
    attachments.push({ url: href, label: ($a.attr('title') || $a.text() || '').replace(/\s+/g, ' ').trim() });
  });

  return { questions, attachments };
}
