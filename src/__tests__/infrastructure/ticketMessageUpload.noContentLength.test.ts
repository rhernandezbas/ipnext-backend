/**
 * ticketMessageUpload — G3 (fix wave FINAL).
 *
 * F3 cortaba por `Content-Length` ANTES de bufferear (ver
 * `ticketMessageUpload.test.ts`), pero ESE corte se evade enteramente con
 * `Transfer-Encoding: chunked` (sin `Content-Length` declarado). Este test
 * reproduce el escenario REAL de principio a fin: un request HTTP real
 * (supertest sobre un server real), con un adjunto servido desde un
 * `Readable` genérico (no un Buffer ni un `fs.ReadStream`) — `form-data` no
 * puede calcular su longitud de antemano, así que superagent nunca manda
 * `Content-Length` y Node usa `Transfer-Encoding: chunked` automáticamente,
 * EXACTAMENTE el bypass que describía el hallazgo. Si el precheck de
 * Content-Length fuera la única defensa, este request bufferearía el batch
 * entero (>60MB) antes de rechazarlo. Con `createBoundedBatchStorage`
 * (G3), corta a mitad de stream apenas se supera el presupuesto.
 */
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { createTicketMessageUploadMiddleware, TICKET_MESSAGE_FILES_FIELD } from '../../infrastructure/http/routes/ticketMessageUpload';
import { MAX_TOTAL_BATCH_BYTES } from '@application/use-cases/ticketMessageAttachments';

/** Readable SIN longitud conocida — a propósito: `form-data`/superagent no
 * pueden precalcular su tamaño, así que nunca declaran `Content-Length`. */
function chunkedSourceOfSize(totalBytes: number, chunkSize = 1024 * 1024): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      this.push(Buffer.alloc(size, 0x41));
      sent += size;
    },
  });
}

function buildApp() {
  const app = express();
  app.use(
    `/upload`,
    createTicketMessageUploadMiddleware(),
    (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      res.status(200).json({ ok: true, count: files.length });
    },
  );
  return app;
}

describe('createTicketMessageUploadMiddleware — G3: sin Content-Length (chunked), el corte sigue funcionando', () => {
  it('request SIN Content-Length (Transfer-Encoding: chunked) que supera el batch -> 413 BATCH_TOO_LARGE, next() nunca llega al handler', async () => {
    const app = buildApp();
    // DOS archivos, cada uno bajo el tope POR ARCHIVO de multer (MAX_VIDEO_BYTES,
    // 40MB) pero cuya SUMA supera el tope de batch — a propósito: si usáramos
    // un solo archivo gigante, el límite fileSize de multer cortaría primero
    // (FILE_TOO_LARGE) y no probaría el corte de TOTAL que es lo que G3 arregla.
    const half = Math.ceil((MAX_TOTAL_BATCH_BYTES + 5 * 1024 * 1024) / 2);
    const first = chunkedSourceOfSize(half);
    const second = chunkedSourceOfSize(half);

    const res = await request(app)
      .post('/upload')
      .attach(TICKET_MESSAGE_FILES_FIELD, first as never, { filename: 'a.bin', contentType: 'application/octet-stream' })
      .attach(TICKET_MESSAGE_FILES_FIELD, second as never, { filename: 'b.bin', contentType: 'application/octet-stream' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
  }, 30000);

  it('control: un archivo chico servido igual sin Content-Length (mismo Readable genérico) pasa normal -> 200', async () => {
    const app = buildApp();
    const small = chunkedSourceOfSize(1024);

    const res = await request(app)
      .post('/upload')
      .attach(TICKET_MESSAGE_FILES_FIELD, small as never, { filename: 'small.bin', contentType: 'application/octet-stream' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });
  }, 20000);
});
