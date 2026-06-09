import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { StockLocation, StockLocationType } from '@domain/entities/stock-location';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

type Row = {
  id: string;
  type: string;
  code: string | null;
  contractId: string | null;
  technicianId: string | null;
};

function toEntity(r: Row): StockLocation {
  return {
    id: r.id,
    type: r.type as StockLocationType,
    code: r.code,
    contractId: r.contractId,
    technicianId: r.technicianId,
  };
}

export class PrismaStockLocationRepository implements StockLocationRepository {
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async findByCode(code: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({ where: { code } });
    return row ? toEntity(row) : null;
  }

  async findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({
      where: { type_contractId: { type, contractId } },
    });
    return row ? toEntity(row) : null;
  }

  async findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({
      where: { type_technicianId: { type, technicianId } },
    });
    return row ? toEntity(row) : null;
  }

  async create(location: StockLocation): Promise<StockLocation> {
    const row = await this.db.stockLocation.create({
      data: {
        id: location.id,
        type: location.type,
        code: location.code,
        contractId: location.contractId,
        technicianId: location.technicianId,
      },
    });
    return toEntity(row);
  }
}
