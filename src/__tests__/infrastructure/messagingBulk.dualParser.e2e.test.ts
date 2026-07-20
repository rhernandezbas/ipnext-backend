/**
 * bulk-csv-recipients (fix wave, C1) — dual-parser e2e guard for `/api/messaging/bulk`.
 *
 * Review finding (CRITICAL): `messagingBulk.routes.test.ts`'s `buildApp()` mounted
 * its OWN `express.json({ limit: '2mb' })` directly on a fresh `express()` app —
 * decoupled from `app.ts`. In PROD, `app.ts:884` registers a GLOBAL
 * `express.json()` with NO limit override for `/api/messaging/bulk` (Express
 * default: 100kb). A realistic CSV (~2000 contacts already exceeds 100kb — the
 * business cap, CSV-5, is 5000 rows) got a 413 from the body-parser BEFORE the
 * router ever saw the body — `/segment/preview`, `/segment/recipients` and
 * `/campaigns` were unusable, and the `TooManyManualContactsError` 422 was
 * unreachable in prod. The feature was dead on arrival.
 *
 * Fix (`app.ts`): a path-scoped `express.json({ limit: '2mb' })` on
 * `/api/messaging/bulk`, registered BEFORE the global parser — same pattern as
 * the ticket-comments (`:875`) and messaging-inbox (`:883`) overrides (body-parser's
 * `req._body` guard makes the second/global parse a no-op, same safety net).
 *
 * Booting `createApp()` needs a live DB (see `ticket-comments-composition.test.ts`),
 * so — mirroring `ticketComments.dualParser.e2e.test.ts`, the established pattern
 * for this EXACT bug class — this file mounts BOTH parsers in PROD ORDER on a
 * minimal replica with the REAL router (real use cases; fakes only for the
 * external `CampaignSegmentSource`/`TemplateMessagingPort` ports, same T3.2/T3.3
 * convention as `messagingBulk.routes.test.ts`) and exercises both ends:
 *   - a realistic ~2000-row `manualContacts` CSV (>100kb, <2mb) → NOT 413
 *   - a >2MB body → STILL 413 (the scoped ceiling fires — no-limit is NOT the fix)
 *
 * `messaging-bulk-composition.test.ts` (k) statically pins that `app.ts` really
 * registers this scoped parser BEFORE the global one (the SOURCE); this file
 * proves it FUNCTIONALLY (a real payload sails through under the REAL PROD ORDER).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createMessagingBulkRouter, MessagingBulkRoutePerms } from '../../infrastructure/http/routes/messagingBulk.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ListTemplates } from '../../application/use-cases/messaging/ListTemplates';
import { PreviewCampaignSegment } from '../../application/use-cases/messaging/PreviewCampaignSegment';
import { ListSegmentRecipients } from '../../application/use-cases/messaging/ListSegmentRecipients';
import { CreateCampaign } from '../../application/use-cases/messaging/CreateCampaign';
import { AuthorizeCampaignSend } from '../../application/use-cases/messaging/AuthorizeCampaignSend';
import { GetCampaign } from '../../application/use-cases/messaging/GetCampaign';
import { ListCampaigns } from '../../application/use-cases/messaging/ListCampaigns';
import { InMemoryCampaignRepository } from '../../infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryDistributedLock } from '../../infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { CampaignRunner, CampaignSender } from '../../infrastructure/scheduling/CampaignRunner';
import type { CampaignSegmentSource, CampaignRecipientCandidate, ManualRecipientSource } from '../../domain/ports/CustomerRepository';
import type { TemplateMessagingPort, TemplateDto } from '../../domain/ports/TemplateMessagingPort';

function makeSegmentSource(candidates: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return { listSegmentRecipients: jest.fn().mockResolvedValue(candidates) };
}
function makeManualSource(): ManualRecipientSource {
  return { findRecipientCandidatesByIds: jest.fn(async () => []) };
}
function makeTemplatePort(): TemplateMessagingPort {
  return { listTemplates: jest.fn().mockResolvedValue([]), sendTemplate: jest.fn() };
}

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { user: unknown }).user = { id: 'user-test', email: 'test@test.com' };
  next();
};
const allowPerm: RequestHandler = (_req, _res, next) => next();

/**
 * Mounts the two parsers in PROD ORDER (mirrors `app.ts` :~884 after the C1
 * fix): path-scoped 2mb parser for `/api/messaging/bulk` FIRST, then the global
 * default (100kb) parser. Plus the REAL router (real use cases, fakes only for
 * the external ports) — molde `messagingBulk.routes.test.ts` buildApp().
 */
