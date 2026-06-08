import { AuditInstallationQuality } from '@application/use-cases/AuditInstallationQuality';
import { InMemoryTaskAuditRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAuditRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InstallationAuditor } from '@domain/ports/InstallationAuditor';
import { AuditContext, AuditResult } from '@domain/entities/installation-audit';
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';

class StubAuditor implements InstallationAuditor {
  readonly provider = 'stub:test';
  lastContext: AuditContext | null = null;
  result: AuditResult = { ok: true, findings: [] };
  async audit(ctx: AuditContext): Promise<AuditResult> {
    this.lastContext = ctx;
    return this.result;
  }
}

function order(over: Partial<ClosedServiceOrder> = {}): ClosedServiceOrder {
  return {
    iclassCodigo: '4691', teamTechnicianName: 'Rodrigo', closedByName: null,
    resultCodeName: 'Cambio de Ficha', technicianNote: 'ok',
    checklists: [], materials: [],
    history: [], equipmentEvents: [], commentaryLog: null, internalNote: null,
    ...over,
  } as ClosedServiceOrder;
}

function setup(auditFlag = true) {
  const audits = new InMemoryTaskAuditRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const comments = new InMemoryTaskCommentRepository();
  const auditor = new StubAuditor();
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed('iclass-audit', auditFlag);
  const uc = new AuditInstallationQuality(auditor, audits, scheduling, comments, flags);
  return { audits, scheduling, comments, auditor, flags, uc };
}

describe('AuditInstallationQuality', () => {
  it('persiste los findings que devuelve el auditor', async () => {
    const { audits, scheduling, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1', title: 'Reparación de señal' });
    auditor.result = { ok: true, findings: [{ severity: 'critical', category: 'señal', text: 'señal baja', photoUrls: [] }] };

    await uc.execute({ taskId: 't1', order: order() });

    const f = await audits.listFindingsByTask('t1');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'critical', category: 'señal', text: 'señal baja' });
  });

  it('soft-fail (ok:false) → no persiste y preserva la auditoría previa buena', async () => {
    const { audits, scheduling, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1' });
    auditor.result = { ok: true, findings: [{ severity: 'warning', category: 'fotos', text: 'previa', photoUrls: [] }] };
    await uc.execute({ taskId: 't1', order: order() });

    auditor.result = { ok: false, findings: [] };
    const out = await uc.execute({ taskId: 't1', order: order() });

    expect(out).toBeNull();
    const f = await audits.listFindingsByTask('t1');
    expect(f).toHaveLength(1);
    expect(f[0].text).toBe('previa');
  });

  it('sin problemas (findings vacío) → 1 finding sintético ok', async () => {
    const { audits, scheduling, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1' });
    auditor.result = { ok: true, findings: [] };

    await uc.execute({ taskId: 't1', order: order() });

    const f = await audits.listFindingsByTask('t1');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('ok');
  });

  it('re-run exitoso REEMPLAZA (sin duplicar)', async () => {
    const { audits, scheduling, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1' });
    auditor.result = { ok: true, findings: [{ severity: 'ok', category: 'otros', text: 'v1', photoUrls: [] }] };
    await uc.execute({ taskId: 't1', order: order() });
    auditor.result = { ok: true, findings: [{ severity: 'warning', category: 'instalación', text: 'v2', photoUrls: [] }] };
    await uc.execute({ taskId: 't1', order: order() });

    const f = await audits.listFindingsByTask('t1');
    expect(f).toHaveLength(1);
    expect(f[0].text).toBe('v2');
  });

  it('el AuditContext incluye el detalle de la tarea (título, descripción, comentarios)', async () => {
    const { scheduling, comments, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1', title: 'Reparación de señal', description: 'antena apagada intermitente' });
    await comments.create({ id: 'c1', taskId: 't1', authorName: 'Operador', body: 'el cliente reporta cortes', createdAt: '2026-06-01T00:00:00Z', attachments: [] });

    await uc.execute({ taskId: 't1', order: order() });

    expect(auditor.lastContext!.taskTitle).toBe('Reparación de señal');
    expect(auditor.lastContext!.taskDescription).toBe('antena apagada intermitente');
    expect(auditor.lastContext!.taskComments).toContain('Operador: el cliente reporta cortes');
  });

  it('flag iclass-audit OFF → no audita, retorna null, no persiste', async () => {
    const { audits, scheduling, auditor, uc } = setup(false);
    scheduling.seedTask({ id: 't1' });
    auditor.result = { ok: true, findings: [{ severity: 'critical', category: 'señal', text: 'x', photoUrls: [] }] };

    const out = await uc.execute({ taskId: 't1', order: order() });

    expect(out).toBeNull();
    expect(auditor.lastContext).toBeNull(); // el auditor NO fue invocado (no se llamó a Ollama)
    expect(await audits.listFindingsByTask('t1')).toHaveLength(0);
  });

  it('flag iclass-audit ausente → tampoco audita (fail-closed)', async () => {
    const { audits, scheduling, auditor, flags, uc } = setup();
    flags.seed('iclass-audit', false); // sobrescribe el seed ON por uno OFF — equivalente a ausencia de gate
    scheduling.seedTask({ id: 't1' });

    const out = await uc.execute({ taskId: 't1', order: order() });

    expect(out).toBeNull();
    expect(auditor.lastContext).toBeNull();
    expect(await audits.listFindingsByTask('t1')).toHaveLength(0);
  });

  // ── Task 4.1 — AuditContext passed to auditor includes mirror fields (F6-R7 integration) ──
  it('el AuditContext incluye los campos mirror de IClass (historyCommentary, commentaryLog, internalNote, equipmentEvents)', async () => {
    const { scheduling, auditor, uc } = setup();
    scheduling.seedTask({ id: 't1', title: 'Instalación fibra' });

    const mirrorOrder = order({
      history: [
        { iclassOsStatusId: 'h1', occurredAt: null, statusCode: '4', statusDescription: 'Fechada', durationMinutes: null, teamLogin: null, commentary: 'técnico cerró la OS' },
        { iclassOsStatusId: 'h2', occurredAt: null, statusCode: '7', statusDescription: 'Concluida', durationMinutes: null, teamLogin: null, commentary: null },
      ],
      commentaryLog: 'log completo de la OS',
      internalNote: 'nota interna del operador',
      equipmentEvents: [
        { occurredAt: null, type: 'install', serialNumber: 'SN001', mac: 'AA:BB:CC', patrimonialNo: null, modelDescription: 'ONT ZTE' },
      ],
    });

    await uc.execute({ taskId: 't1', order: mirrorOrder });

    const ctx = auditor.lastContext!;
    expect(ctx.historyCommentary).toHaveLength(1);
    expect(ctx.historyCommentary[0].commentary).toBe('técnico cerró la OS');
    expect(ctx.commentaryLog).toBe('log completo de la OS');
    expect(ctx.internalNote).toBe('nota interna del operador');
    expect(ctx.equipmentEvents).toHaveLength(1);
    expect(ctx.equipmentEvents[0].model).toBe('ONT ZTE');
    expect(ctx.equipmentEvents[0].serialNumber).toBe('SN001');
  });
});
