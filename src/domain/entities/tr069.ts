export interface Tr069Profile {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  firmwareVersion: string | null;
  acsUrl: string;
  connectionRequestUrl: string | null;
  periodicInformInterval: number;
  deviceCount: number;
  parameters: { key: string; value: string }[];
  status: 'active' | 'inactive';
}

export interface Tr069Device {
  id: string;
  serialNumber: string;
  profileId: string;
  profileName: string;
  clientId: string | null;
  clientName: string | null;
  lastContact: string | null;
  status: 'active' | 'pending' | 'error';
  firmwareVersion: string;
  parameters: { key: string; value: string }[];
}
