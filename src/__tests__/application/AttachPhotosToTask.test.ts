import { AttachPhotosToTask } from '@application/use-cases/AttachPhotosToTask';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  UnsupportedAttachmentTypeError,
  TooManyAttachmentsError,
} from '@domain/errors/taskAttachment';
import { FileStorage, StoredFile } from '@domain/ports/FileStorage';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ImageProcessor, ProcessedImage, ImageDimensions } from '@domain/ports/ImageProcessor';
import { ImageTooLargeError } from '@domain/errors/taskAttachment';

// ── Stubs ──────────────────────────────────────────────────────────────────

function taskLookup(existingIds: string[]): EntityLookup {
  const set = new Set(existingIds);
  return { findById: async (id: string) => (set.has(id) ? { id } : null) };
}

class StubImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    return { width: 800, height: 600, thumbnail: Buffer.from('thumb-bytes') };
  }
  inspect(): ImageDimensions | null {
    return { width: 800, height: 600, type: 'jpg' };
  }
}

class ThrowingImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    throw new Error('not a decodable image');
  }
  // inspect SÍ reconoce el header (magic bytes ok); solo el DECODE (process) falla.
  inspect(): ImageDimensions | null {
    return { width: 800, height: 600, type: 'jpg' };
  }
}

/** inspect devuelve null → el buffer no es una imagen real (magic bytes inválidos). */
class NotAnImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    throw new Error('process should never be called for a non-image');
  }
  inspect(): ImageDimensions | null {
    return null;
  }
}

/** inspect declara dimensiones gigantes → decompression bomb (rechazado por header). */
class GiantImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    throw new Error('process should never be called for an oversized image');
  }
  inspect(): ImageDimensions | null {
    return { width: 100_000, height: 100_000, type: 'jpg' }; // 10^10 px ≫ 50 MP
  }
}

/** [4] inspect detecta un tipo NO soportado (svg) aunque las dims sean válidas/pequeñas. */
class SvgImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    return { width: 10, height: 10, thumbnail: Buffer.from('thumb') };
  }
  inspect(): ImageDimensions | null {
    return { width: 10, height: 10, type: 'svg' };
  }
}

/** [4] inspect detecta 'jpg' por magic bytes, pero el cliente declara otro mimetype. */
class JpgDetectedProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    return { width: 20, height: 20, thumbnail: Buffer.from('thumb') };
  }
  inspect(): ImageDimensions | null {
    return { width: 20, height: 20, type: 'jpg' };
  }
}

/** FileStorage que falla en el N-ésimo save de ORIGINAL (no-thumb), delegando lo demás. */
class FailOnNthOriginalSave implements FileStorage {
  private inner = new InMemoryFileStorage();
  private originalSaves = 0;
  constructor(private readonly failAt: number) {}
  get store() {
    return this.inner.store;
  }
  async save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    if (!input.key.endsWith('.thumb.jpg')) {
      this.originalSaves += 1;
      if (this.originalSaves === this.failAt) throw new Error('storage boom on original save');
    }
    return this.inner.save(input);
  }
  get(key: string): Promise<StoredFile | null> {
    return this.inner.get(key);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

/**
 * [3] FileStorage que falla en el 2º save de original (dispara compensación) Y cuyo
 * delete SIEMPRE falla (para que la compensación produzca huérfanos → debe loguearse).
 */
class FailingDeleteStorage implements FileStorage {
  private inner = new InMemoryFileStorage();
  private originalSaves = 0;
  get store() {
    return this.inner.store;
  }
  async save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    if (!input.key.endsWith('.thumb.jpg')) {
      this.originalSaves += 1;
      if (this.originalSaves === 2) throw new Error('storage boom on original save');
    }
    return this.inner.save(input);
  }
  get(key: string): Promise<StoredFile | null> {
    return this.inner.get(key);
  }
  async delete(): Promise<void> {
    throw new Error('cleanup delete boom');
  }
}

const jpeg = (name: string) => ({
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  originalName: name,
  mimeType: 'image/jpeg',
});

