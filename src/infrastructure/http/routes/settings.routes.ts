import { Router, Request, Response } from 'express';
import { GetSystemSettings } from '@application/use-cases/GetSystemSettings';
import { UpdateSystemSettings } from '@application/use-cases/UpdateSystemSettings';
import { GetEmailSettings } from '@application/use-cases/GetEmailSettings';
import { UpdateEmailSettings } from '@application/use-cases/UpdateEmailSettings';
import { ListTemplates } from '@application/use-cases/ListTemplates';
import { UpdateTemplate } from '@application/use-cases/UpdateTemplate';
import { ListApiTokens } from '@application/use-cases/ListApiTokens';
import { CreateApiToken } from '@application/use-cases/CreateApiToken';
import { RevokeApiToken } from '@application/use-cases/RevokeApiToken';
import { GetFinanceSettings } from '@application/use-cases/GetFinanceSettings';
import { UpdateFinanceSettings } from '@application/use-cases/UpdateFinanceSettings';
import { ListPaymentMethods } from '@application/use-cases/ListPaymentMethods';
import { CreatePaymentMethod } from '@application/use-cases/CreatePaymentMethod';
import { UpdatePaymentMethod } from '@application/use-cases/UpdatePaymentMethod';
import { DeletePaymentMethod } from '@application/use-cases/DeletePaymentMethod';
import { ListWebhooks } from '@application/use-cases/ListWebhooks';
import { CreateWebhook } from '@application/use-cases/CreateWebhook';
import { DeleteWebhook } from '@application/use-cases/DeleteWebhook';
import { TestWebhook } from '@application/use-cases/TestWebhook';
import { ListBackups } from '@application/use-cases/ListBackups';
import { CreateBackup } from '@application/use-cases/CreateBackup';
import { GetClientPortalSettings } from '@application/use-cases/GetClientPortalSettings';
import { UpdateClientPortalSettings } from '@application/use-cases/UpdateClientPortalSettings';
import { SystemSettings, EmailSettings, MessageTemplate, FinanceSettings, PaymentMethod, TemplateVariable, Webhook, ClientPortalSettings } from '@domain/entities/settings';

