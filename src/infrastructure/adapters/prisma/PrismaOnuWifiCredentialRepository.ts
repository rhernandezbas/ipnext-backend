import { prisma } from '../../database/prisma';
import type {
  OnuWifiCredential,
  OnuWifiCredentialRepository,
  UpsertOnuWifiCredentialInput,
} from '@domain/ports/OnuWifiCredentialRepository';

interface OnuWifiCredentialRow {
  sn: string;
  port: string;
  ssid: string;
  password: string;
  updatedAt: Date;
  updatedBy: string | null;
}

function toEntity(row: OnuWifiCredentialRow): OnuWifiCredential {
  return {
    sn: row.sn,
    port: row.port,
    ssid: row.ssid,
    password: row.password,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/**
 * wifi-password-snapshot — registro Prisma del snapshot de password WiFi.
 * Upsert por el unique compuesto (sn, port) — `sn_port` es el nombre que
 * Prisma genera para `@@unique([sn, port])` (mismo criterio que
 * `PrismaFiberAutoProvisionAttemptRepository` con `taskId_onuSn`).
 */
export class PrismaOnuWifiCredentialRepository implements OnuWifiCredentialRepository {
  async findManyBySn(sn: string): Promise<OnuWifiCredential[]> {
    const rows = await prisma.onuWifiCredential.findMany({ where: { sn } });
    return (rows as unknown as OnuWifiCredentialRow[]).map(toEntity);
  }

  async upsert(input: UpsertOnuWifiCredentialInput): Promise<void> {
    await prisma.onuWifiCredential.upsert({
      where: { sn_port: { sn: input.sn, port: input.port } },
      create: {
        sn: input.sn,
        port: input.port,
        ssid: input.ssid,
        password: input.password,
        updatedBy: input.updatedBy,
      },
      update: {
        ssid: input.ssid,
        password: input.password,
        updatedBy: input.updatedBy,
      },
    });
  }
}