describe('AttachPhotosToTask', () => {
  it('happy path: stores original + thumbnail, creates the row, returns a DTO without storageKey', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    const dtos = await uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('foto.jpg')] });

    expect(dtos).toHaveLength(1);
    const dto = dtos[0];
    expect(dto.taskId).toBe('t1');
    expect(dto.filename).toBe('foto.jpg');
    expect(dto.mimeType).toBe('image/jpeg');
    expect(dto.sizeBytes).toBe(4);
    expect(dto.width).toBe(800);
    expect(dto.height).toBe(600);
    expect(dto.uploadedById).toBe('u1');
    expect(dto.fileUrl).toBe(`/api/scheduling/attachments/${dto.id}/file`);
    expect(dto.thumbUrl).toBe(`/api/scheduling/attachments/${dto.id}/file?variant=thumb`);
    // storageKey NUNCA se expone
    expect((dto as unknown as Record<string, unknown>)['storageKey']).toBeUndefined();

    // storage: original + thumb
    const keys = Array.from(storage.store.keys());
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith('tasks/t1/') && k.endsWith('.jpg') && !k.endsWith('.thumb.jpg'))).toBe(true);
    expect(keys.some((k) => k.endsWith('.thumb.jpg'))).toBe(true);

    // fila persistida con la storageKey interna
    const rows = await repo.findByTaskId('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].storageKey).toMatch(/^tasks\/t1\/.+\.jpg$/);
    expect(rows[0].width).toBe(800);
  });

  it('[5] thumbnail best-effort: si process() falla, guarda SOLO el original PERO con dims de inspect() (no null)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const warn = jest.fn();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new ThrowingImageProcessor(), { warn });

    const dtos = await uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('rota.jpg')] });

    expect(dtos).toHaveLength(1);
    // [5] width/height vienen de inspect() (confiables y ya validadas), aunque el
    // thumbnail (process) haya fallado best-effort. ANTES quedaban null (de process).
    expect(dtos[0].width).toBe(800);
    expect(dtos[0].height).toBe(600);
    expect(warn).toHaveBeenCalledTimes(1); // warn del thumbnail best-effort

    // solo el original, sin thumb
    const keys = Array.from(storage.store.keys());
    expect(keys).toHaveLength(1);
    expect(keys[0].endsWith('.thumb.jpg')).toBe(false);

    const rows = await repo.findByTaskId('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].width).toBe(800);
    expect(rows[0].height).toBe(600);
  });

  it('mimetype no soportado → UnsupportedAttachmentTypeError, nada escrito', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    await expect(
      uc.execute({
        taskId: 't1',
        uploadedById: 'u1',
        files: [{ buffer: Buffer.from('pdf'), originalName: 'doc.pdf', mimeType: 'application/pdf' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('excede el cupo de 15 (existentes + nuevos) → TooManyAttachmentsError', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    // sembrar 14 filas existentes
    for (let i = 0; i < 14; i++) {
      await repo.create(
        createScheduledTaskAttachment({
          id: `a${i}`,
          taskId: 't1',
          storageKey: `tasks/t1/a${i}.jpg`,
          filename: `a${i}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          uploadedById: 'u1',
        }),
      );
    }
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    // 14 + 2 = 16 > 15
    await expect(
      uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('x.jpg'), jpeg('y.jpg')] }),
    ).rejects.toBeInstanceOf(TooManyAttachmentsError);

    expect(await repo.countByTaskId('t1')).toBe(14);
    expect(storage.store.size).toBe(0);
  });

  it('tarea inexistente → TaskNotFoundError', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup([]), new StubImageProcessor());

    await expect(
      uc.execute({ taskId: 'ghost', uploadedById: 'u1', files: [jpeg('a.jpg')] }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  // ── borde 15 (off-by-one): 14 sembradas + 1 nueva = 15 → ÉXITO ──────────────
  it('borde 15: 14 existentes + 1 nueva = exactamente 15 → se crea (no rechaza)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    for (let i = 0; i < 14; i++) {
      await repo.create(
        createScheduledTaskAttachment({
          id: `a${i}`,
          taskId: 't1',
          storageKey: `tasks/t1/a${i}.jpg`,
          filename: `a${i}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          uploadedById: 'u1',
        }),
      );
    }
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    const dtos = await uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('n.jpg')] });

    expect(dtos).toHaveLength(1);
    expect(await repo.countByTaskId('t1')).toBe(15);
  });

  // ── A2 + M3/M6: validación de imagen real UPFRONT ───────────────────────────
  it('A2 magic bytes: buffer no-imagen (texto) → UnsupportedAttachmentTypeError, nada guardado', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new NotAnImageProcessor());

    await expect(
      uc.execute({
        taskId: 't1',
        uploadedById: 'u1',
        // mimeType MIENTE (image/jpeg) pero el contenido es texto → inspect lo detecta
        files: [{ buffer: Buffer.from('totally not an image'), originalName: 'fake.jpg', mimeType: 'image/jpeg' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('A2 anti-bomba: dimensiones gigantes (>50 MP) → ImageTooLargeError, nada guardado', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new GiantImageProcessor());

    await expect(
      uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('bomb.jpg')] }),
    ).rejects.toBeInstanceOf(ImageTooLargeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('A2 0 bytes: archivo vacío → rechazado UPFRONT (process nunca se llama), nada guardado', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    // StubImageProcessor.inspect devolvería dims válidas; el guard de 0 bytes debe
    // disparar ANTES, sin llegar a inspect/save.
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    await expect(
      uc.execute({
        taskId: 't1',
        uploadedById: 'u1',
        files: [{ buffer: Buffer.alloc(0), originalName: 'empty.jpg', mimeType: 'image/jpeg' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  // ── A1: atomicidad (all-or-nothing con compensación) ────────────────────────
  it('A1 atómico: si el 2º archivo falla al guardar, el 1º NO queda (ni objeto ni fila) y el error se propaga', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new FailOnNthOriginalSave(2); // falla en el save del 2º original
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    await expect(
      uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('a.jpg'), jpeg('b.jpg')] }),
    ).rejects.toThrow('storage boom on original save');

    // compensación: ni el original ni el thumb del 1º (ni el thumb del 2º) sobreviven
    expect(storage.store.size).toBe(0);
    // y la fila del 1º se revierte
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('A1 atómico: si el repo.create del 2º archivo falla, el 1º se revierte (objeto + fila)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    let creates = 0;
    const origCreate = repo.create.bind(repo);
    repo.create = async (a) => {
      creates += 1;
      if (creates === 2) throw new Error('repo boom on 2nd create');
      return origCreate(a);
    };
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    await expect(
      uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('a.jpg'), jpeg('b.jpg')] }),
    ).rejects.toThrow('repo boom on 2nd create');

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  // ── [3]: la compensación NO debe borrar huérfanos en silencio ───────────────
  it('[3] compensación: si un delete de cleanup falla, se loguea un warn y el error ORIGINAL se propaga intacto', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new FailingDeleteStorage();
    const warn = jest.fn();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor(), { warn });

    await expect(
      uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('a.jpg'), jpeg('b.jpg')] }),
      // el error que se propaga es el ORIGINAL (save), NO el del cleanup
    ).rejects.toThrow('storage boom on original save');

    // se logueó al menos un warn por el delete de compensación que quedó huérfano
    const warnedAboutCompensation = warn.mock.calls.some((c) =>
      /compensation failed to delete/i.test(String(c[0])),
    );
    expect(warnedAboutCompensation).toBe(true);
  });

  // ── [4]: validar el TIPO DETECTADO, no solo "es-una-imagen" (cierra SVG-as-png) ──
  it('[4] SVG declarado image/png → UnsupportedAttachmentTypeError (antes pasaba), nada guardado', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new SvgImageProcessor());

    await expect(
      uc.execute({
        taskId: 't1',
        uploadedById: 'u1',
        files: [{ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), originalName: 'x.png', mimeType: 'image/png' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('[4] bytes jpg declarados image/png → UnsupportedAttachmentTypeError (mismatch tipo↔mimetype)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new JpgDetectedProcessor());

    await expect(
      uc.execute({
        taskId: 't1',
        uploadedById: 'u1',
        files: [{ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), originalName: 'x.png', mimeType: 'image/png' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);

    expect(storage.store.size).toBe(0);
    expect(await repo.countByTaskId('t1')).toBe(0);
  });

  it('[4] jpg real declarado image/jpeg → se acepta (control positivo: tipo detectado coincide)', async () => {
    const repo = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    // StubImageProcessor.inspect detecta type 'jpg' y el mimetype declarado es image/jpeg → match.
    const uc = new AttachPhotosToTask(repo, storage, taskLookup(['t1']), new StubImageProcessor());

    const dtos = await uc.execute({ taskId: 't1', uploadedById: 'u1', files: [jpeg('ok.jpg')] });

    expect(dtos).toHaveLength(1);
    expect(await repo.countByTaskId('t1')).toBe(1);
  });
});
