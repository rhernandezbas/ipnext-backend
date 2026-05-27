import { MirrorCountsRepository } from '@domain/ports/MirrorCountsRepository';

export class InMemoryMirrorCountsRepository implements MirrorCountsRepository {
  private _clientCount = 0;
  private _contractCount = 0;

  setClientCount(n: number): void {
    this._clientCount = n;
  }

  setContractCount(n: number): void {
    this._contractCount = n;
  }

  async clientCount(): Promise<number> {
    return this._clientCount;
  }

  async contractCount(): Promise<number> {
    return this._contractCount;
  }
}
