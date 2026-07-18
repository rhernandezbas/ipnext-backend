import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';

/** Fixed probe message the /test endpoint pushes so the operator can validate the config. */
export const NOC_BROADCAST_TEST_MESSAGE = '✅ Prueba de Difusión NOC — conexión OK';

export interface SendNocBroadcastTestResult {
  ok: boolean;
}

/**
 * N1 (noc-broadcast) — sends the fixed probe message to the "noc lider" channel so
 * the operator can confirm the Evolution config works WITHOUT depending on a real
 * news/task. Errors propagate (gateway throws typed errors mapped to 503/502).
 */
export class SendNocBroadcastTest {
  constructor(private readonly gateway: NocBroadcastGateway) {}

  async execute(): Promise<SendNocBroadcastTestResult> {
    await this.gateway.sendText(NOC_BROADCAST_TEST_MESSAGE);
    return { ok: true };
  }
}
