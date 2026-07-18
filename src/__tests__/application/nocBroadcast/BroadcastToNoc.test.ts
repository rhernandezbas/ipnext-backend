/**
 * N1 (noc-broadcast) — BroadcastToNoc: composes the WhatsApp text per kind, builds
 * the deep link from appPublicUrl + relativePath, and delegates to the gateway.
 * NOT best-effort: it is user-triggered (a button), so gateway errors propagate.
 */
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import {
  NocBroadcastLinkBaseMissingError,
  NocBroadcastNotConfiguredError,
} from '@domain/errors/nocBroadcast';

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

async function build(appPublicUrl = 'http://190.7.234.37:7778') {
  const config = new InMemoryNocBroadcastConfigRepository();
  if (appPublicUrl !== '') await config.update({ appPublicUrl });
  const gateway = new FakeGateway();
  const uc = new BroadcastToNoc(config, gateway);
  return { config, gateway, uc };
}

describe('BroadcastToNoc', () => {
  it('news → "📢 {title}\\n🔗 {link}" and returns { sent, link }', async () => {
    const { gateway, uc } = await build();
    const result = await uc.execute({ kind: 'news', title: 'Corte programado Zona Norte', relativePath: '/news/42' });

    expect(result).toEqual({ sent: true, link: 'http://190.7.234.37:7778/news/42' });
    expect(gateway.sent).toEqual(['📢 Corte programado Zona Norte\n🔗 http://190.7.234.37:7778/news/42']);
  });

  it('network_task WITH contextLabel → "📧 [Red · {label}] {title}\\n🔗 {link}"', async () => {
    const { gateway, uc } = await build();
    const result = await uc.execute({
      kind: 'network_task',
      title: 'Revisar OLT saturada',
      contextLabel: 'Nodo Agote',
      relativePath: '/scheduling/task/7',
    });

    expect(result.link).toBe('http://190.7.234.37:7778/scheduling/task/7');
    expect(gateway.sent).toEqual([
      '📧 [Red · Nodo Agote] Revisar OLT saturada\n🔗 http://190.7.234.37:7778/scheduling/task/7',
    ]);
  });

  it('network_task WITHOUT contextLabel → "📧 [Red] {title}\\n🔗 {link}"', async () => {
    const { gateway, uc } = await build();
    await uc.execute({ kind: 'network_task', title: 'Tarea sin nodo', relativePath: '/scheduling/task/9' });
    expect(gateway.sent[0]).toBe('📧 [Red] Tarea sin nodo\n🔗 http://190.7.234.37:7778/scheduling/task/9');
  });

  it('network_task with a blank contextLabel is treated as absent → "[Red]"', async () => {
    const { gateway, uc } = await build();
    await uc.execute({ kind: 'network_task', title: 'X', contextLabel: '   ', relativePath: '/t/1' });
    expect(gateway.sent[0]).toBe('📧 [Red] X\n🔗 http://190.7.234.37:7778/t/1');
  });

  it('collapses a trailing slash on appPublicUrl against the leading slash of relativePath', async () => {
    const { gateway, uc } = await build('http://190.7.234.37:7778/');
    await uc.execute({ kind: 'news', title: 'T', relativePath: '/news/1' });
    expect(gateway.sent[0]).toContain('http://190.7.234.37:7778/news/1');
    expect(gateway.sent[0]).not.toContain('7778//news');
  });

  it('empty appPublicUrl → NocBroadcastLinkBaseMissingError, gateway never called', async () => {
    const { gateway, uc } = await build('');
    await expect(uc.execute({ kind: 'news', title: 'T', relativePath: '/news/1' })).rejects.toBeInstanceOf(
      NocBroadcastLinkBaseMissingError,
    );
    expect(gateway.sent).toHaveLength(0);
  });

  it('propagates the gateway error when the broadcast is not configured', async () => {
    const { gateway, uc } = await build();
    gateway.error = new NocBroadcastNotConfiguredError();
    await expect(uc.execute({ kind: 'news', title: 'T', relativePath: '/news/1' })).rejects.toBeInstanceOf(
      NocBroadcastNotConfiguredError,
    );
  });
});
