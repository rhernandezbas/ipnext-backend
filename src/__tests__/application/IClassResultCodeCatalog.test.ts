import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { SyncIClassResultCodes } from '@application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '@application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '@application/use-cases/AssignResultCodeStage';
import { IClassResultCodeNotFoundError } from '@domain/errors/iclass';
import { StageNotFoundError } from '@domain/errors/scheduling';
import { IClassPort, IClassResultCodeDescriptor } from '@domain/ports/IClassPort';
import { StageRepository } from '@domain/ports/StageRepository';
import { Stage } from '@domain/entities/workflow';

function fakeIClass(codes: IClassResultCodeDescriptor[]): IClassPort {
  return { listResultCodes: async () => codes } as unknown as IClassPort;
}

function fakeStages(known: Record<string, Stage>): StageRepository {
  return { getById: async (id: string) => known[id] ?? null } as unknown as StageRepository;
}

const STAGE: Stage = { id: 'stage-instalado', workflowId: 'wf', name: 'Instalado', category: 'hecho', order: 8, color: null };

describe('IClass result-code catalog', () => {
  describe('SyncIClassResultCodes', () => {
    it('upserts result codes from IClass and counts created/updated', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      const iclass = fakeIClass([
        { soTypeId: '37092709', code: 'Instalacion Completa Wireless', type: 'Sucesso' },
        { soTypeId: '37092709', code: 'Cliente Ausente', type: 'Falha' },
      ]);
      const first = await new SyncIClassResultCodes(iclass, repo).execute();
      expect(first).toEqual({ synced: 2, created: 2, updated: 0 });

      const second = await new SyncIClassResultCodes(iclass, repo).execute();
      expect(second).toEqual({ synced: 2, created: 0, updated: 2 });
    });

    it('preserves an existing closure mapping across a re-sync', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      const iclass = fakeIClass([{ soTypeId: '1', code: 'OK', type: 'Sucesso' }]);
      await new SyncIClassResultCodes(iclass, repo).execute();
      const rc = (await repo.list())[0];
      await repo.assignStage(rc.id, 'stage-x');
      // re-sync must NOT wipe the mapping
      await new SyncIClassResultCodes(iclass, repo).execute();
      const after = await repo.findByCode('OK');
      expect(after!.mappedStageId).toBe('stage-x');
    });
  });

  describe('ListIClassResultCodes', () => {
    it('filters to mapped entries', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      await repo.upsert({ soTypeId: '1', code: 'A', type: 'Sucesso' });
      await repo.upsert({ soTypeId: '1', code: 'B', type: 'Falha' });
      const a = await repo.findByCode('A');
      await repo.assignStage(a!.id, 'stage-1');

      const mapped = await new ListIClassResultCodes(repo).execute({ mapped: true });
      expect(mapped.map(r => r.code)).toEqual(['A']);
      const unmapped = await new ListIClassResultCodes(repo).execute({ mapped: false });
      expect(unmapped.map(r => r.code)).toEqual(['B']);
    });
  });

  describe('AssignResultCodeStage', () => {
    it('assigns a stage when both exist', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      await repo.upsert({ soTypeId: '1', code: 'OK', type: 'Sucesso' });
      const rc = (await repo.list())[0];
      const uc = new AssignResultCodeStage(repo, fakeStages({ [STAGE.id]: STAGE }));
      const updated = await uc.execute(rc.id, STAGE.id);
      expect(updated.mappedStageId).toBe(STAGE.id);
    });

    it('clears the mapping with null (no stage lookup)', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      await repo.upsert({ soTypeId: '1', code: 'OK', type: 'Sucesso' });
      const rc = (await repo.list())[0];
      await repo.assignStage(rc.id, STAGE.id);
      const uc = new AssignResultCodeStage(repo, fakeStages({}));
      const updated = await uc.execute(rc.id, null);
      expect(updated.mappedStageId).toBeNull();
    });

    it('throws StageNotFoundError for a ghost stage', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      await repo.upsert({ soTypeId: '1', code: 'OK', type: 'Sucesso' });
      const rc = (await repo.list())[0];
      const uc = new AssignResultCodeStage(repo, fakeStages({}));
      await expect(uc.execute(rc.id, 'ghost')).rejects.toBeInstanceOf(StageNotFoundError);
    });

    it('throws IClassResultCodeNotFoundError for a ghost result code', async () => {
      const repo = new InMemoryIClassResultCodeRepository();
      const uc = new AssignResultCodeStage(repo, fakeStages({ [STAGE.id]: STAGE }));
      await expect(uc.execute('ghost', STAGE.id)).rejects.toBeInstanceOf(IClassResultCodeNotFoundError);
    });
  });
});
