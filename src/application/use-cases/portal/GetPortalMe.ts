import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalMeDto } from '@application/dto/portal/portalMe.dto';

/**
 * GetPortalMe — customer-portal-api (Fase 4, task 4.1).
 *
 * portal-self-service spec "Mi resumen": el `clientId` SIEMPRE llega del token
 * (`req.portalClientId`, seteado por `portalAuthMiddleware`) — este use case no
 * acepta ni resuelve ningun otro origen (anti-IDOR estructural, spec "Anclaje al
 * cliente del token").
 *
 * fix/portal-balance-from-invoices — el saldo YA NO sale de `Client.balanceDue`
 * (el agregado que escribe el sync de GR). Medido en prod: GR puede reportar
 * `balanceDue = 0` mientras `Invoice` (espejo local de Prominense) tiene
 * facturas vencidas impagas — el cliente veria "saldo $0" arriba y facturas con
 * boton "Pagar" abajo, una contradiccion de cara al cliente. Ahora el saldo lo
 * CALCULA Prominense sobre sus propias facturas via
 * `CustomerRepository.getPortalBalanceSummary` (agregado en DB, ver
 * `PrismaCustomerRepository.getPortalBalanceSummary`) — el numero y la lista de
 * `ListPortalInvoices` SIEMPRE salen del mismo dato, nunca pueden contradecirse.
 *
 * fix wave (multi-moneda) — `getPortalBalanceSummary` YA NO agrega TODAS las
 * facturas impagas en un solo numero: medido en prod, `Invoice.currency`
 * tiene facturas en `PES`/`DOL` (codigos de GR, no ISO) y algunos clientes
 * tienen impagas en las DOS al mismo tiempo — sumarlas era basura (mezclaba
 * pesos con dolares). Ahora devuelve `balances`, un array CON UNA ENTRADA POR
 * MONEDA ISO, que este use case pasa directo al DTO (ya viene ordenado por
 * `amount` DESC y con la moneda normalizada — ver `normalizeGrCurrency` /
 * `PrismaCustomerRepository.toPortalBalanceSummary`).
 */
export class GetPortalMe {
  constructor(private readonly customers: CustomerRepository) {}

  async execute(clientId: string): Promise<PortalMeDto> {
    const client = await this.customers.findById(clientId);
    const summary = await this.customers.getPortalBalanceSummary(clientId);
    return {
      name: client.name,
      status: client.status,
      // `balances: null` = el cliente no tiene NINGUNA factura espejada ("sin
      // datos", genuinamente no sabemos). `[{currency, amount: 0}]` = tiene
      // facturas y TODAS estan pagadas ("al dia"). Jamas se colapsa null a []
      // (spec "Cliente sin saldo fetcheado" — ahora "sin facturas espejadas").
      balances: summary ? summary.balances : null,
      lastBalanceAt: summary ? summary.lastUpdatedAt : null,
    };
  }
}
