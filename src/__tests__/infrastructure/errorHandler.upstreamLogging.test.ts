import { Request, Response } from 'express';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { OltProvisioningError } from '@domain/errors/smartolt';
import { DomainError } from '@domain/errors';

/**
 * Ceguera de clase cazada en vivo (2026-08-03): el `console.error` del handler
 * global corría SOLO para errores no tipados — un `OltProvisioningError`
 * ('unreachable' → 502) respondía el 5xx y retornaba SIN loguear. Resultado:
 * "Dispositivos conectados" falló en el teléfono del cliente y los logs de
 * prod estaban MUDOS (mismo agujero que ya nos cegó con el reboot). Regla
 * nueva: todo DomainError que mapee a 5xx es una falla de INFRAESTRUCTURA y
 * se loguea; los 4xx son del cliente y NO (serían ruido).
 */
function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

class NotFoundishError extends DomainError {
  constructor() {
    super('cliente inexistente', 'CLIENT_NOT_FOUND');
  }
}

describe('errorHandler — visibilidad de fallas upstream (5xx)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('un DomainError que mapea a 5xx SE LOGUEA con su code y mensaje', () => {
    const res = mockRes();
    const err = new OltProvisioningError('unreachable', 'timeout of 40000ms exceeded');

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0].map(String).join(' ');
    expect(line).toContain('SMARTOLT_UNREACHABLE');
    expect(line).toContain('timeout of 40000ms exceeded');
  });

  it('un DomainError 4xx NO se loguea (es un error del cliente, no de infraestructura)', () => {
    const res = mockRes();

    errorHandler(new NotFoundishError(), {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('un error NO tipado sigue logueando [UNHANDLED ERROR] como siempre', () => {
    const res = mockRes();

    errorHandler(new Error('boom'), {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[UNHANDLED ERROR]');
  });
});
