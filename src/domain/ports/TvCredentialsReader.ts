/**
 * #65 fix wave H3 — read-side port for the TV credentials of a customer.
 *
 * The credentials live on the Gigared-managed TV ContractService row of the customer's contract.
 * This port resolves them WITHOUT a status filter, so the login/password survive an inactive row
 * (M8 — a rebaja leaves the row inactive but the operator must still be able to read them until a
 * baja explicitly clears them, M6). Returns null when the customer has no TV row at all.
 */
export interface TvCredentials {
  login: string | null;
  password: string | null;
  /**
   * #81 — el internal_id VIGENTE de la cuenta de TV del cliente (currentTvInternalId(id, seq)).
   * Lo computa GetTvCredentials desde el seq del cliente, NO el reader. Opcional para no romper
   * a los adapters/tests que sólo proveen login/password (back-compat). El FE lo muestra en
   * Credenciales para que el operador vea la identidad actual (seq=0 → Client.id pelado).
   */
  internalId?: string | null;
}

export interface TvCredentialsReader {
  getByCustomer(customerId: string): Promise<TvCredentials | null>;
}
