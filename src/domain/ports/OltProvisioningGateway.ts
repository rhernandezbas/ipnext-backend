/**
 * smartolt-provision (K2) — port del aprovisionamiento de ONUs fibra.
 * La aplicación depende de ESTA interfaz; el adapter concreto
 * (SmartOltHttpGateway) habla con la API de SmartOLT (X-Token, form-encoded).
 * Tipos de dominio limpios: nada de shapes crudos de SmartOLT acá.
 *
 * Errores: toda falla del plano SmartOLT se lanza como `OltProvisioningError`
 * (`@domain/errors/smartolt`) con `reason` tipado:
 *   'not_configured' → envs SMARTOLT_* ausentes (feature apagada)
 *   'unreachable'    → red/timeout/5xx
 *   'rejected'       → SmartOLT respondió pero rechazó la operación (status false / 4xx)
 */

/** Una ONU detectada por la OLT pero aún sin autorizar (onu/unconfigured_onus). */
export interface UnconfiguredOnu {
  sn: string;
  /** Nombre del tipo de ONU en SmartOLT (ej. "HG8546M"). */
  onuTypeName: string | null;
  onuTypeId: string | null;
  /** Id de la OLT en SmartOLT (ej. "1" MERCEDES1, "3" CHIVILCOY X2). */
  oltId: string;
  board: string | null;
  port: string | null;
  /** "gpon" | "epon" (crudo de SmartOLT). */
  ponType: string | null;
  /** true si SmartOLT ofrece la acción "authorize" para esta ONU. */
  supportsAuthorize: boolean;
}

export interface AuthorizeOnuInput {
  sn: string;
  oltId: string;
  ponType: string | null;
  board: string | null;
  port: string | null;
  /** Tipo de ONU por NOMBRE (como lo devuelve unconfigured_onus). */
  onuTypeName: string | null;
  /** VLAN de servicio (input del operador o default del catálogo SmartOltOltConfig). */
  vlan: number;
  /** Etiqueta visible en SmartOLT (cliente + contrato). */
  name: string;
  /** Speed profiles por NOMBRE ("300M"). null = autorizar sin profiles (ajuste manual). */
  downloadSpeedProfileName: string | null;
  uploadSpeedProfileName: string | null;
}

export interface SetWifiInput {
  /** Puerto WiFi SmartOLT: 'wifi_0/1' (2.4GHz) | 'wifi_0/5' (5GHz). */
  port: 'wifi_0/1' | 'wifi_0/5';
  ssid: string;
  password: string;
}

export interface OltProvisioningGateway {
  /** ONUs detectadas sin autorizar en TODAS las OLTs (GET onu/unconfigured_onus). */
  listUnconfiguredOnus(): Promise<UnconfiguredOnu[]>;
  /**
   * Autoriza la ONU (POST onu/authorize_onu). Los params exactos del endpoint
   * NO están verificados contra la instancia real — ver el comentario
   * "PARAMS SIN VERIFICAR" en SmartOltHttpGateway.
   */
  authorizeOnu(input: AuthorizeOnuInput): Promise<void>;
  /** IP de management estática por VLAN de mgmt (POST onu/set_onu_mgmt_ip_static_ip/<sn>). */
  setMgmtIp(sn: string, vlan: number): Promise<void>;
  /** Habilita TR-069 con el profile dado (POST onu/enable_tr069/<sn>). */
  enableTr069(sn: string, profile: string): Promise<void>;
  /** Permite acceso remoto a la IP WAN (POST onu/enable_allow_remote_access_to_wan_ip/<sn>). */
  allowRemoteWanAccess(sn: string): Promise<void>;
  /**
   * Configura un puerto WiFi (POST onu/set_wifi_port_lan/<sn>).
   * Gotcha 5GHz: SmartOLT NO tiene 'wifi_0/5' registrado para los tipos Huawei
   * de IPNEXT → hoy responde "Invalid parameters". El caller DEBE tolerarlo
   * (best-effort, no aborta el flujo).
   */
  setWifi(sn: string, input: SetWifiInput): Promise<void>;
  /**
   * portal-equipment-reboot — reinicia la ONU (POST onu/reboot/<sn>, skill
   * smartolt-ipnext). Va por OMCI, NO por TR-069 — funciona incluso en un
   * bridge sin puertos WiFi habilitados (a diferencia de `setWifi`, que sí
   * depende de TR-069 estar prendido en el flujo del portal). Sin params
   * extra, mismo patrón que `allowRemoteWanAccess`.
   */
  reboot(sn: string): Promise<void>;
}
