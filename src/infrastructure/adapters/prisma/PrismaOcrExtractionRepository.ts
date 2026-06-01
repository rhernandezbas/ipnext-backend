import { OcrExtractionRepository } from '@domain/ports/OcrExtractionRepository';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { prisma } from '../../database/prisma';

type Row = {
  id: string; photoUrl: string; serviceOrderId: string | null; sourceTaskId: string | null;
  deviceType: string | null; sn: string | null; mac: string | null; confidence: number | null;
  rawOutput: string | null; provider: string; createdAt: Date;
};

function toEntity(r: Row): OcrExtraction {
  return {
    id: r.id, photoUrl: r.photoUrl, serviceOrderId: r.serviceOrderId, sourceTaskId: r.sourceTaskId,
    deviceType: r.deviceType, sn: r.sn, mac: r.mac, confidence: r.confidence,
    rawOutput: r.rawOutput, provider: r.provider, createdAt: r.createdAt.toISOString(),
  };
}

export class PrismaOcrExtractionRepository implements OcrExtractionRepository {
  async save(e: OcrExtraction): Promise<OcrExtraction> {
    const row = await prisma.ocrExtraction.create({
      data: {
        id: e.id, photoUrl: e.photoUrl, serviceOrderId: e.serviceOrderId, sourceTaskId: e.sourceTaskId,
        deviceType: e.deviceType, sn: e.sn, mac: e.mac, confidence: e.confidence,
        rawOutput: e.rawOutput, provider: e.provider, createdAt: new Date(e.createdAt),
      },
    });
    return toEntity(row);
  }

  async findByPhotoUrl(photoUrl: string): Promise<OcrExtraction | null> {
    const row = await prisma.ocrExtraction.findFirst({ where: { photoUrl }, orderBy: { createdAt: 'desc' } });
    return row ? toEntity(row) : null;
  }
}
