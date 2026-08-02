/**
 * wifi-password-snapshot — port del snapshot PERSISTIDO de la última password
 * escrita en cada banda WiFi de una ONU.
 *
 * Por qué existe: SmartOLT NUNCA devuelve `password` en `get_onu_details`
 * (verificado en vivo — `password: null` SIEMPRE en las 925 ONUs del parque
 * con WiFi), sólo la acepta al escribir (`set_wifi_port_lan`). Prominense es
 * por lo tanto el ÚNICO lugar donde la password sobrevive: cada escritura
 * exitosa (portal `UpdatePortalWifiBand` o admin `SetAdminWifiBand`) hace
 * `upsert` acá — best-effort, NUNCA tumba el PUT si falla (el equipo ya
 * cambió, ver docblock de esos use cases).
 *
 * Riesgo aceptado: si alguien cambia la password por FUERA de Prominense (la
 * web local del equipo, la UI de SmartOLT) este snapshot queda
 * DESACTUALIZADO — no hay forma de detectarlo, SmartOLT no la expone para
 * comparar.
 */
export interface OnuWifiCredential {
  /** Serial NORMALIZADO (normalizeOnuSerial) — misma clave que el resto de wifi-self-service. */
  sn: string;
  /** 'wifi_0/1'..'wifi_0/8'. */
  port: string;
  ssid: string;
  password: string;
  /** ISO 8601. */
  updatedAt: string;
  /** 'portal' | 'staff:<rbacUserId>' — quién la escribió por última vez. */
  updatedBy: string | null;
}

export interface UpsertOnuWifiCredentialInput {
  sn: string;
  port: string;
  ssid: string;
  password: string;
  updatedBy: string | null;
}

export interface OnuWifiCredentialRepository {
  /** Todas las filas de una sn (todas las bandas escritas alguna vez) — 1 query, no N por banda. */
  findManyBySn(sn: string): Promise<OnuWifiCredential[]>;
  /** Upsert por el unique compuesto (sn, port) — NUNCA duplica una fila para la misma banda. */
  upsert(input: UpsertOnuWifiCredentialInput): Promise<void>;
}
