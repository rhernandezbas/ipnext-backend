import axios, { AxiosInstance } from 'axios';

/** Telegram Bot API inline keyboard button (single row of one button, our only use). */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/**
 * TelegramGateway — Fase D (`noc-alert-telegram`) raw Telegram Bot API wrapper,
 * DELIBERATELY narrower/lower-level than the `AlertNotifier` domain port: it
 * knows about `sendMessage`/`editMessageText`/`answerCallbackQuery`, nothing
 * about `NocAlert`. `TelegramBotGateway` (implements `AlertNotifier`) is
 * injected with ONE of these — real (`HttpTelegramGateway`) in prod, a fake in
 * tests — so its own tests never touch axios/the network (same two-layer shape
 * the task asked for: "gateway HTTP de Telegram inyectable").
 */
export interface TelegramGateway {
  /** POST sendMessage. Returns the Telegram `chat.id`/`message_id` (both stringified — they
   *  round-trip through `NocAlert.telegramChatId`/`telegramMessageId`, which are `string`). */
  sendMessage(
    chatId: string,
    text: string,
    buttons?: TelegramInlineButton[],
  ): Promise<{ chatId: string; messageId: string }>;
  /** POST editMessageText over an existing message. */
  editMessageText(chatId: string, messageId: string, text: string, buttons?: TelegramInlineButton[]): Promise<void>;
  /** POST answerCallbackQuery — stops Telegram's client-side "loading" spinner on the button. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface HttpTelegramGatewayOptions {
  /** Bot token (`123456:ABC-DEF...`), from `config.alerts.telegramBotToken`. */
  botToken: string;
  /** Default `https://api.telegram.org` — overridable for tests, never needed in prod. */
  baseUrl?: string;
  /** Inyectable para tests — SIN axios/red real (regla TDD del repo, molde TwilioContentGateway). */
  http?: AxiosInstance;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Raw Telegram Bot API `Message` shape (only the fields this adapter needs). */
interface TelegramApiMessage {
  message_id: number;
  chat: { id: number | string };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * HttpTelegramGateway — real adapter against `api.telegram.org`. Same
 * axios-injectable ctor pattern as `TwilioContentGateway`/`HttpChatwootGateway`
 * (`axios.create({timeout})` internally when `http` isn't provided).
 */
export class HttpTelegramGateway implements TelegramGateway {
  private readonly http: AxiosInstance;
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpTelegramGatewayOptions) {
    this.botToken = opts.botToken;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.http = opts.http ?? axios.create({ timeout: this.timeoutMs });
  }

  private apiUrl(method: string): string {
    return `${this.baseUrl}/bot${this.botToken}/${method}`;
  }

  private static replyMarkup(buttons?: TelegramInlineButton[]): { inline_keyboard: TelegramInlineButton[][] } {
    return { inline_keyboard: buttons && buttons.length > 0 ? [buttons] : [] };
  }

  async sendMessage(
    chatId: string,
    text: string,
    buttons?: TelegramInlineButton[],
  ): Promise<{ chatId: string; messageId: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (buttons && buttons.length > 0) body['reply_markup'] = HttpTelegramGateway.replyMarkup(buttons);

    const response = await this.http.post<TelegramApiResponse<TelegramApiMessage>>(
      this.apiUrl('sendMessage'),
      body,
      { timeout: this.timeoutMs },
    );
    const result = response.data?.result;
    if (!result) {
      throw new Error(`Telegram sendMessage sin result: ${response.data?.description ?? 'respuesta inesperada'}`);
    }
    return { chatId: String(result.chat.id), messageId: String(result.message_id) };
  }

  async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    buttons?: TelegramInlineButton[],
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      reply_markup: HttpTelegramGateway.replyMarkup(buttons),
    };
    await this.http.post(this.apiUrl('editMessageText'), body, { timeout: this.timeoutMs });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body['text'] = text;
    await this.http.post(this.apiUrl('answerCallbackQuery'), body, { timeout: this.timeoutMs });
  }
}