export function createSettingsRouter(
  getSystemSettings: GetSystemSettings,
  updateSystemSettings: UpdateSystemSettings,
  getEmailSettings: GetEmailSettings,
  updateEmailSettings: UpdateEmailSettings,
  listTemplates: ListTemplates,
  updateTemplate: UpdateTemplate,
  listApiTokens: ListApiTokens,
  createApiToken: CreateApiToken,
  revokeApiToken: RevokeApiToken,
  getFinanceSettings?: GetFinanceSettings,
  updateFinanceSettings?: UpdateFinanceSettings,
  listPaymentMethods?: ListPaymentMethods,
  createPaymentMethod?: CreatePaymentMethod,
  updatePaymentMethod?: UpdatePaymentMethod,
  deletePaymentMethod?: DeletePaymentMethod,
  listWebhooks?: ListWebhooks,
  createWebhook?: CreateWebhook,
  deleteWebhook?: DeleteWebhook,
  testWebhook?: TestWebhook,
  listBackups?: ListBackups,
  createBackup?: CreateBackup,
  getClientPortalSettings?: GetClientPortalSettings,
  updateClientPortalSettings?: UpdateClientPortalSettings,
): Router {
  const router = Router();

  router.get('/system', async (_req: Request, res: Response): Promise<void> => {
    const settings = await getSystemSettings.execute();
    res.json(settings);
  });

  router.put('/system', async (req: Request, res: Response): Promise<void> => {
    const settings = await updateSystemSettings.execute(req.body as Partial<SystemSettings>);
    res.json(settings);
  });

  router.get('/email', async (_req: Request, res: Response): Promise<void> => {
    const settings = await getEmailSettings.execute();
    res.json(settings);
  });

  router.put('/email', async (req: Request, res: Response): Promise<void> => {
    const settings = await updateEmailSettings.execute(req.body as Partial<EmailSettings>);
    res.json(settings);
  });

  router.post('/email/test', async (_req: Request, res: Response): Promise<void> => {
    res.json({ success: true, message: 'Correo de prueba enviado correctamente.' });
  });

  router.get('/templates', async (_req: Request, res: Response): Promise<void> => {
    const templates = await listTemplates.execute();
    res.json(templates);
  });

  router.get('/template-variables', async (_req: Request, res: Response): Promise<void> => {
    const allVarsByType: Record<string, TemplateVariable[]> = {
      welcome: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'cliente.email', description: 'Email del cliente', example: 'juan@example.com' },
        { key: 'empresa.nombre', description: 'Nombre de la empresa', example: 'IPNEXT SA' },
      ],
      invoice: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'factura.numero', description: 'Número de factura', example: 'FAC-001234' },
        { key: 'factura.monto', description: 'Monto total de la factura', example: '6500.00' },
        { key: 'factura.vencimiento', description: 'Fecha de vencimiento', example: '15/05/2026' },
      ],
      payment: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'pago.monto', description: 'Monto del pago recibido', example: '6500.00' },
        { key: 'pago.fecha', description: 'Fecha en que se recibió el pago', example: '28/04/2026' },
      ],
      overdue: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'factura.numero', description: 'Número de factura vencida', example: 'FAC-001234' },
        { key: 'factura.monto', description: 'Monto adeudado', example: '6500.00' },
        { key: 'factura.vencimiento', description: 'Fecha de vencimiento', example: '01/04/2026' },
      ],
    };
    res.json(allVarsByType);
  });

  router.put('/templates/:id', async (req: Request, res: Response): Promise<void> => {
    const template = await updateTemplate.execute(
      req.params['id'] as string,
      req.body as Partial<MessageTemplate>,
    );
    if (!template) {
      res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      return;
    }
    res.json(template);
  });

  router.get('/api-tokens', async (_req: Request, res: Response): Promise<void> => {
    const tokens = await listApiTokens.execute();
    res.json(tokens);
  });

  router.post('/api-tokens', async (req: Request, res: Response): Promise<void> => {
    const { name, permissions } = req.body as { name: string; permissions: string[] };
    const token = await createApiToken.execute(name, permissions);
    res.status(201).json(token);
  });

  router.delete('/api-tokens/:id', async (req: Request, res: Response): Promise<void> => {
    const revoked = await revokeApiToken.execute(req.params['id'] as string);
    if (!revoked) {
      res.status(404).json({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  if (getFinanceSettings) {
    router.get('/finance', async (_req: Request, res: Response): Promise<void> => {
      const settings = await getFinanceSettings.execute();
      res.json(settings);
    });
  }

  if (updateFinanceSettings) {
    router.put('/finance', async (req: Request, res: Response): Promise<void> => {
      const settings = await updateFinanceSettings.execute(req.body as Partial<FinanceSettings>);
      res.json(settings);
    });
  }

  if (listPaymentMethods) {
    router.get('/payment-methods', async (_req: Request, res: Response): Promise<void> => {
      const methods = await listPaymentMethods.execute();
      res.json(methods);
    });
  }

  if (createPaymentMethod) {
    router.post('/payment-methods', async (req: Request, res: Response): Promise<void> => {
      const method = await createPaymentMethod.execute(req.body as Omit<PaymentMethod, 'id'>);
      res.status(201).json(method);
    });
  }

  if (updatePaymentMethod) {
    router.put('/payment-methods/:id', async (req: Request, res: Response): Promise<void> => {
      const method = await updatePaymentMethod.execute(req.params['id'] as string, req.body as Partial<PaymentMethod>);
      if (!method) {
        res.status(404).json({ error: 'Payment method not found', code: 'PAYMENT_METHOD_NOT_FOUND' });
        return;
      }
      res.json(method);
    });
  }

  if (deletePaymentMethod) {
    router.delete('/payment-methods/:id', async (req: Request, res: Response): Promise<void> => {
      const deleted = await deletePaymentMethod.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Payment method not found', code: 'PAYMENT_METHOD_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    });
  }

  // Webhooks
  if (listWebhooks) {
    router.get('/webhooks', async (_req: Request, res: Response): Promise<void> => {
      const webhooks = await listWebhooks.execute();
      res.json(webhooks);
    });
  }

  if (createWebhook) {
    router.post('/webhooks', async (req: Request, res: Response): Promise<void> => {
      const webhook = await createWebhook.execute(req.body as Omit<Webhook, 'id' | 'createdAt' | 'lastTriggered' | 'lastStatus'>);
      res.status(201).json(webhook);
    });
  }

  if (deleteWebhook) {
    router.delete('/webhooks/:id', async (req: Request, res: Response): Promise<void> => {
      const deleted = await deleteWebhook.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    });
  }

  if (testWebhook) {
    router.post('/webhooks/:id/test', async (req: Request, res: Response): Promise<void> => {
      const result = await testWebhook.execute(req.params['id'] as string);
      res.json(result);
    });
  }

  // Backups
  if (listBackups) {
    router.get('/backups', async (_req: Request, res: Response): Promise<void> => {
      const backups = await listBackups.execute();
      res.json(backups);
    });
  }

  if (createBackup) {
    router.post('/backups', async (_req: Request, res: Response): Promise<void> => {
      const backup = await createBackup.execute();
      res.status(201).json(backup);
    });
  }

  router.get('/backups/:id/download', (_req: Request, res: Response): void => {
    res.json({ message: 'Download started' });
  });

  // Client Portal
  if (getClientPortalSettings) {
    router.get('/client-portal', async (_req: Request, res: Response): Promise<void> => {
      const settings = await getClientPortalSettings.execute();
      res.json(settings);
    });
  }

  if (updateClientPortalSettings) {
    router.put('/client-portal', async (req: Request, res: Response): Promise<void> => {
      const settings = await updateClientPortalSettings.execute(req.body as Partial<ClientPortalSettings>);
      res.json(settings);
    });
  }

  return router;
}