function buildProdReplica() {
  const app = express();

  app.use('/api/messaging/bulk', express.json({ limit: '2mb' })); // mirrors app.ts C1 fix
  app.use(express.json()); // default 100kb — must NOT win for this path

  const campaignRepo = new InMemoryCampaignRepository();
  const templatePort = makeTemplatePort();
  const segmentSource = makeSegmentSource([]);
  const manualSource = makeManualSource();

  const listTemplates = new ListTemplates(templatePort);
  const previewCampaignSegment = new PreviewCampaignSegment(segmentSource, manualSource);
  const listSegmentRecipients = new ListSegmentRecipients(segmentSource, manualSource);
  const createCampaign = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);
  const getCampaign = new GetCampaign(campaignRepo);
  const listCampaigns = new ListCampaigns(campaignRepo);
  const lock = new InMemoryDistributedLock();
  const sendCampaign: CampaignSender = { execute: jest.fn().mockResolvedValue(undefined) };
  const campaignRunner = new CampaignRunner(sendCampaign, campaignRepo, lock);

  const perms: MessagingBulkRoutePerms = { bulk: allowPerm, templates: allowPerm };
  const authorizeCampaignSend = new AuthorizeCampaignSend(campaignRepo);
  const resolveBulkActions = async (_userId: string): Promise<string[]> => ['*'];

  app.use(
    '/api/messaging/bulk',
    createMessagingBulkRouter(
      listTemplates,
      previewCampaignSegment,
      listSegmentRecipients,
      createCampaign,
      campaignRunner,
      getCampaign,
      listCampaigns,
      allowAuth,
      perms,
      authorizeCampaignSend,
      resolveBulkActions,
    ),
  );
  app.use(errorHandler);

  return { app };
}

/**
 * ~N filas {name, phone} — molde CSV-5(c) de messagingBulk.routes.test.ts. Los
 * teléfonos son NSN(10) VÁLIDOS (área "3364" + abonado de 6 dígitos único por
 * fila) — `toWhatsAppE164` los reconstruye directo (rama `digits.length===10`,
 * sin necesitar el stripping del "15" embebido), así que ninguno cae en
 * `telefono_invalido` y el preview los cuenta como `no_cliente` (universo vacío).
 */
function manyContacts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Cliente de Prueba Numero ${i}`,
    phone: `3364${String(400000 + i).padStart(6, '0')}`,
  }));
}

describe('/api/messaging/bulk — body-parser 413 e2e guard (fix wave C1)', () => {
  it('CSV realista de ~2000 filas (>100kb del default global, <2mb del scoped) → NO 413, el preview resuelve normal', async () => {
    const { app } = buildProdReplica();
    const contacts = manyContacts(2000);
    const bodyBytes = Buffer.byteLength(JSON.stringify({ statuses: [], manualContacts: contacts }));
    expect(bodyBytes).toBeGreaterThan(100 * 1024); // guard: el payload REALMENTE supera el default global

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: [], manualContacts: contacts });

    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200); // el parser scoped lo dejó pasar — preview resuelve normal
    expect(res.body.count).toBe(2000); // sin match en el universo (vacío) → 2000 crudos no_cliente
  });

  it('body >2MB → SIGUE dando 413 — el techo scoped funciona (sin límite NO es el fix)', async () => {
    const { app } = buildProdReplica();
    const huge = JSON.stringify({ statuses: [], manualContacts: [], _filler: 'x'.repeat(3 * 1024 * 1024) });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .set('Content-Type', 'application/json')
      .send(huge);

    expect(res.status).toBe(413);
  });
});
