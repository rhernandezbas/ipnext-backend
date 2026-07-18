/**
 * N3 (network-task-broadcast) — BroadcastTaskToNoc: looks up a scheduled task,
 * enforces it is a network task (kind='network'), resolves the node name as the
 * contextLabel, and delegates to the N1 engine (BroadcastToNoc). NOT best-effort:
 * it is user-triggered (a button), so engine errors propagate.
 */
import { BroadcastTaskToNoc } from '@application/use-cases/nocBroadcast/BroadcastTaskToNoc';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  TaskNotBroadcastableError,
  NocBroadcastNotConfiguredError,
  EvolutionApiError,
} from '@domain/errors/nocBroadcast';

const BASE = 'http://190.7.234.37:7778';

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

async function build() {
  const repo = new InMemorySchedulingRepository();
  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl: BASE });
  const gateway = new FakeGateway();
  const engine = new BroadcastToNoc(config, gateway);
  const uc = new BroadcastTaskToNoc(repo, engine);
  return { repo, config, gateway, uc };
}

describe('BroadcastTaskToNoc', () => {
  it('red network task with a resolved node name → network_task with contextLabel = node + deep link /admin/scheduling/tasks/:id', async () => {
    const { repo, gateway, uc } = await build();
    // networkSiteName is JOIN-derived (red) / stored (fibra); getTask returns it resolved.
    repo.seedTask({ id: 'net-1', kind: 'network', networkType: 'red', networkSiteName: 'Nodo Agote', title: 'Revisar OLT saturada' });

    const result = await uc.execute('net-1');

    expect(result).toEqual({ sent: true, link: `${BASE}/admin/scheduling/tasks/net-1` });
    expect(gateway.sent).toEqual([
      `📧 [Red · Nodo Agote] Revisar OLT saturada\n🔗 ${BASE}/admin/scheduling/tasks/net-1`,
    ]);
  });

  it('fibra network task carries its stored node name as contextLabel', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-fo', kind: 'network', networkType: 'fibra', networkSiteName: 'Nodo Norte', title: 'Empalme troncal' });

    await uc.execute('net-fo');

    expect(gateway.sent[0]).toBe(`📧 [Red · Nodo Norte] Empalme troncal\n🔗 ${BASE}/admin/scheduling/tasks/net-fo`);
  });

  it('network task WITHOUT a node → contextLabel absent → "[Red]"', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-2', kind: 'network', networkType: 'red', networkSiteName: null, title: 'Tarea sin nodo' });

    const result = await uc.execute('net-2');

    expect(result.link).toBe(`${BASE}/admin/scheduling/tasks/net-2`);
    expect(gateway.sent[0]).toBe(`📧 [Red] Tarea sin nodo\n🔗 ${BASE}/admin/scheduling/tasks/net-2`);
  });

  it('customer task → TaskNotBroadcastableError, gateway never called', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'cust-1', kind: 'customer', title: 'Visita cliente' });

    await expect(uc.execute('cust-1')).rejects.toBeInstanceOf(TaskNotBroadcastableError);
    expect(gateway.sent).toHaveLength(0);
  });

  it('missing task → TaskNotFoundError, gateway never called', async () => {
    const { gateway, uc } = await build();
    await expect(uc.execute('does-not-exist')).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(gateway.sent).toHaveLength(0);
  });

  it('propagates NocBroadcastNotConfiguredError from the engine (source of the 503)', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-3', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new NocBroadcastNotConfiguredError();
    await expect(uc.execute('net-3')).rejects.toBeInstanceOf(NocBroadcastNotConfiguredError);
  });

  it('propagates EvolutionApiError from the engine (source of the 502)', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-4', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new EvolutionApiError('connect ECONNREFUSED');
    await expect(uc.execute('net-4')).rejects.toBeInstanceOf(EvolutionApiError);
  });
});
