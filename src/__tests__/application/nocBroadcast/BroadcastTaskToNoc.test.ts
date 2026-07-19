/**
 * N3 (network-task-broadcast) — BroadcastTaskToNoc: looks up a scheduled task,
 * enforces it is a network task (kind='network'), resolves the node name as the
 * contextLabel, and delegates to the N1 engine (BroadcastToNoc). NOT best-effort:
 * it is user-triggered (a button), so engine errors propagate.
 *
 * noc-broadcast-traceability — tras un envío exitoso deja rastro: estampa
 * lastBroadcastAt/lastBroadcastByName en la tarea Y registra un evento
 * 'noc_broadcast_sent' en el feed vía el recorder (opcional). En el path de error
 * (engine throws) NO se estampa NI registra nada.
 */
import { BroadcastTaskToNoc } from '@application/use-cases/nocBroadcast/BroadcastTaskToNoc';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { ActorContext, TaskActivityRecorder } from '@domain/ports/TaskActivityRecorder';
import type { ActivityType } from '@domain/entities/taskActivity';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  TaskNotBroadcastableError,
  NocBroadcastNotConfiguredError,
  EvolutionApiError,
} from '@domain/errors/nocBroadcast';

const BASE = 'http://190.7.234.37:7778';
const ACTOR: ActorContext = { actorId: 'admin-1', actorName: 'Tino' };

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

interface RecordedEvent {
  taskId: string;
  type: ActivityType;
  actor: ActorContext;
  metadata: Record<string, unknown> | null | undefined;
}

class FakeRecorder implements TaskActivityRecorder {
  events: RecordedEvent[] = [];
  async record(
    taskId: string,
    type: ActivityType,
    payload: { actor: ActorContext; fromValue?: unknown; toValue?: unknown; metadata?: Record<string, unknown> | null },
  ): Promise<void> {
    this.events.push({ taskId, type, actor: payload.actor, metadata: payload.metadata });
  }
  async recordMany(): Promise<void> {
    // not used by this use case
  }
}

async function build() {
  const repo = new InMemorySchedulingRepository();
  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl: BASE });
  const gateway = new FakeGateway();
  const engine = new BroadcastToNoc(config, gateway);
  const recorder = new FakeRecorder();
  const uc = new BroadcastTaskToNoc(repo, engine, recorder);
  return { repo, config, gateway, recorder, uc };
}

