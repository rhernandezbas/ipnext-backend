import { Tr069Profile, Tr069Device } from '../entities/tr069';

export interface Tr069Repository {
  findAllProfiles(): Promise<Tr069Profile[]>;
  createProfile(data: Omit<Tr069Profile, 'id'>): Promise<Tr069Profile>;
  updateProfile(id: string, data: Partial<Tr069Profile>): Promise<Tr069Profile | null>;
  deleteProfile(id: string): Promise<boolean>;
  findAllDevices(): Promise<Tr069Device[]>;
  provisionDevice(id: string): Promise<Tr069Device | null>;
  deleteDevice(id: string): Promise<boolean>;
}
