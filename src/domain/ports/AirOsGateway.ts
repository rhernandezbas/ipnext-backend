/**
 * AirOsGateway — inspección SSH de una antena Ubiquiti airOS.
 *
 * Permite leer el modelo del CPE y las MACs de los dispositivos LAN conectados
 * (típicamente el router del cliente). Se usa para poblar el inventario de equipos
 * del contrato desde un botón en la UI (InspectPppoeDevices).
 *
 * La implementación real (Ssh2AirOsGateway) usa `ssh2` con los algoritmos legacy
 * que soporta airOS. La implementación in-memory (InMemoryAirOsGateway) se usa en tests.
 *
 * Fallo de conexión → lanzar `AirOsUnreachableError` (domain error, best-effort):
 * el use case lo captura y devuelve warnings en lugar de propagar la excepción.
 */

export interface AirOsInspectResult {
  /** Modelo del CPE (plataforma), ej. 'LiteBeam 5AC Gen2'. `null` si no se pudo parsear. */
  model: string | null;
  /** MAC de la antena misma (deviceId del mca-status). `null` si no se pudo parsear. */
  ownMac: string | null;
  /** MACs de los dispositivos en la red LAN (ARP table, iface eth0, flags 0x2, sin la propia). */
  lanMacs: string[];
}

export interface AirOsGateway {
  /**
   * Conecta a la antena por SSH, ejecuta `mca-status` + `cat /proc/net/arp`
   * y devuelve model, ownMac y lanMacs.
   *
   * @throws `AirOsUnreachableError` si la conexión falla (timeout, offline, auth).
   */
  inspect(ip: string): Promise<AirOsInspectResult>;
}
