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
});
