/**
 * boundedBatchStorage — G3 (fix wave FINAL).
 *
 * Prueba el mecanismo DIRECTO (sin pasar por multer/HTTP): el engine cuenta
 * bytes REALES del stream, nunca un header. Esto es, por construcción, "el
 * caso sin Content-Length" — el engine ni siquiera mira `req.headers`, así
 * que el resultado es el MISMO exista o no el header, sea honesto o mienta.
 */
import { PassThrough } from 'stream';
import type { Request } from 'express';
import { createBoundedBatchStorage, BatchTooLargeStreamError } from '../../infrastructure/http/routes/boundedBatchStorage';

function fakeFile(stream: PassThrough): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname: 'video.mp4',
    encoding: '7bit',
    mimetype: 'video/mp4',
    stream,
  } as unknown as Express.Multer.File;
}

describe('createBoundedBatchStorage — corta por bytes reales del stream, no por header', () => {
  it('deja pasar un archivo cuyo total real está DENTRO del presupuesto', async () => {
    const storage = createBoundedBatchStorage(1024);
    const stream = new PassThrough();
    const req = {} as Request; // sin headers en absoluto — el engine no los mira

    const result = await new Promise<{ err: unknown; info: unknown }>((resolve) => {
      storage._handleFile(req, fakeFile(stream), (err, info) => resolve({ err, info }));
      stream.end(Buffer.alloc(512, 0x41));
    });

    expect(result.err).toBeFalsy();
    expect((result.info as { size: number }).size).toBe(512);
  });

  it('aborta apenas los bytes REALES acumulados superan el presupuesto — sin Content-Length ni ningún header involucrado', async () => {
    const storage = createBoundedBatchStorage(1024);
    const stream = new PassThrough();
    const req = {} as Request;
    const destroySpy = jest.spyOn(stream, 'destroy');

    const errPromise = new Promise<unknown>((resolve) => {
      storage._handleFile(req, fakeFile(stream), (err) => resolve(err));
    });

    // Empuja MÁS del presupuesto en chunks — nunca declara ningún tamaño total,
    // exactamente como un cliente con Transfer-Encoding: chunked.
    stream.write(Buffer.alloc(700, 0x41));
    stream.write(Buffer.alloc(700, 0x41)); // acumulado 1400 > 1024 -> debe cortar acá

    const err = await errPromise;
    expect(err).toBeInstanceOf(BatchTooLargeStreamError);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('el presupuesto es POR REQUEST (compartido entre archivos del mismo batch), no por archivo', async () => {
    const storage = createBoundedBatchStorage(1000);
    const req = {} as Request;

    // Primer archivo: 600 bytes — dentro del presupuesto individual, consume budget.
    const stream1 = new PassThrough();
    const first = await new Promise<{ err: unknown }>((resolve) => {
      storage._handleFile(req, fakeFile(stream1), (err) => resolve({ err }));
      stream1.end(Buffer.alloc(600, 0x41));
    });
    expect(first.err).toBeFalsy();

    // Segundo archivo del MISMO req: 600 bytes más -> 1200 > 1000 acumulado -> corta,
    // aunque cada archivo individualmente esté "bajo el límite".
    const stream2 = new PassThrough();
    const second = await new Promise<{ err: unknown }>((resolve) => {
      storage._handleFile(req, fakeFile(stream2), (err) => resolve({ err }));
      stream2.end(Buffer.alloc(600, 0x41));
    });
    expect(second.err).toBeInstanceOf(BatchTooLargeStreamError);
  });
});
