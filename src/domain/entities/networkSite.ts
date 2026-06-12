export interface NetworkSite {
  id: string;
  /**
   * network-site-fixed-code (#51) — número de sitio estable, asignado por la DB
   * (secuencia `network_site_number_seq`). Identidad interna del sitio, no editable.
   */
  siteNumber: number;
  /**
   * network-site-fixed-code (#51) — código fijo derivado: `"NODO {siteNumber}"`.
   * Read-only (computado en el mapper). NO es el código de localidad: ese sigue
   * siendo `iclassNodeCode` y es lo que usa el dispatch a IClass.
   */
  fixedCode: string;
  name: string;
  address: string;
  city: string;
  coordinates: { lat: number; lng: number } | null;
  type: 'pop' | 'nodo' | 'datacenter' | 'tower' | 'other';
  status: 'active' | 'inactive' | 'maintenance';
  deviceCount: number;
  clientCount: number;
  uplink: string;
  parentSiteId: string | null;
  description: string;
  // network-node-task (#29) — código de nodo en IClass para envío de OS de RED
  iclassNodeCode: string | null;
  // uisp-integration — optional link to UISP mirror (uispId TEXT, no DB FK)
  uispSiteId: string | null;
}