describe('BroadcastTaskToNoc', () => {
  it('red network task with a resolved node name → network_task with contextLabel = node + deep link /admin/scheduling/tasks/:id', async () => {
    const { repo, gateway, uc } = await build();
    // networkSiteName is JOIN-derived (red) / stored (fibra); getTask returns it resolved.
    repo.seedTask({ id: 'net-1', kind: 'network', networkType: 'red', networkSiteName: 'Nodo Agote', title: 'Revisar OLT saturada' });

    const result = await uc.execute('net-1', ACTOR);

    expect(result).toEqual({ sent: true, link: `${BASE}/admin/scheduling/tasks/net-1` });
    expect(gateway.sent).toEqual([
      `📧 [Red · Nodo Agote] Revisar OLT saturada\n🔗 ${BASE}/admin/scheduling/tasks/net-1`,
    ]);
  });

  it('fibra network task carries its stored node name as contextLabel', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-fo', kind: 'network', networkType: 'fibra', networkSiteName: 'Nodo Norte', title: 'Empalme troncal' });

    await uc.execute('net-fo', ACTOR);

    expect(gateway.sent[0]).toBe(`📧 [Red · Nodo Norte] Empalme troncal\n🔗 ${BASE}/admin/scheduling/tasks/net-fo`);
  });

  it('network task WITHOUT a node → contextLabel absent → "[Red]"', async () => {
    const { repo, gateway, uc } = await build();
    repo.seedTask({ id: 'net-2', kind: 'network', networkType: 'red', networkSiteName: null, title: 'Tarea sin nodo' });

    const result = await uc.execute('net-2', ACTOR);

    expect(result.link).toBe(`${BASE}/admin/scheduling/tasks/net-2`);
    expect(gateway.sent[0]).toBe(`📧 [Red] Tarea sin nodo\n🔗 ${BASE}/admin/scheduling/tasks/net-2`);
  });

  // ── noc-broadcast-traceability ────────────────────────────────────────────

  it('tras un envío exitoso: estampa lastBroadcastAt/lastBroadcastByName Y registra noc_broadcast_sent con actor + metadata.link', async () => {
    const { repo, recorder, uc } = await build();
    repo.seedTask({ id: 'net-tr', kind: 'network', networkType: 'red', networkSiteName: 'Nodo Agote', title: 'X' });

    const result = await uc.execute('net-tr', ACTOR);

    // 1. Badge: la tarea quedó estampada con el actor.
    const task = await repo.getTask('net-tr');
    expect(task!.lastBroadcastAt).not.toBeNull();
    expect(task!.lastBroadcastByName).toBe('Tino');

    // 2. Feed: un único evento noc_broadcast_sent con el actor y el link.
    expect(recorder.events).toEqual([
      { taskId: 'net-tr', type: 'noc_broadcast_sent', actor: ACTOR, metadata: { link: result.link } },
    ]);
  });

  it('sin recorder inyectado (opcional) igual estampa el badge y no rompe', async () => {
    const repo = new InMemorySchedulingRepository();
    const config = new InMemoryNocBroadcastConfigRepository();
    await config.update({ appPublicUrl: BASE });
    const engine = new BroadcastToNoc(config, new FakeGateway());
    const uc = new BroadcastTaskToNoc(repo, engine); // 3er arg omitido
    repo.seedTask({ id: 'net-nr', kind: 'network', networkType: 'red', title: 'X' });

    await uc.execute('net-nr', ACTOR);

    const task = await repo.getTask('net-nr');
    expect(task!.lastBroadcastByName).toBe('Tino');
  });

  it('customer task → TaskNotBroadcastableError, gateway never called, NO estampa NI registra', async () => {
    const { repo, gateway, recorder, uc } = await build();
    repo.seedTask({ id: 'cust-1', kind: 'customer', title: 'Visita cliente' });

    await expect(uc.execute('cust-1', ACTOR)).rejects.toBeInstanceOf(TaskNotBroadcastableError);
    expect(gateway.sent).toHaveLength(0);
    const task = await repo.getTask('cust-1');
    expect(task!.lastBroadcastAt).toBeNull();
    expect(recorder.events).toHaveLength(0);
  });

  it('missing task → TaskNotFoundError, gateway never called', async () => {
    const { gateway, recorder, uc } = await build();
    await expect(uc.execute('does-not-exist', ACTOR)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(gateway.sent).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('propagates NocBroadcastNotConfiguredError from the engine (503) y NO estampa NI registra', async () => {
    const { repo, gateway, recorder, uc } = await build();
    repo.seedTask({ id: 'net-3', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new NocBroadcastNotConfiguredError();
    await expect(uc.execute('net-3', ACTOR)).rejects.toBeInstanceOf(NocBroadcastNotConfiguredError);
    const task = await repo.getTask('net-3');
    expect(task!.lastBroadcastAt).toBeNull();
    expect(task!.lastBroadcastByName).toBeNull();
    expect(recorder.events).toHaveLength(0);
  });

  it('propagates EvolutionApiError from the engine (502) y NO estampa NI registra', async () => {
    const { repo, gateway, recorder, uc } = await build();
    repo.seedTask({ id: 'net-4', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new EvolutionApiError('connect ECONNREFUSED');
    await expect(uc.execute('net-4', ACTOR)).rejects.toBeInstanceOf(EvolutionApiError);
    const task = await repo.getTask('net-4');
    expect(task!.lastBroadcastAt).toBeNull();
    expect(recorder.events).toHaveLength(0);
  });
});
