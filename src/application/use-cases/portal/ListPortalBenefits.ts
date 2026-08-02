import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoResponseRepository } from '@domain/ports/PortalPromoResponseRepository';
import type { PortalPromo, PortalPromoResponse } from '@domain/entities/portalPromo';
import type { CustomerRepository, SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { PortalBenefitsDto, PortalActiveBenefitDto } from '@application/dto/portal/portalBenefits.dto';
import { toPortalPromoSummaryDto } from '@application/dto/portal/portalPromo.dto';

/**
 * ListPortalBenefits — portal-benefits, `GET /api/portal/benefits`.
 *
 * La app de clientes ya tiene Promociones: una tarjeta en Inicio que el
 * cliente puede aceptar ("Me interesa" → abre un reclamo) o descartar
 * ("Ahora no" → desaparece de Inicio para siempre). El catálogo (esta
 * pantalla) existe PRECISAMENTE para que "para siempre" deje de ser cierto —
 * el cliente puede volver a buscar algo que descartó.
 *
 * ## `available` — EL PUNTO DE ESTE CHANGE
 *
 * Mismas condiciones de tiempo/publicación/segmento que `ListPortalPromos`
 * (Inicio): `PortalPromoRepository.listActive` + `SegmentMembershipChecker
 * .clientMatchesSegment` (la MISMA función, nunca reimplementada — ver el
 * docblock de `SegmentMembershipChecker`). La diferencia deliberada: acá SOLO
 * se excluyen las promos con `kind='interested'` (ya aceptadas → viven en
 * `active`). Las `kind='dismissed'` SIGUEN apareciendo — si el catálogo
 * también las escondiera, no serviría para nada. NO "unificar" con
 * `ListPortalPromos.execute` (que excluye AMBOS kinds): son dos preguntas de
 * negocio distintas ("¿qué no vi/decidí todavía?" vs "¿qué puedo activar
 * ahora, haya pasado por acá antes o no?"), aunque comparten los mismos dos
 * building blocks (`listActive` + `clientMatchesSegment`).
 *
 * ## `active` — lo que el cliente YA tiene
 *
 * Tres orígenes, ninguno inventado (nada de tablas/columnas nuevas):
 *  - `promo`:   promos con `PortalPromoResponse.kind='interested'` de este
 *               cliente. `detail` = `Reclamo #<sequenceNumber>` del ticket
 *               que ese "Me interesa" abrió, o `null` si el ticket ya no
 *               existe (`ticketId` con `onDelete: SetNull` en el schema).
 *  - `service`: `ContractService` ACTIVOS de contratos ACTIVOS (reusa
 *               `CustomerRepository.listContracts`, el mismo port que
 *               `ListPortalPlans`/`GET /plans` — nunca una query nueva).
 *  - `tenure`:  UNA sola entrada con el `startDate` MÁS VIEJO entre TODOS los
 *               contratos del cliente (activos o no — la antigüedad de la
 *               relación no depende de si el contrato sigue activo hoy).
 *               Ausente si el cliente no tiene contratos (nunca "Cliente
 *               desde Invalid Date").
 *
 * DELIBERADAMENTE FUERA DE ALCANCE (decisión del usuario): descuentos del
 * abono y débito automático. Esos datos viven en GR, no en Prominense
 * (verificado: cero columnas `discount`/`price`/`paymentMethod` en todo el
 * schema) — se agregan cuando Prominense facture. No agregar columnas ni
 * modelos acá para eso.
 *
 * ## Orden
 *
 * `available`: mismo criterio que `ListPortalPromos` — `publishedAt` desc
 * (más reciente primero), consistencia con lo que el cliente ya vio en
 * Inicio.
 *
 * `active`: agrupado por `kind` en el orden `promo → service → tenure` (el
 * mismo orden del ejemplo de la spec) — promos primero porque son la acción
 * más específica/reciente del cliente, servicios como el catálogo estable de
 * lo que tiene, tenure al final como dato de contexto/cierre. Dentro de cada
 * grupo, por `since`: `promo` desc (lo último que aceptaste arriba, como un
 * feed), `service` asc (el orden en que el cliente fue sumando servicios,
 * lectura cronológica natural). `tenure` es un único elemento, no aplica.
 */
export class ListPortalBenefits {
  constructor(
    private readonly promos: Pick<PortalPromoRepository, 'listActive' | 'findById'>,
    private readonly responses: Pick<PortalPromoResponseRepository, 'listByClient'>,
    private readonly segmentChecker: Pick<SegmentMembershipChecker, 'clientMatchesSegment'>,
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly tickets: Pick<TicketRepository, 'getById'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(clientId: string): Promise<PortalBenefitsDto> {
    const now = this.clock();
    // 3 queries independientes, en paralelo — ninguna depende del resultado
    // de otra (mismo criterio que el resto del portal: batch, nunca N+1).
    const [activePromos, responses, contracts] = await Promise.all([
      this.promos.listActive(now),
      this.responses.listByClient(clientId),
      this.customers.listContracts(clientId),
    ]);

    const available = await this.buildAvailable(clientId, activePromos, responses);
    const active = await this.buildActive(responses, contracts);
    return { available, active };
  }

  private async buildAvailable(
    clientId: string,
    activePromos: PortalPromo[],
    responses: PortalPromoResponse[],
  ): Promise<PortalBenefitsDto['available']> {
    const acceptedIds = new Set(
      responses.filter((r) => r.kind === 'interested').map((r) => r.promoId),
    );
    // EL PUNTO DEL CHANGE: solo se excluyen las ACEPTADAS. Las descartadas
    // (`dismissed`, NO están en `acceptedIds`) siguen siendo candidatas.
    const candidates = activePromos.filter((p) => !acceptedIds.has(p.id));

    // Chequeo de segmento por promo candidata — mismo patrón (y misma
    // justificación de "pocas decenas activas, nunca miles") que
    // `ListPortalPromos.execute`.
    const visible: PortalPromo[] = [];
    for (const promo of candidates) {
      const matches = await this.segmentChecker.clientMatchesSegment(clientId, promo.segment);
      if (matches) visible.push(promo);
    }

    visible.sort((a, b) => (a.publishedAt! < b.publishedAt! ? 1 : -1));
    return visible.map(toPortalPromoSummaryDto);
  }

  private async buildActive(
    responses: PortalPromoResponse[],
    contracts: Contract[],
  ): Promise<PortalActiveBenefitDto[]> {
    const promoEntries = await this.buildPromoEntries(responses);
    const serviceEntries = this.buildServiceEntries(contracts);
    const tenureEntry = this.buildTenureEntry(contracts);
    return [...promoEntries, ...serviceEntries, ...(tenureEntry ? [tenureEntry] : [])];
  }

  private async buildPromoEntries(responses: PortalPromoResponse[]): Promise<PortalActiveBenefitDto[]> {
    const accepted = responses.filter((r) => r.kind === 'interested');
    const entries: PortalActiveBenefitDto[] = [];
    for (const r of accepted) {
      // N+1 deliberado y ACOTADO: "promos que ESTE cliente aceptó" — un
      // puñado, nunca miles (mismo criterio que el chequeo de segmento por
      // promo de `ListPortalPromos`/`buildAvailable` arriba). No hay un
      // `PortalPromoRepository.findByIds` batch hoy y agregarlo solo para
      // este caso acotado no se justifica.
      const promo = await this.promos.findById(r.promoId);
      if (!promo) continue; // defensivo — no debería pasar (promos no se hard-delete).

      let detail: string | null = null;
      if (r.ticketId) {
        // Mismo motivo N+1 acotado que arriba: un ticket por promo aceptada.
        const ticket = await this.tickets.getById(r.ticketId);
        if (ticket) detail = `Reclamo #${ticket.sequenceNumber}`;
        // ticket null (SetNull tras un borrado) => detail se queda en null.
      }
      entries.push({ kind: 'promo', title: promo.title, detail, since: r.createdAt });
    }
    entries.sort((a, b) => (a.since < b.since ? 1 : -1)); // más reciente primero.
    return entries;
  }

  private buildServiceEntries(contracts: Contract[]): PortalActiveBenefitDto[] {
    const entries: PortalActiveBenefitDto[] = [];
    for (const contract of contracts) {
      if (contract.status !== 'active') continue;
      for (const service of contract.services) {
        if (service.status !== 'active') continue;
        entries.push({
          kind: 'service',
          title: service.name,
          detail: `Incluido en tu plan ${contract.plan}`,
          since: service.createdAt,
        });
      }
    }
    entries.sort((a, b) => (a.since < b.since ? -1 : 1)); // orden de adquisición, más antiguo primero.
    return entries;
  }

  private buildTenureEntry(contracts: Contract[]): PortalActiveBenefitDto | null {
    if (contracts.length === 0) return null;
    const oldest = contracts.reduce((min, c) => (c.startDate < min.startDate ? c : min));
    return {
      kind: 'tenure',
      title: `Cliente desde ${formatSpanishMonthYear(new Date(oldest.startDate))}`,
      detail: null,
      since: oldest.startDate,
    };
  }
}

/** "2025-09-15T..." -> "septiembre 2025" (AR timezone, sin el "de" que agrega Intl por defecto). */
function formatSpanishMonthYear(d: Date): string {
  const month = new Intl.DateTimeFormat('es-AR', {
    month: 'long',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
  const year = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
  return `${month} ${year}`;
}
