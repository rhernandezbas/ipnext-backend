/**
 * ticketMessageUpload — portal-ticket-messaging (v2.B) fix wave, F3.
 *
 * Antes del fix: multer bufferea los archivos COMPLETOS (hasta
 * MAX_VIDEO_BYTES=40MB cada uno, hasta 5 = ~200MB) ANTES de que el chequeo de
 * batch (MAX_TOTAL_BATCH_BYTES=60MB) corra — el rechazo llegaba DESPUÉS del
 * peor pico de RAM, no antes. Con el rate limiter (20 envíos/5min POR CUENTA,
 * sin serializar) varios requests concurrentes de la misma cuenta multiplican
 * ese pico a varios GB.
 *
 * El fix corta por `Content-Length` ANTES de invocar `upload.array` — se
 * prueba invocando el RequestHandler DIRECTO (sin supertest/HTTP real): el
 * punto es que para un batch declarado de más de 60MB, `res.status(413)`
 * pasa de forma SÍNCRONA sin que el middleware intente leer el body como
 * stream (un `req` fake sin socket real haría que multer cuelgue o reviente).
 */
import { createTicketMessageUploadMiddleware } from '../../infrastructure/http/routes/ticketMessageUpload';
import { MAX_TOTAL_BATCH_BYTES } from '@application/use-cases/ticketMessageAttachments';

function fakeRes() {
  const res: { statusCode?: number; body?: unknown; status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(function (this: unknown, code: number) {
      res.statusCode = code;
      return res as unknown as typeof res;
    }),
    json: jest.fn(function (this: unknown, body: unknown) {
      res.body = body;
      return res as unknown as typeof res;
    }),
  };
  return res;
}

describe('createTicketMessageUploadMiddleware — F3 (fix wave): cap por Content-Length ANTES de bufferear', () => {
  it('Content-Length > MAX_TOTAL_BATCH_BYTES -> 413 BATCH_TOO_LARGE SÍNCRONO, next() NUNCA se llama (nada se bufferea)', () => {
    const middleware = createTicketMessageUploadMiddleware();
    const req = { headers: { 'content-length': String(MAX_TOTAL_BATCH_BYTES + 10 * 1024 * 1024) } };
    const res = fakeRes();
    const next = jest.fn();

    middleware(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.body).toMatchObject({ code: 'BATCH_TOO_LARGE' });
    expect(next).not.toHaveBeenCalled();
  });
});
