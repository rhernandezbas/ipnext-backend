import { NocAlert } from '@domain/entities/nocAlert';
import { AlertNotifier } from '@domain/ports/AlertNotifier';

/**
 * NoOpAlertNotifier — spy-able fake for "dark ingestion" tests (spec.md "Dark
 * ingestion — no outbound side-effects"). No Fase A use-case calls this — its
 * only job in tests is to prove `.notify`/`.editAck` are NEVER invoked.
 */
export class NoOpAlertNotifier implements AlertNotifier {
  notifyCalls: NocAlert[] = [];
  editAckCalls: NocAlert[] = [];

  async notify(alert: NocAlert): Promise<{ chatId: string; messageId: string } | null> {
    this.notifyCalls.push(alert);
    return null;
  }

  async editAck(alert: NocAlert): Promise<void> {
    this.editAckCalls.push(alert);
  }
}
