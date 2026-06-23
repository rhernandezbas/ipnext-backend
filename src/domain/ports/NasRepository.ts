import { NasServer, RadiusConfig } from '../entities/nas';

export interface NasRepository {
  findAllNasServers(): Promise<NasServer[]>;
  findNasServerById(id: string): Promise<NasServer | null>;
  /** Busca el NAS por su IP de accounting (radacct.nasipaddress). Usado para resolver el NE8000. */
  findNasServerByNasIp(nasIpAddress: string): Promise<NasServer | null>;
  createNasServer(data: Omit<NasServer, 'id'>): Promise<NasServer>;
  updateNasServer(id: string, data: Partial<NasServer>): Promise<NasServer | null>;
  deleteNasServer(id: string): Promise<boolean>;

  getRadiusConfig(): Promise<RadiusConfig>;
  updateRadiusConfig(data: Partial<RadiusConfig>): Promise<RadiusConfig>;
}
