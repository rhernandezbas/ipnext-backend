import { IClassResultCode } from '@domain/entities/iclass-result-code';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';

/** List the result-code catalog, optionally filtered to mapped/unmapped entries. */
export class ListIClassResultCodes {
  constructor(private readonly repo: IClassResultCodeRepository) {}

  async execute(filter?: { mapped?: boolean }): Promise<IClassResultCode[]> {
    return this.repo.list(filter);
  }
}
