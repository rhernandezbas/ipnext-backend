import { z } from 'zod';
import type { WifiBandStatus } from '@domain/services/mapWifiPortsToBands';
import type { RouterHost } from '@domain/ports/WifiManagementPort';
import type { WifiEligibilityReason } from '@domain/errors/wifi';

// ── Portal ────────────────────────────────────────────────────────────────

export type PortalWifiStatusDto =
  | { eligible: false; reason: WifiEligibilityReason }
  | {
      eligible: true;
      bands: Array<{ band: '2.4' | '5'; ssid: string | null }>;
      /** Hosts con `active=true`. `null` si el fetch de hosts falló — nunca rompe la pantalla por el contador. */
      connectedCount: number | null;
    };

/** `PUT /api/portal/wifi/:contractId` — validación de FORMA (ssid/password los revisa `validateWifiCredentials`, ver use case). */
export const UpdatePortalWifiBandSchema = z
  .object({
    band: z.enum(['2.4', '5']),
    ssid: z.string(),
    password: z.string(),
  })
  .strict();

export type UpdatePortalWifiBandBody = z.infer<typeof UpdatePortalWifiBandSchema>;

export interface PortalWifiDeviceDto {
  name: string | null;
  interface: 'wifi' | 'ethernet';
  active: boolean;
}

/** portal — SIN ip/mac (menos superficie para la app del cliente). */
export function toPortalWifiDeviceDto(host: RouterHost): PortalWifiDeviceDto {
  return { name: host.hostName, interface: host.interfaceType, active: host.active };
}

// ── Admin ─────────────────────────────────────────────────────────────────

export interface AdminWifiDeviceDto {
  name: string | null;
  ip: string | null;
  mac: string | null;
  interface: 'wifi' | 'ethernet';
  active: boolean;
  vendor: string | null;
}

/** admin — CON ip/mac (staff sí, ver WifiManagementPort). */
export function toAdminWifiDeviceDto(host: RouterHost): AdminWifiDeviceDto {
  return { name: host.hostName, ip: host.ip, mac: host.mac, interface: host.interfaceType, active: host.active, vendor: host.vendor };
}

export interface AdminOnuWifiStatusDto {
  sn: string;
  found: boolean;
  onuType: string | null;
  online: boolean;
  tr069Enabled: boolean;
  bands: WifiBandStatus[];
  hosts: AdminWifiDeviceDto[];
}

/** `PUT /api/wifi/onu/:serial/band` — admin acepta CUALQUIER puerto explícito. */
export const SetAdminWifiBandSchema = z
  .object({
    port: z.string(),
    ssid: z.string(),
    password: z.string(),
  })
  .strict();

export type SetAdminWifiBandBody = z.infer<typeof SetAdminWifiBandSchema>;

/**
 * `POST /api/wifi/onu/:serial/enable-tr069` — `vlan` SIN default (regla del
 * proposal: "SIN default: el operador la elige"). `tr069Profile` default
 * 'SmartOLT'; 'Wispcontrol' también es válido (429 ONUs del parque lo usan).
 */
export const EnableOnuTr069Schema = z
  .object({
    vlan: z.number().int().positive(),
    tr069Profile: z.string().trim().min(1).optional(),
  })
  .strict();

export type EnableOnuTr069Body = z.infer<typeof EnableOnuTr069Schema>;

/** Pista de vlans conocidas para el mensaje de error cuando falta `vlan` (proposal.md §Evidencia). */
export const VLAN_HINT = 'vlan es requerida (ej. MERCEDES1=11, ESTUDIANTES=12) — el operador la elige, sin default.';
