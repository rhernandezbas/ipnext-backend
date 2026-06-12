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
}

export interface TvCredentialsReader {
  getByCustomer(customerId: string): Promise<TvCredentials | null>;
}
