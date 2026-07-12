/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B6) — FireAndForgetChatMediaDownloadTrigger.
 * `requestDownload` MUST return synchronously (never await the actual download) and
 * MUST NOT let a rejected download escape as an unhandled promise rejection.
 */
import { FireAndForgetChatMediaDownloadTrigger } from '@infrastructure/adapters/chatwoot/FireAndForgetChatMediaDownloadTrigger';
import { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';

describe('FireAndForgetChatMediaDownloadTrigger', () => {
  it('requestDownload retorna sincrónico (no espera la descarga real)', () => {
    let resolveDownload!: () => void;
    const fakeUseCase = {
      execute: jest.fn(() => new Promise<void>((resolve) => { resolveDownload = resolve; })),
    } as unknown as DownloadChatMessageAttachment;
    const trigger = new FireAndForgetChatMediaDownloadTrigger(fakeUseCase);

    const returned = trigger.requestDownload('att-1');

    expect(returned).toBeUndefined(); // void, no promesa devuelta al llamador
    expect(fakeUseCase.execute).toHaveBeenCalledWith('att-1');
    resolveDownload();
  });

  it('si la descarga rechaza, NO escapa como unhandled rejection (se loguea, no se propaga)', async () => {
    const fakeUseCase = {
      execute: jest.fn().mockRejectedValue(new Error('network down')),
    } as unknown as DownloadChatMessageAttachment;
    const trigger = new FireAndForgetChatMediaDownloadTrigger(fakeUseCase);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => trigger.requestDownload('att-2')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve)); // let the rejected promise settle

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
