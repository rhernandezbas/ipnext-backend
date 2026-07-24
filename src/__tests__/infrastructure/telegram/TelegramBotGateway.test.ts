import { TelegramBotGateway, buildAckCallbackData } from '@infrastructure/adapters/telegram/TelegramBotGateway';
import { TelegramGateway, TelegramInlineButton } from '@infrastructure/adapters/telegram/TelegramGateway';
import { NocAlert } from '@domain/entities/nocAlert';

function makeAlert(overrides: Partial<NocAlert> = {}): NocAlert {
  return {
    id: 'alert-1',
    source: 'grafana',
    fingerprint: 'fp-1',
    alertname: 'BGP peer down',
    severity: 'critical',
    status: 'firing',
    entityType: 'bgp_peer',
    entityName: 'peer-rda2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'BGP peer down para peer-rda2',
    explanation: null,
    link: null,
    startsAt: '2026-07-24T10:00:00.000Z',
    firstSeen: '2026-07-24T10:00:00.000Z',
    lastSeen: '2026-07-24T10:00:00.000Z',
    endsAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    acknowledged: false,
    ackBy: null,
    ackAt: null,
    ackNote: null,
    escalationState: null,
    telegramChatId: null,
    telegramMessageId: null,
    ...overrides,
  };
}

/** Fake TelegramGateway — no axios, no network, pure spy (molde TwilioContentGateway.test.ts). */
class FakeTelegramGateway implements TelegramGateway {
  sendMessageCalls: { chatId: string; text: string; buttons?: TelegramInlineButton[] }[] = [];
  editMessageTextCalls: { chatId: string; messageId: string; text: string; buttons?: TelegramInlineButton[] }[] = [];
  answerCallbackQueryCalls: { callbackQueryId: string; text?: string }[] = [];
  sendMessageResult: { chatId: string; messageId: string } = { chatId: 'chat-42', messageId: 'msg-99' };
  sendMessageError: Error | null = null;
  editMessageTextError: Error | null = null;

  async sendMessage(chatId: string, text: string, buttons?: TelegramInlineButton[]) {
    this.sendMessageCalls.push({ chatId, text, buttons });
    if (this.sendMessageError) throw this.sendMessageError;
    return this.sendMessageResult;
  }

  async editMessageText(chatId: string, messageId: string, text: string, buttons?: TelegramInlineButton[]) {
    this.editMessageTextCalls.push({ chatId, messageId, text, buttons });
    if (this.editMessageTextError) throw this.editMessageTextError;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    this.answerCallbackQueryCalls.push({ callbackQueryId, text });
  }
}

describe('TelegramBotGateway (implements AlertNotifier)', () => {
  it('notify() manda sendMessage con botón inline callback_data=ack:<id> y devuelve chatId/messageId', async () => {
    const gateway = new FakeTelegramGateway();
    const notifier = new TelegramBotGateway(gateway, 'noc-channel');
    const alert = makeAlert();

    const result = await notifier.notify(alert);

    expect(gateway.sendMessageCalls).toHaveLength(1);
    expect(gateway.sendMessageCalls[0]?.chatId).toBe('noc-channel');
    expect(gateway.sendMessageCalls[0]?.buttons).toEqual([{ text: '✋ Lo tomo', callback_data: 'ack:alert-1' }]);
    expect(gateway.sendMessageCalls[0]?.text).toContain('BGP peer down');
    expect(result).toEqual({ chatId: 'chat-42', messageId: 'msg-99' });
  });

  it('buildAckCallbackData produce el contrato exacto que el webhook parsea', () => {
    expect(buildAckCallbackData('abc-123')).toBe('ack:abc-123');
  });

  it('notify() best-effort: si el gateway tira, NO propaga — devuelve null', async () => {
    const gateway = new FakeTelegramGateway();
    gateway.sendMessageError = new Error('Telegram unreachable');
    const notifier = new TelegramBotGateway(gateway, 'noc-channel');

    await expect(notifier.notify(makeAlert())).resolves.toBeNull();
  });

  it('editAck() edita el mensaje existente usando telegramChatId/telegramMessageId de la alerta', async () => {
    const gateway = new FakeTelegramGateway();
    const notifier = new TelegramBotGateway(gateway, 'noc-channel');
    const alert = makeAlert({
      acknowledged: true,
      ackBy: 'juan.perez',
      ackAt: '2026-07-24T10:15:00.000Z',
      telegramChatId: 'chat-42',
      telegramMessageId: 'msg-99',
    });

    await notifier.editAck(alert);

    expect(gateway.editMessageTextCalls).toHaveLength(1);
    expect(gateway.editMessageTextCalls[0]?.chatId).toBe('chat-42');
    expect(gateway.editMessageTextCalls[0]?.messageId).toBe('msg-99');
    expect(gateway.editMessageTextCalls[0]?.text).toContain('Tomado por juan.perez');
  });

  it('editAck() sin telegramChatId/telegramMessageId → NO llama al gateway (defensivo)', async () => {
    const gateway = new FakeTelegramGateway();
    const notifier = new TelegramBotGateway(gateway, 'noc-channel');

    await notifier.editAck(makeAlert());

    expect(gateway.editMessageTextCalls).toHaveLength(0);
  });

  it('editAck() best-effort: si el gateway tira, NO propaga', async () => {
    const gateway = new FakeTelegramGateway();
    gateway.editMessageTextError = new Error('Telegram unreachable');
    const notifier = new TelegramBotGateway(gateway, 'noc-channel');
    const alert = makeAlert({ telegramChatId: 'chat-42', telegramMessageId: 'msg-99' });

    await expect(notifier.editAck(alert)).resolves.toBeUndefined();
  });
});
