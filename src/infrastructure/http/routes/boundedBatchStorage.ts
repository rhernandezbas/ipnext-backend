import type { StorageEngine } from 'multer';
import type { Request } from 'express';

/**
 * G3 (fix wave FINAL) — el corte de `ticketMessageUpload.ts` por
 * `Content-Length` se evade omitiendo el header (`Transfer-Encoding: chunked`
 * no manda `Content-Length` → `Number(undefined)` = `NaN` → el chequeo se
 * salta). El precheck sigue siendo un fast-path válido para el caso honesto
 * (header presente y mentiroso/de más), pero NO es la protección real: la
 * protección real tiene que acotar el buffering **por construcción**,
 * independientemente de lo que diga cualquier header.
 *
 * `createBoundedBatchStorage` es un `StorageEngine` de multer que cuenta los
 * bytes REALES que salen del stream de cada archivo (no lo que dice ningún
 * header) y aborta apenas el acumulado del REQUEST completo supera
 * `maxTotalBytes` — el mismo presupuesto se comparte entre los N archivos del
 * batch vía un `WeakMap<Request, number>` (bytes restantes). Con esto, el pico
 * de RAM de un request está acotado a `maxTotalBytes` + el tamaño de UN chunk
 * en vuelo, sin importar si el cliente mintió, omitió, o nunca declaró
 * `Content-Length`.
 */
export class BatchTooLargeStreamError extends Error {
  constructor(maxTotalBytes: number) {
    super(`ticket message attachment batch exceeds the ${maxTotalBytes}-byte total budget`);
    this.name = 'BatchTooLargeStreamError';
  }
}

export function createBoundedBatchStorage(maxTotalBytes: number): StorageEngine {
  const remainingByRequest = new WeakMap<Request, number>();

  return {
    _handleFile(req, file, cb) {
      const remainingBefore = remainingByRequest.has(req)
        ? (remainingByRequest.get(req) as number)
        : maxTotalBytes;

      const chunks: Buffer[] = [];
      let remaining = remainingBefore;
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        file.stream.removeAllListeners('data');
        file.stream.removeAllListeners('end');
        // Drop whatever is left in the stream — we're done reading it.
        file.stream.destroy();
        cb(err);
      };

      file.stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        remaining -= chunk.length;
        if (remaining < 0) {
          fail(new BatchTooLargeStreamError(maxTotalBytes));
          return;
        }
        chunks.push(chunk);
      });

      file.stream.on('error', (err: Error) => fail(err));

      file.stream.on('end', () => {
        if (settled) return;
        settled = true;
        remainingByRequest.set(req, remaining);
        const buffer = Buffer.concat(chunks);
        cb(null, { buffer, size: buffer.length });
      });
    },
    _removeFile(_req, _file, cb) {
      cb(null);
    },
  };
}
