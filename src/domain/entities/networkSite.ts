export interface NetworkSite {
  id: string;
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
}
