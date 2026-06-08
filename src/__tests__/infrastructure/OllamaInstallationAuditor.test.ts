import { OllamaInstallationAuditor } from '@infrastructure/adapters/audit/OllamaInstallationAuditor';
import { auditFormatSchema } from '@infrastructure/adapters/audit/auditFormatSchema';
import { AuditContext } from '@domain/entities/installation-audit';

function ctx(over: Partial<AuditContext> = {}): AuditContext {
  return {
    osCodigo: '4013', technicianName: 'Rodrigo', resultCodeName: 'Instalacion Completa Fibra',
    checklistText: [], technicianNote: null, materials: [], photoUrls: [],
    taskTitle: 'Instalación', taskDescription: null, taskComments: [],
    historyCommentary: [], commentaryLog: '', internalNote: '', equipmentEvents: [],
    ...over,
  };
}

describe('OllamaInstallationAuditor', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends Ollama structured-output format (the findings schema, NOT "json") and parses the array', async () => {
    let captured: any;
    global.fetch = (async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return { json: async () => ({ response: '[{"severity":"ok","category":"otros","text":"sin observaciones"}]' }) };
    }) as any;

    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    const result = await auditor.audit(ctx());

    expect(captured.format).toEqual(auditFormatSchema());
    expect(captured.format).not.toBe('json');
    expect(result.ok).toBe(true);
    expect(result.findings[0]).toMatchObject({ severity: 'ok', category: 'otros' });
  });

  it('soft-fails (ok:false) when the model output is not a valid findings array', async () => {
    global.fetch = (async () => ({ json: async () => ({ response: '<|im_start|><|im_start|>' }) })) as any;
    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    const result = await auditor.audit(ctx());
    expect(result).toEqual({ ok: false, findings: [] });
  });

  // ── F6-R8 — renderPrompt sections (Tasks 3.1 / 3.2 / 3.3) ────────────────

  it('(F6-R8) renders non-empty mirror sections and the no-false-warning instruction', async () => {
    let capturedPrompt = '';
    global.fetch = (async (_url: string, init: any) => {
      capturedPrompt = JSON.parse(init.body).prompt as string;
      return { json: async () => ({ response: '[]' }) };
    }) as any;

    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    await auditor.audit(ctx({
      historyCommentary: [{ status: 'Concluida', commentary: 'todo ok' }],
      commentaryLog: 'log de comentarios',
      internalNote: 'nota interna de prueba',
      equipmentEvents: [
        { type: 'install', serialNumber: 'SN99', mac: 'AA:BB', model: 'ONT' },
        { type: 'remove', serialNumber: 'SN00', mac: null, model: null },
      ],
    }));

    expect(capturedPrompt).toContain('Historial de estados');
    expect(capturedPrompt).toContain('Commentary log');
    expect(capturedPrompt).toContain('Nota interna');
    expect(capturedPrompt).toContain('nota interna de prueba');
    expect(capturedPrompt).toContain('Equipos registrados');
    expect(capturedPrompt).toContain("no marques 'falta X' si X aparece en el contexto");
  });

  it('(F6-R8) omits section labels when corresponding fields are empty', async () => {
    let capturedPrompt = '';
    global.fetch = (async (_url: string, init: any) => {
      capturedPrompt = JSON.parse(init.body).prompt as string;
      return { json: async () => ({ response: '[]' }) };
    }) as any;

    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    await auditor.audit(ctx({
      historyCommentary: [], commentaryLog: '', internalNote: '', equipmentEvents: [],
    }));

    expect(capturedPrompt).not.toContain('Historial de estados');
    expect(capturedPrompt).not.toContain('Commentary log');
    expect(capturedPrompt).not.toContain('Nota interna');
    expect(capturedPrompt).not.toContain('Equipos registrados');
  });

  it('(F6-R8) no-false-warning instruction is always present regardless of context', async () => {
    let capturedPrompt = '';
    global.fetch = (async (_url: string, init: any) => {
      capturedPrompt = JSON.parse(init.body).prompt as string;
      return { json: async () => ({ response: '[]' }) };
    }) as any;

    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    // call with minimal empty context
    await auditor.audit(ctx());

    expect(capturedPrompt).toContain("no marques 'falta X' si X aparece en el contexto");
  });

  // ── Phase 1: New prompt functions (Task 1.4 RED) ─────────────────────────

  it('(1.4) renderPhotoDescribePrompt contains no JSON/schema instructions', () => {
    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    // Accedemos al método público de prueba — lo expondremos como public para tests
    const prompt = (auditor as any).renderPhotoDescribePrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(10);
    // No debe tener instrucción JSON ni schema
    expect(prompt).not.toContain('JSON');
    expect(prompt).not.toContain('array');
    expect(prompt).not.toContain('severity');
    expect(prompt).not.toContain('category');
    expect(prompt).toContain('foto');
  });

  it('(1.4) renderSynthesisPrompt includes "Observaciones por foto" and findings-JSON instruction', () => {
    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });
    const observations = ['foto 1: cable bien tendido', 'foto 2: señal ok'];
    const prompt = (auditor as any).renderSynthesisPrompt(ctx(), observations);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Observaciones por foto');
    expect(prompt).toContain('foto 1: cable bien tendido');
    expect(prompt).toContain('foto 2: señal ok');
    // Debe contener la instrucción de findings JSON como renderPrompt
    expect(prompt).toContain('array JSON');
    expect(prompt).toContain('severity');
    expect(prompt).toContain('category');
  });

  it('(1.4) mapReduceOnDegeneration defaults to true (config field exists)', () => {
    const auditorDefault = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'm' });
    const auditorOff = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'm', mapReduceOnDegeneration: false });
    const auditorOn = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'm', mapReduceOnDegeneration: true });
    // Solo verificamos que se puede construir con el campo — comportamiento probado en Phase 2
    expect((auditorDefault as any).mapReduceOnDegeneration).toBe(true);
    expect((auditorOff as any).mapReduceOnDegeneration).toBe(false);
    expect((auditorOn as any).mapReduceOnDegeneration).toBe(true);
  });

  // ── Phase 2: Map-Reduce Control Flow (Tasks 2.1–2.8 RED) ─────────────────

  /**
   * Helper: crea un auditor con fetchB64 espiado (retorna base64 fake directamente,
   * sin Jimp), más un fake de /api/generate con cola FIFO.
   * Jimp no puede usarse en Jest sin --experimental-vm-modules.
   *
   * @param modelResponses cola FIFO de respuestas para /api/generate
   * @param photoCount cantidad de fotos a simular (fetchB64 devolverá 'fakeb64_N' por cada una)
   */
  function makeAuditorWithPhotos(modelResponses: string[], photoCount: number) {
    const queue = [...modelResponses];
    const modelCalls: Array<{ url: string; body: any }> = [];
    // fetchB64 call tracker (para download-once)
    const fetchB64Calls: string[] = [];

    global.fetch = (async (url: string, init: any) => {
      modelCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const response = queue.shift() ?? '';
      return { json: async () => ({ response }) };
    }) as any;

    const auditor = new OllamaInstallationAuditor({ baseUrl: 'http://ollama', model: 'qwen2.5vl:7b' });

    // Espiamos fetchB64 para que retorne base64 fake sin usar Jimp
    jest.spyOn(auditor as any, 'fetchB64').mockImplementation(async (...args: unknown[]) => {
      const url = args[0] as string;
      fetchB64Calls.push(url);
      return `fakeb64_${url}`;
    });

    return { auditor, modelCalls, fetchB64Calls };
  }

  it('(2.1) Attempt 1 parses ok: transport called exactly once, returns parsed result', async () => {
    const validResponse = '[{"severity":"ok","category":"otros","text":"todo bien"}]';
    const { auditor, modelCalls } = makeAuditorWithPhotos([validResponse], 1);
    const result = await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg'] }));

    expect(result.ok).toBe(true);
    expect(result.findings[0]).toMatchObject({ severity: 'ok', category: 'otros' });
    expect(modelCalls).toHaveLength(1);
  });

  it('(2.2) Map calls: per-photo, single-image, free-text (no format field)', async () => {
    const garbage = '<|im_start|>garbage';
    const desc1 = 'foto 1: cable bien tendido';
    const desc2 = 'foto 2: ONT instalada';
    const validSynthesis = '[{"severity":"ok","category":"conexión","text":"ok"}]';
    // Queue: attempt1=garbage, map1=desc1, map2=desc2, synthesis=validSynthesis
    const { auditor, modelCalls } = makeAuditorWithPhotos([garbage, desc1, desc2, validSynthesis], 2);
    await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg', 'http://foto.test/2.jpg'] }));

    // attempt1 + 2 map + 1 synthesis = 4
    expect(modelCalls).toHaveLength(4);
    // Llamadas MAP: índices 1 y 2 (después de attempt1)
    const mapCall1 = modelCalls[1];
    const mapCall2 = modelCalls[2];
    expect(mapCall1.body.images).toHaveLength(1);
    expect(mapCall2.body.images).toHaveLength(1);
    expect(mapCall1.body.format).toBeUndefined();
    expect(mapCall2.body.format).toBeUndefined();
  });

  it('(2.3) Reduce call: images===[], includes format===auditFormatSchema() and temperature:0', async () => {
    const garbage = '<|im_start|>garbage';
    const { auditor, modelCalls } = makeAuditorWithPhotos([
      garbage,           // attempt1
      'obs foto 1',      // map1
      'obs foto 2',      // map2
      '[{"severity":"ok","category":"otros","text":"síntesis ok"}]', // synthesis
    ], 2);
    await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg', 'http://foto.test/2.jpg'] }));

    const synthesisCall = modelCalls[modelCalls.length - 1];
    expect(synthesisCall.body.images).toEqual([]);
    expect(synthesisCall.body.format).toEqual(auditFormatSchema());
    expect(synthesisCall.body.options.temperature).toBe(0);
  });

  it('(2.4) Map-reduce success: total calls = 1 + N + 1; returns synthesis result', async () => {
    const N = 3;
    const garbage = '<|im_start|>garbage';
    const mapResponses = Array.from({ length: N }, (_, i) => `obs foto ${i + 1}`);
    const synthesisResult = '[{"severity":"warning","category":"señal","text":"señal baja"}]';
    const { auditor, modelCalls } = makeAuditorWithPhotos([garbage, ...mapResponses, synthesisResult], N);
    const result = await auditor.audit(ctx({
      photoUrls: Array.from({ length: N }, (_, i) => `http://foto.test/${i + 1}.jpg`),
    }));

    expect(modelCalls).toHaveLength(1 + N + 1);
    expect(result.ok).toBe(true);
    expect(result.findings[0]).toMatchObject({ severity: 'warning', category: 'señal' });
  });

  it('(2.5) Synthesis parse-fail → ok:false', async () => {
    const garbage = '<|im_start|>garbage';
    const { auditor } = makeAuditorWithPhotos([
      garbage,       // attempt1
      'obs foto 1',  // map1
      garbage,       // synthesis — también garbage
    ], 1);
    const result = await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg'] }));

    expect(result).toEqual({ ok: false, findings: [] });
  });

  it('(2.6) Flag OFF: degeneration yields ok:false, exactly one model call', async () => {
    const garbage = '<|im_start|>garbage';
    const { modelCalls } = makeAuditorWithPhotos([garbage], 1);
    // Necesitamos un auditor con flag OFF — redefinimos
    const auditorOff = new OllamaInstallationAuditor({
      baseUrl: 'http://ollama', model: 'qwen2.5vl:7b', mapReduceOnDegeneration: false,
    });
    jest.spyOn(auditorOff as any, 'fetchB64').mockResolvedValue('fakeb64');
    const result = await auditorOff.audit(ctx({ photoUrls: ['http://foto.test/1.jpg'] }));

    expect(result).toEqual({ ok: false, findings: [] });
    expect(modelCalls).toHaveLength(1);
  });

  it('(2.7) No photos, attempt 1 fails → ok:false, total model calls = 1, zero map calls', async () => {
    const garbage = '<|im_start|>garbage';
    const { auditor, modelCalls } = makeAuditorWithPhotos([garbage], 0);
    const result = await auditor.audit(ctx({ photoUrls: [] }));

    expect(result).toEqual({ ok: false, findings: [] });
    expect(modelCalls).toHaveLength(1);
  });

  // ── Phase 3: Logging (Task 3.1 RED) ─────────────────────────────────────

  it('(3.1) Per-step logs: attempt-1 soft-fail emits warn with OS code; map-reduce entry emits info with photo count', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const garbage = '<|im_start|>garbage';
    const { auditor } = makeAuditorWithPhotos([
      garbage,
      'obs foto 1',
      '[{"severity":"ok","category":"otros","text":"ok"}]',
    ], 1);
    await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg'] }));

    // Warn: debe contener el OS code y 'attempt-1'
    const warnCalls = warnSpy.mock.calls.map(args => args[0] as string);
    expect(warnCalls.some(msg => msg.includes('4013') && msg.includes('attempt-1'))).toBe(true);

    // Log: debe contener el OS code, foto count y 'map-reduce'
    const logCalls = logSpy.mock.calls.map(args => args[0] as string);
    expect(logCalls.some(msg => msg.includes('4013') && msg.includes('1') && msg.includes('map-reduce'))).toBe(true);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('(3.1) Synthesis soft-fail emits its own warn with raw-sample', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const garbage = '<|im_start|>garbage';
    const { auditor } = makeAuditorWithPhotos([
      garbage,       // attempt1
      'obs foto 1',  // map1
      garbage,       // synthesis también garbage
    ], 1);
    await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg'] }));

    const warnMessages = warnSpy.mock.calls.map(args => args[0] as string);
    // Debe haber warn para attempt-1 Y warn para synthesis
    expect(warnMessages.some(msg => msg.includes('attempt-1'))).toBe(true);
    expect(warnMessages.some(msg => msg.includes('synthesis'))).toBe(true);

    warnSpy.mockRestore();
  });

  // ── Phase 4: Structured-outputs invariant (Task 4.1 RED) ────────────────

  it('(4.1) Attempt-1 and synthesis use auditFormatSchema(); map describe calls do NOT', async () => {
    const garbage = '<|im_start|>garbage';
    const { auditor, modelCalls } = makeAuditorWithPhotos([
      garbage,
      'obs foto 1',
      'obs foto 2',
      '[{"severity":"ok","category":"otros","text":"ok"}]',
    ], 2);
    await auditor.audit(ctx({ photoUrls: ['http://foto.test/1.jpg', 'http://foto.test/2.jpg'] }));

    // attempt-1 (índice 0): debe tener format y temperature:0
    expect(modelCalls[0].body.format).toEqual(auditFormatSchema());
    expect(modelCalls[0].body.options.temperature).toBe(0);

    // map calls (índices 1 y 2): NO deben tener format
    expect(modelCalls[1].body.format).toBeUndefined();
    expect(modelCalls[2].body.format).toBeUndefined();
    // pero sí temperature:0
    expect(modelCalls[1].body.options.temperature).toBe(0);
    expect(modelCalls[2].body.options.temperature).toBe(0);

    // synthesis (último): debe tener format y temperature:0
    const synthesisCall = modelCalls[modelCalls.length - 1];
    expect(synthesisCall.body.format).toEqual(auditFormatSchema());
    expect(synthesisCall.body.options.temperature).toBe(0);
  });

  it('(2.8) Download-once: fetchB64 called exactly N times total (no re-fetch during map)', async () => {
    const N = 2;
    const garbage = '<|im_start|>garbage';
    const { auditor, fetchB64Calls } = makeAuditorWithPhotos([
      garbage,
      'obs foto 1',
      'obs foto 2',
      '[{"severity":"ok","category":"otros","text":"ok"}]',
    ], N);
    await auditor.audit(ctx({
      photoUrls: ['http://foto.test/1.jpg', 'http://foto.test/2.jpg'],
    }));

    // fetchB64 debe haberse llamado exactamente N veces — descargas once, no re-fetch
    expect(fetchB64Calls).toHaveLength(N);
  });
});
