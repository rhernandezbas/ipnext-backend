import { z } from 'zod';
import type { WifiBandStatus } from '@domain/services/mapWifiPortsToBands';
import type { RouterHost } from '@domain/ports/WifiManagementPort';
import type { WifiEligibilityReason } from '@domain/errors/wifi';

// ── Portal ────────────────────────────────────────────────────────────────

/**
 * EPIC v3 (wifi de visitas) — banda de visita en el wire del portal. SIN el
 * puerto crudo (la app no conoce puertos SmartOLT, mismo criterio que ocultar
 * la sn). `available:false` = el template "ONU type" no tiene el puerto de
 * visita de esa banda (evidencia HWTCA92F96B1 2026-08-03).
 */
export interface PortalGuestWifiBandDto {
  band: '2.4' | '5';
  available: boolean;
  ssid: string | null;
  enabled: boolean;
}

/**
 * wifi-guest-pending — cambio de la red de visitas EN VUELO (contrato FIJO con
 * la app, se consume tal cual):
 *  - `action`: 'creating' (alta/edición, PUT guest) | 'deleting' (baja, POST disable).
 *  - `since`: ISO — inicio del cambio.
 *  - `status`: 'in_progress' (< 10 min — la app bloquea el botón) |
 *    'unconfirmed' (>= 10 min con la radio aún al aire — la app permite reintentar).
 * Presente en el GET mientras exista intent, y en la respuesta del PUT/disable
 * (siempre 'in_progress' recién creado).
 */
export interface PortalGuestPendingDto {
  action: 'creating' | 'deleting';
  since: string;
  status: 'in_progress' | 'unconfirmed';
}

export type PortalWifiStatusDto =
  | { eligible: false; reason: WifiEligibilityReason }
  | {
      eligible: true;
      /**
       * wifi-password-snapshot — `password: null` = esta banda nunca se
       * escribió desde Prominense (portal ni admin) — la app muestra el
       * campo vacío, NUNCA null-como-string. SmartOLT no la devuelve, ver
       * `OnuWifiCredentialRepository`.
       */
      bands: Array<{ band: '2.4' | '5'; ssid: string | null; password: string | null }>;
      /** Hosts con `active=true`. `null` si el fetch de hosts falló — nunca rompe la pantalla por el contador. */
      connectedCount: number | null;
      /** EPIC v3 — ADITIVO: SIEMPRE las dos bandas listadas. Solo presente cuando eligible. */
      guest: { bands: PortalGuestWifiBandDto[] };
      /** wifi-guest-pending — ADITIVO y OPCIONAL: ausente cuando no hay cambio en vuelo. */
      guestPending?: PortalGuestPendingDto;
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

/**
 * EPIC v3 (wifi de visitas) — `PUT /api/portal/wifi/:contractId/guest`.
 * Validación de FORMA solamente; las MISMAS reglas de fondo de ssid/password
 * que el update principal corren en `validateWifiCredentials` (use case).
 */
export const UpdatePortalWifiGuestSchema = z
  .object({
    band: z.enum(['2.4', '5']),
    ssid: z.string(),
    password: z.string(),
  })
  .strict();

export type UpdatePortalWifiGuestBody = z.infer<typeof UpdatePortalWifiGuestSchema>;

/** EPIC v3 — `POST /api/portal/wifi/:contractId/guest/disable`. */
export const DisablePortalWifiGuestSchema = z
  .object({
    band: z.enum(['2.4', '5']),
  })
  .strict();

export type DisablePortalWifiGuestBody = z.infer<typeof DisablePortalWifiGuestSchema>;

export interface PortalWifiDeviceDto {
  name: string | null;
  interface: 'wifi' | 'ethernet';
  active: boolean;
  /**
   * EPIC v3 (red por dispositivo) — ADITIVO: índice WLANConfiguration del host
   * (1=principal 2.4, 5=principal 5, 2=visita 2.4, 6=visita 5); ethernet o no
   * parseable -> null. La app agrupa client-side combinándolo con el GET de
   * wifi (ssids por banda + guest).
   */
  wlanIndex: number | null;
}

/** portal — SIN ip/mac (menos superficie para la app del cliente). */
export function toPortalWifiDeviceDto(host: RouterHost): PortalWifiDeviceDto {
  return { name: host.hostName, interface: host.interfaceType, active: host.active, wlanIndex: host.wlanIndex };
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

/**
 * wifi-password-snapshot — banda WiFi (dato SmartOLT, `WifiBandStatus`) +
 * `password` (dato Prominense, `OnuWifiCredentialRepository`) — DOS fuentes
 * distintas, unidas acá en el use case, NUNCA en `mapWifiPortsToBands`
 * (función pura, sin I/O — ver su docblock).
 */
export interface AdminWifiBandStatusDto extends WifiBandStatus {
  /** `null` = esta banda nunca se escribió desde Prominense. */
  password: string | null;
}

export interface AdminOnuWifiStatusDto {
  sn: string;
  found: boolean;
  onuType: string | null;
  online: boolean;
  tr069Enabled: boolean;
  bands: AdminWifiBandStatusDto[];
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
