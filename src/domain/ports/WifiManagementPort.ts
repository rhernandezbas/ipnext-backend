import { WifiBandStatus, GuestWifiBandStatus } from '@domain/services/mapWifiPortsToBands';

/**
 * wifi-self-service (F0) — port NARROW (ISP) para la lectura/escritura de
 * WiFi de una ONU. Separado de `OltProvisioningGateway` (aprovisionamiento:
 * autorizar, mgmt IP, TR-069) a propósito — son responsabilidades distintas
 * aunque hablen con la MISMA API; un consumer que solo necesita leer el
 * estado del WiFi no debe depender de la superficie de aprovisionamiento
 * completa. El adapter concreto (`SmartOltHttpGateway`) implementa AMBOS
 * ports sobre el mismo cliente HTTP — ver ese archivo.
 *
 * Errores: igual que `OltProvisioningGateway`, toda falla del plano SmartOLT
 * se lanza como `OltProvisioningError` (`@domain/errors/smartolt`) con
 * `reason` tipado ('not_configured' | 'unreachable' | 'rejected') — EXCEPTO
 * "serial no encontrado en SmartOLT", que `getOnuWifiStatus` modela con
 * `found: false` en vez de tirar (es un resultado válido y frecuente, no una
 * falla de infraestructura).
 */

export interface OnuWifiStatus {
  /** false = SmartOLT no tiene registrada esta ONU (serial desconocido). */
  found: boolean;
  onuType: string | null;
  online: boolean;
  /** TR-069 = Enabled en SmartOLT. La app NUNCA lo prende — solo lee. */
  tr069Enabled: boolean;
  /** [] = sin puertos WiFi (bridge) o ONU no encontrada. */
  bands: WifiBandStatus[];
  /**
   * EPIC v3 (wifi de visitas) — estado del puerto de visita por banda, derivado
   * de los MISMOS puertos crudos que `bands` (`mapWifiPortsToGuest`). OPCIONAL
   * a propósito (aditivo): los fakes/fixtures viejos que no lo setean siguen
   * compilando; los consumers tratan `undefined` como "ambas bandas no
   * disponibles" (el lado SEGURO — nunca habilita una escritura por ausencia
   * de dato).
   */
  guest?: GuestWifiBandStatus[];
}

export interface SetWifiBandInput {
  /** 'wifi_0/1'..'wifi_0/8' — el admin puede mandar cualquiera; el portal solo el "principal" de su banda. */
  port: string;
  ssid: string;
  password: string;
}

export interface RouterHost {
  hostName: string | null;
  ip: string | null;
  mac: string | null;
  interfaceType: 'wifi' | 'ethernet';
  active: boolean;
  vendor: string | null;
  /**
   * EPIC v3 (red por dispositivo) — índice de `Layer2Interface`
   * (`...WLANConfiguration.<n>` del payload real de get_onu_router_hosts,
   * experimento 2026-08-02). El índice = número de puerto wifi (1=principal
   * 2.4, 5=principal 5, 2=visita 2.4, 6=visita 5). Ethernet apunta a otra
   * interfaz (o falta) -> null. La app agrupa client-side combinándolo con el
   * GET de wifi — el BE no joinea nombres.
   */
  wlanIndex: number | null;
}

/**
 * wifi-guest-pending — una MAC asociada AHORA a un SSID del ONT, leída de
 * "Online MACs on this ONU" de GET onu/get_onu_full_status_info/<sn>. Es la
 * ÚNICA lectura VIVA del equipo: `getOnuWifiStatus` (get_onu_details) es la DB
 * de SmartOLT y MIENTE tras un push TR-069 perdido (evidencia 2026-08-04/05,
 * HWTCA92F96B1: wifi_0/2 "Disabled" con la red emitiendo). "WLAN N" del
 * payload = SSID index N = número de puerto wifi (wifi_0/2 → 2).
 */
export interface OnlineWifiMac {
  wlanIndex: number;
  mac: string;
}

export interface WifiManagementPort {
  /** GET onu/get_onu_details/<sn>. Cacheado (TTL corto) — el resolver de elegibilidad lo llama seguido. */
  getOnuWifiStatus(sn: string): Promise<OnuWifiStatus>;
  /**
   * POST onu/set_wifi_port_lan/<sn>. SIEMPRE WPA2 (el adapter lo fuerza, jamás
   * Open-system). Invalida la entrada de cache de `getOnuWifiStatus` para ESTA sn.
   */
  setWifiBand(sn: string, input: SetWifiBandInput): Promise<void>;
  /** GET onu/get_onu_router_hosts/<sn>. NO cacheado. */
  getRouterHosts(sn: string): Promise<RouterHost[]>;
  /**
   * EPIC v3 (wifi de visitas) — POST onu/shutdown_wifi_port/<sn> con form
   * `wifi_port` (único param — colección Postman oficial, 2026-08-03). Apaga
   * ESE puerto WiFi. Invalida la entrada de cache de `getOnuWifiStatus` de
   * esta sn: el próximo GET debe ver `enabled:false`, no el snapshot stale.
   */
  shutdownWifiPort(sn: string, port: string): Promise<void>;
  /**
   * wifi-guest-pending — GET onu/get_onu_full_status_info/<sn>, SOLO las filas
   * WLAN de "Online MACs on this ONU" (las ETH no son WiFi). Cacheado (TTL 60s
   * — la evaluación lazy del GET del portal lo llama seguido; rate limit
   * SmartOLT 1000/h).
   */
  getOnlineWifiMacs(sn: string): Promise<OnlineWifiMac[]>;
}
