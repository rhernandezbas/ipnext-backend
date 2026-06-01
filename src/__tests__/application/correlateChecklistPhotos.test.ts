import { correlateChecklistPhotos } from '@application/services/correlateChecklistPhotos';
import { SoChecklist, SoChecklistAnswer } from '@domain/entities/iclass-closed-order';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';

const answer = (over: Partial<SoChecklistAnswer>): SoChecklistAnswer => ({
  questionId: null,
  questionText: '',
  questionType: 'Texto',
  answerOrder: 0,
  answerText: null,
  photoMissing: false,
  photoUrl: null,
  ...over,
});

const checklist = (answers: SoChecklistAnswer[]): SoChecklist => ({
  iclassSurveyId: '1',
  surveyAt: null,
  answers,
});

const scraped = (questions: ScrapedOSDetail['questions']): ScrapedOSDetail => ({
  questions,
  attachments: [],
});

describe('correlateChecklistPhotos', () => {
  it('SCEN-CO-1: sets photoUrl on the Foto answer at the matching ordem', () => {
    const cls = [checklist([
      answer({ answerOrder: 0, questionType: 'Texto', answerText: 'utp' }),
      answer({ answerOrder: 3, questionType: 'Foto', photoMissing: true }),
    ])];
    const sc = scraped([
      { ordem: 0, kind: 'text', label: 'mat', answerText: 'utp', photoUrl: null, fileName: null, photoMissing: false },
      { ordem: 3, kind: 'photo', label: 'router', answerText: null, photoUrl: 'https://x/router.jpg', fileName: 'r.jpg', photoMissing: false },
    ]);

    const [out] = correlateChecklistPhotos(cls, sc);
    expect(out.answers.find(a => a.answerOrder === 3)!.photoUrl).toBe('https://x/router.jpg');
    // text answer untouched
    expect(out.answers.find(a => a.answerOrder === 0)!.photoUrl).toBeNull();
  });

  it('SCEN-CO-2: disambiguates repeated labels by ordem, not text', () => {
    const cls = [checklist([
      answer({ answerOrder: 2, questionType: 'Foto' }),
      answer({ answerOrder: 5, questionType: 'Foto' }),
    ])];
    const sc = scraped([
      { ordem: 2, kind: 'photo', label: 'ADJUNTAR FOTO', answerText: null, photoUrl: 'https://x/a2.jpg', fileName: null, photoMissing: false },
      { ordem: 5, kind: 'photo', label: 'ADJUNTAR FOTO', answerText: null, photoUrl: 'https://x/a5.jpg', fileName: null, photoMissing: false },
    ]);

    const [out] = correlateChecklistPhotos(cls, sc);
    expect(out.answers.find(a => a.answerOrder === 2)!.photoUrl).toBe('https://x/a2.jpg');
    expect(out.answers.find(a => a.answerOrder === 5)!.photoUrl).toBe('https://x/a5.jpg');
  });

  it('SCEN-CO-3: leaves photoUrl null when the scrape has no photos', () => {
    const cls = [checklist([answer({ answerOrder: 3, questionType: 'Foto', photoMissing: true })])];
    const [out] = correlateChecklistPhotos(cls, scraped([]));
    expect(out.answers[0].photoUrl).toBeNull();
  });
});
