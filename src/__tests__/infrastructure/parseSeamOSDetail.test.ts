import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSeamOSDetail } from '@infrastructure/adapters/iclass-portal/parseSeamOSDetail';

const FIX = join(__dirname, 'fixtures', 'iclass-seam');
const load = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('parseSeamOSDetail', () => {
  describe('INSTALACION WIRELESS (seam-3532-wireless): text + 4 photos + signature', () => {
    const detail = parseSeamOSDetail(load('seam-3532-wireless.html'));

    it('extracts the 7 survey questions (ordem 0..6), scoped to the Encuesta panel', () => {
      // SCEN-SC-5: header fields (Motivo/Responsable/Relación) and empty props excluded.
      expect(detail.questions).toHaveLength(7);
      expect(detail.questions.map(q => q.ordem)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('SCEN-SC-1: maps a photo question to its S3 url', () => {
      const router = detail.questions.find(q => /MAC Y SN DEL ROUTER/i.test(q.label))!;
      expect(router.kind).toBe('photo');
      expect(router.ordem).toBe(3);
      expect(router.photoUrl).toContain('photo-2.jpg');
      expect(router.photoMissing).toBe(false);
    });

    it('reads text answers (textarea)', () => {
      const materials = detail.questions.find(q => q.ordem === 0)!;
      expect(materials.kind).toBe('text');
      expect(materials.answerText).toContain('utp 30');
    });

    it('captures the signature as an attachment (Adjuntos)', () => {
      expect(detail.attachments.length).toBe(1);
      expect(detail.attachments[0].url).toContain('assinatura');
    });
  });

  describe('VISITA TECNICA (seam-vt-choice): choice questions', () => {
    const detail = parseSeamOSDetail(load('seam-vt-choice.html'));

    it('extracts the 5 survey questions', () => {
      expect(detail.questions).toHaveLength(5);
    });

    it('SCEN-SC-4: a <select> question is kind="choice", not text/photo', () => {
      expect(detail.questions.some(q => q.kind === 'choice')).toBe(true);
    });
  });

  describe('Red (seam-2980-fibra): photo-missing', () => {
    const detail = parseSeamOSDetail(load('seam-2980-fibra.html'));

    it('extracts the 10 survey questions', () => {
      expect(detail.questions).toHaveLength(10);
    });

    it('SCEN-SC-2: photo questions with no upload are photoMissing with null url', () => {
      const missing = detail.questions.filter(q => q.kind === 'photo' && q.photoMissing);
      expect(missing.length).toBeGreaterThan(0);
      missing.forEach(q => expect(q.photoUrl).toBeNull());
    });
  });

  describe('empty (seam-4646-empty): no Encuesta', () => {
    it('SCEN-SC-3: returns empty questions, does not throw', () => {
      const detail = parseSeamOSDetail(load('seam-4646-empty.html'));
      expect(detail.questions).toEqual([]);
      expect(Array.isArray(detail.attachments)).toBe(true);
    });
  });
});
