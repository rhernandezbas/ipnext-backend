import { OllamaInstallationAuditor } from '@infrastructure/adapters/audit/OllamaInstallationAuditor';
import { auditFormatSchema } from '@infrastructure/adapters/audit/auditFormatSchema';
import { AuditContext } from '@domain/entities/installation-audit';

function ctx(over: Partial<AuditContext> = {}): AuditContext {
  return {
    osCodigo: '4013', technicianName: 'Rodrigo', resultCodeName: 'Instalacion Completa Fibra',
    checklistText: [], technicianNote: null, materials: [], photoUrls: [],
    taskTitle: 'Instalación', taskDescription: null, taskComments: [], ...over,
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
});
