import axios, { AxiosInstance } from 'axios';
import https from 'https';
import type { UispClient as IUispClient } from '@domain/ports/UispClient';
import type { UispSite, UispDevice } from '@domain/entities/uisp';
import { UispUnavailableError } from '@domain/errors/uisp';

export interface UispClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Injectable HTTP client for deterministic tests (avoids real network calls). */
  http?: AxiosInstance;
}

/** Minimal check for axios-like transport errors. */
function isAxiosLikeError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
}

/** Map raw UISP /sites item → UispSite domain entity. */
function mapSite(raw: Record<string, unknown>): UispSite {
  const identification = (raw['identification'] ?? {}) as Record<string, unknown>;
  const description = (raw['description'] ?? {}) as Record<string, unknown>;
  const location = (description['location'] ?? {}) as Record<string, unknown>;
  const contact = (description['contact'] ?? null) as Record<string, unknown> | null;
  const parent = (identification['parent'] ?? null) as Record<string, unknown> | null;

  const rawAddress = (description['address'] as string | null | undefined) ?? null;
  const trimmedAddress = rawAddress != null ? rawAddress.trim() : null;
  const address = trimmedAddress && trimmedAddress.length > 0 ? trimmedAddress : null;

  const now = new Date();
  return {
    id: '',  // filled by repository on upsert
    uispId: (identification['id'] as string) ?? '',
    name: (identification['name'] as string) ?? '',
    status: (identification['status'] as string) ?? 'unknown',
    parentUispId: parent ? (parent['id'] as string) ?? null : null,
    latitude: location['latitude'] != null ? (location['latitude'] as number) : null,
    longitude: location['longitude'] != null ? (location['longitude'] as number) : null,
    deviceCount: (description['deviceCount'] as number) ?? 0,
    outageCount: (description['deviceOutageCount'] as number) ?? 0,
    contact: contact ? (contact['name'] as string) ?? null : null,
    address,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Map raw UISP /devices item → UispDevice domain entity. */
function mapDevice(raw: Record<string, unknown>): UispDevice {
  const identification = (raw['identification'] ?? {}) as Record<string, unknown>;
  const overview = (raw['overview'] ?? {}) as Record<string, unknown>;
  const site = (identification['site'] ?? null) as Record<string, unknown> | null;

  const uptimeRaw = overview['uptime'];
  const uptime: bigint | null = uptimeRaw != null ? BigInt(uptimeRaw as number) : null;

  const lastSeen = overview['lastSeen'];
  const lastSeenAt: Date | null = lastSeen != null ? new Date(lastSeen as string) : null;

  // contract-node-ap-auto-assign (MIR-1): station→AP link, same payload as /devices — no
  // extra UISP call. Null-safe: attributes/apDevice/id may each be absent (routers, APs
  // themselves, or the ~1.2% of stations without a reported AP).
  const attributes = (raw['attributes'] ?? {}) as Record<string, unknown>;
  const apDevice = (attributes['apDevice'] ?? null) as Record<string, unknown> | null;
  const apUispDeviceId: string | null = apDevice ? ((apDevice['id'] as string) ?? null) : null;

  const now = new Date();
  return {
    id: '',  // filled by repository on upsert
    uispId: (identification['id'] as string) ?? '',
    // ipAddress is a TOP-LEVEL field in the UISP /devices response, NOT in overview
    uispSiteId: site ? (site['id'] as string) ?? '' : '',
    name: (identification['name'] as string) ?? '',
    model: (identification['model'] as string) ?? '',
    modelName: (identification['modelName'] as string) ?? null,
    type: (identification['type'] as string) ?? null,
    role: (identification['role'] as string) ?? null,
    mac: (identification['mac'] as string) ?? null,
    ip: (raw['ipAddress'] as string) ?? null,
    firmware: (identification['firmwareVersion'] as string) ?? null,
    status: (overview['status'] as string) ?? 'unknown',
    signal: overview['signal'] != null ? (overview['signal'] as number) : null,
    uptime,
    lastSeenAt,
    missingSince: null,
    apUispDeviceId,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * UISP API client adapter.
 *
 * Uses axios with:
 * - x-auth-token header for authentication
 * - timeout 30s
 * - httpsAgent rejectUnauthorized: false — the UISP NMS uses a self-signed
 *   internal certificate. This is intentional and NOT a security issue for
 *   traffic on the private ISP network. Never expose this client to public endpoints.
 *
 * Transport errors → UispUnavailableError.
 */
export class UispClient implements IUispClient {
  private readonly http: AxiosInstance;

  constructor(private readonly opts: UispClientOptions) {
    this.http = opts.http ?? axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs ?? 30000,
      headers: {
        'x-auth-token': opts.token,
      },
      // Self-signed internal cert — intentional, NOT a security issue for private infra.
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }

  async listSites(): Promise<UispSite[]> {
    try {
      const response = await this.http.get<unknown[]>('/sites');
      const items = Array.isArray(response.data) ? response.data : [];
      return items.map(item => mapSite(item as Record<string, unknown>));
    } catch (err) {
      if (isAxiosLikeError(err)) {
        throw new UispUnavailableError(`UISP /sites failed: ${(err as Error).message}`);
      }
      throw new UispUnavailableError(`UISP /sites failed: ${String(err)}`);
    }
  }

  async listDevices(): Promise<UispDevice[]> {
    try {
      const response = await this.http.get<unknown[]>('/devices');
      const items = Array.isArray(response.data) ? response.data : [];
      return items.map(item => mapDevice(item as Record<string, unknown>));
    } catch (err) {
      if (isAxiosLikeError(err)) {
        throw new UispUnavailableError(`UISP /devices failed: ${(err as Error).message}`);
      }
      throw new UispUnavailableError(`UISP /devices failed: ${String(err)}`);
    }
  }
}
