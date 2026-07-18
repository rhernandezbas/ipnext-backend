import axios from 'axios';
import {
  NocBroadcastConfigRepository,
  isNocBroadcastConfigured,
} from '@domain/ports/NocBroadcastConfigRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NocBroadcastNotConfiguredError, EvolutionApiError } from '@domain/errors/nocBroadcast';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface EvolutionApiPostConfig {
  headers: Record<string, string>;
  timeout: number;
}

/**
 * Injectable POST transport (molde `HttpChatwootGateway.rawGet`). Kept as a bare
 * function — NOT an axios instance baked in the ctor — because the base URL is read
 * from the config AT CALL TIME, so there is nothing static to `axios.create` with.
 * Default = bare `axios.post`. Tests inject a fake and assert url/headers/body.
 */
export type EvolutionApiTransport = (
  url: string,
  body: unknown,
  config: EvolutionApiPostConfig,
) => Promise<{ status: number; data: unknown }>;

export interface EvolutionApiHttpGatewayOptions {
  configRepo: NocBroadcastConfigRepository;
  post?: EvolutionApiTransport;
  timeoutMs?: number;
}

/**
 * N1 (noc-broadcast) — HTTP client of the self-hosted Evolution API instance
 * ("ronald noc" on a Raspberry Pi).
 *
 * REGLA DURA de desarrollo: este adapter se ejercita SOLO con un transport fake —
 * JAMÁS contra la instancia viva del Pi. La verificación en vivo la decide el
 * usuario en el primer test real.
 *
 * Contract:
 *  - Config is read AT CALL TIME (edited at runtime via PUT /config), never cached
 *    in the ctor.
 *  - `!isNocBroadcastConfigured` → `NocBroadcastNotConfiguredError` BEFORE touching
 *    the network (patrón opt-in `SMARTOLT_NOT_CONFIGURED`).
 *  - Request (Evolution API v2 estándar — VERIFICAR contra la instancia real en el
 *    primer test en vivo): `POST {baseUrl}/message/sendText/{instance}`, header
 *    `apikey: {apiKey}`, body `{ number: targetChat, text }`.
 *  - Any transport failure (network/timeout/4xx/5xx, or a non-2xx status from a
 *    non-throwing transport) → `EvolutionApiError`.
 */
export class EvolutionApiHttpGateway implements NocBroadcastGateway {
  private readonly configRepo: NocBroadcastConfigRepository;
  private readonly post: EvolutionApiTransport;
  private readonly timeoutMs: number;

  constructor(opts: EvolutionApiHttpGatewayOptions) {
    this.configRepo = opts.configRepo;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.post =
      opts.post ??
      ((url, body, config) => axios.post(url, body, config));
  }

  async sendText(text: string): Promise<void> {
    const cfg = await this.configRepo.get();
    if (!isNocBroadcastConfigured(cfg)) {
      throw new NocBroadcastNotConfiguredError();
    }

    const url = `${cfg.evolutionBaseUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(
      cfg.evolutionInstance,
    )}`;

    try {
      const res = await this.post(
        url,
        { number: cfg.targetChat, text },
        {
          headers: { apikey: cfg.evolutionApiKey, 'Content-Type': 'application/json' },
          timeout: this.timeoutMs,
        },
      );
      // axios throws on 4xx/5xx by default; this guards a transport configured
      // with a permissive `validateStatus` (defence in depth).
      if (res.status >= 400) {
        throw new EvolutionApiError(`Evolution API respondió con status ${res.status}`);
      }
    } catch (err) {
      if (err instanceof EvolutionApiError) throw err;
      throw new EvolutionApiError(err instanceof Error ? err.message : String(err));
    }
  }
}
