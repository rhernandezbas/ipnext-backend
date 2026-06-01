import { ScrapedOSDetail } from '@domain/entities/iclass-portal';

/**
 * Upstream port for the IClass SEAM portal (`fs2.iclass.com.br`). The adapter
 * owns the portal session (cookie login), the read-only GET to the closure page
 * and the HTML parsing; the application layer only sees this contract.
 *
 * A GET to `baixa_os_validada.seam?osId=...&transicaoId=47` is non-mutating
 * (verified) — it never submits "Terminar OS".
 */
export interface IClassPortalPort {
  /** Fetch + parse the closure page for one SO (by numeric IClass id = osId). */
  getOSDetail(osId: string): Promise<ScrapedOSDetail>;
}
