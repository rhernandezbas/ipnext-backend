import express, { Router, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { SplynxClient } from '../adapters/splynx/SplynxClient';
import { SplynxCustomerAdapter } from '../adapters/splynx/SplynxCustomerAdapter';
import { SplynxTicketAdapter } from '../adapters/splynx/SplynxTicketAdapter';
import { SplynxBillingAdapter } from '../adapters/splynx/SplynxBillingAdapter';
import { JwtAuthAdapter } from '../adapters/jwt/JwtAuthAdapter';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { GetClientServices } from '@application/use-cases/GetClientServices';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetBillingSummary } from '@application/use-cases/GetBillingSummary';
import { ListInvoices } from '@application/use-cases/ListInvoices';
import { ListPayments } from '@application/use-cases/ListPayments';
import { ListTransactions } from '@application/use-cases/ListTransactions';
import { GetClientComments } from '@application/use-cases/GetClientComments';
import { CreateClientComment } from '@application/use-cases/CreateClientComment';
import { GetMonthlyBilling } from '@application/use-cases/GetMonthlyBilling';
import { InMemoryClientCommentRepository } from '../adapters/prisma/PrismaClientCommentRepository';
import { InMemoryMonthlyBillingRepository } from '../adapters/in-memory/InMemoryMonthlyBillingRepository';
import { createAuthRouter } from './routes/auth.routes';
import { createClientsRouter } from './routes/clients.routes';
import { createTicketsRouter } from './routes/tickets.routes';
import { createBillingRouter } from './routes/billing.routes';
import { createCreditNotesRouter } from './routes/creditNotes.routes';
import { createProformasRouter } from './routes/proformas.routes';
import { createFinanceHistoryRouter } from './routes/financeHistory.routes';
import { createClientCommentsRouter } from './routes/clientComments.routes';
import { createBillingMonthlyRouter } from './routes/billingMonthly.routes';
import { createAdminRouter } from './routes/admin.routes';
import { InMemoryAdminRepository } from '../adapters/prisma/PrismaAdminRepository';
import { createSettingsRouter } from './routes/settings.routes';
import { InMemorySettingsRepository } from '../adapters/prisma/PrismaSettingsRepository';
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
import { createSchedulingRouter } from './routes/scheduling.routes';
import { InMemorySchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '@application/use-cases/UpdateTaskStatus';
import { createVozRouter } from './routes/voz.routes';
import { InMemoryVozRepository } from '../adapters/prisma/PrismaVozRepository';
import { ListVoipCategories } from '@application/use-cases/ListVoipCategories';
import { CreateVoipCategory } from '@application/use-cases/CreateVoipCategory';
import { ListVoipCdrs } from '@application/use-cases/ListVoipCdrs';
import { ListVoipPlans } from '@application/use-cases/ListVoipPlans';
import { CreateVoipPlan } from '@application/use-cases/CreateVoipPlan';
import { ListAdmins } from '@application/use-cases/ListAdmins';
import { GetAdmin } from '@application/use-cases/GetAdmin';
import { CreateAdmin } from '@application/use-cases/CreateAdmin';
import { UpdateAdmin } from '@application/use-cases/UpdateAdmin';
import { DeleteAdmin } from '@application/use-cases/DeleteAdmin';
import { GetAdminActivityLog } from '@application/use-cases/GetAdminActivityLog';
import { Get2FAStatus } from '@application/use-cases/Get2FAStatus';
import { Enable2FA } from '@application/use-cases/Enable2FA';
import { Disable2FA } from '@application/use-cases/Disable2FA';
import { createEmpresaRouter } from './routes/empresa.routes';
import { InMemoryEmpresaRepository } from '../adapters/prisma/PrismaEmpresaRepository';
import { createPartnerRouter } from './routes/partner.routes';
import { InMemoryPartnerRepository } from '../adapters/prisma/PrismaPartnerRepository';
import { ListPartners } from '@application/use-cases/ListPartners';
import { GetPartner } from '@application/use-cases/GetPartner';
import { CreatePartner } from '@application/use-cases/CreatePartner';
import { UpdatePartner } from '@application/use-cases/UpdatePartner';
import { DeletePartner } from '@application/use-cases/DeletePartner';
import { createRoleRouter } from './routes/role.routes';
import { InMemoryRoleRepository } from '../adapters/prisma/PrismaRoleRepository';
import { ListRoles } from '@application/use-cases/ListRoles';
import { GetRole } from '@application/use-cases/GetRole';
import { CreateRole } from '@application/use-cases/CreateRole';
import { UpdateRole } from '@application/use-cases/UpdateRole';
import { DeleteRole } from '@application/use-cases/DeleteRole';
import { ListServicePlans } from '@application/use-cases/ListServicePlans';
import { GetServicePlan } from '@application/use-cases/GetServicePlan';
import { CreateServicePlan } from '@application/use-cases/CreateServicePlan';
import { UpdateServicePlan } from '@application/use-cases/UpdateServicePlan';
import { DeleteServicePlan } from '@application/use-cases/DeleteServicePlan';
import { ListNetworkDevices } from '@application/use-cases/ListNetworkDevices';
import { GetNetworkDevice } from '@application/use-cases/GetNetworkDevice';
import { CreateNetworkDevice } from '@application/use-cases/CreateNetworkDevice';
import { UpdateNetworkDevice } from '@application/use-cases/UpdateNetworkDevice';
import { DeleteNetworkDevice } from '@application/use-cases/DeleteNetworkDevice';
import { ListInventoryItems } from '@application/use-cases/ListInventoryItems';
import { GetInventoryItem } from '@application/use-cases/GetInventoryItem';
import { CreateInventoryItem } from '@application/use-cases/CreateInventoryItem';
import { UpdateInventoryItem } from '@application/use-cases/UpdateInventoryItem';
import { DeleteInventoryItem } from '@application/use-cases/DeleteInventoryItem';
import { ListInventoryProducts } from '@application/use-cases/ListInventoryProducts';
import { ListInventoryUnits } from '@application/use-cases/ListInventoryUnits';
import { CreateInventoryUnit } from '@application/use-cases/CreateInventoryUnit';
import { UpdateInventoryUnit } from '@application/use-cases/UpdateInventoryUnit';
import { UpdateInventoryProduct } from '@application/use-cases/UpdateInventoryProduct';
import { DeleteInventoryProduct } from '@application/use-cases/DeleteInventoryProduct';
import { DeleteInventoryUnit } from '@application/use-cases/DeleteInventoryUnit';
import { createIpNetworkRouter } from './routes/ipNetwork.routes';
import { InMemoryIpNetworkRepository } from '../adapters/prisma/PrismaIpNetworkRepository';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { DeleteIpPool } from '@application/use-cases/DeleteIpPool';
import { ListIpAssignments } from '@application/use-cases/ListIpAssignments';
import { createNasRouter } from './routes/nas.routes';
import { InMemoryNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { createDashboardRouter } from './routes/dashboard.routes';
import { InMemoryDashboardRepository } from '../adapters/prisma/PrismaDashboardRepository';
import { GetDashboardStats } from '@application/use-cases/GetDashboardStats';
import { GetDashboardShortcuts } from '@application/use-cases/GetDashboardShortcuts';
import { GetRecentActivity } from '@application/use-cases/GetRecentActivity';
import { createMessagesRouter } from './routes/messages.routes';
import { InMemoryMessageRepository } from '../adapters/prisma/PrismaMessageRepository';
import { ListMessages } from '@application/use-cases/ListMessages';
import { GetMessage } from '@application/use-cases/GetMessage';
import { CreateMessage } from '@application/use-cases/CreateMessage';
import { MarkMessageAsRead } from '@application/use-cases/MarkMessageAsRead';
import { DeleteMessage } from '@application/use-cases/DeleteMessage';
import { InMemoryCreditNoteRepository } from '../adapters/prisma/PrismaCreditNoteRepository';
import { InMemoryProformaRepository } from '../adapters/prisma/PrismaProformaRepository';
import { InMemoryFinanceHistoryRepository } from '../adapters/prisma/PrismaFinanceHistoryRepository';
import { ListCreditNotes } from '@application/use-cases/ListCreditNotes';
import { GetCreditNote } from '@application/use-cases/GetCreditNote';
import { CreateCreditNote } from '@application/use-cases/CreateCreditNote';
import { ApplyCreditNote } from '@application/use-cases/ApplyCreditNote';
import { VoidCreditNote } from '@application/use-cases/VoidCreditNote';
import { ListProformas } from '@application/use-cases/ListProformas';
import { CreateProforma } from '@application/use-cases/CreateProforma';
import { ConvertToInvoice } from '@application/use-cases/ConvertToInvoice';
import { CancelProforma } from '@application/use-cases/CancelProforma';
import { ListFinanceHistory } from '@application/use-cases/ListFinanceHistory';
import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { CreateNasServer } from '@application/use-cases/CreateNasServer';
import { UpdateNasServer } from '@application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '@application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '@application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '@application/use-cases/UpdateRadiusConfig';
import { createNetworkSiteRouter } from './routes/networkSite.routes';
import { InMemoryNetworkSiteRepository } from '../adapters/prisma/PrismaNetworkSiteRepository';
import { ListNetworkSites } from '@application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '@application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '@application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '@application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '@application/use-cases/DeleteNetworkSite';
import { createCpeRouter } from './routes/cpe.routes';
import { InMemoryCpeRepository } from '../adapters/prisma/PrismaCpeRepository';
import { ListCpeDevices } from '@application/use-cases/ListCpeDevices';
import { GetCpeDevice } from '@application/use-cases/GetCpeDevice';
import { CreateCpeDevice } from '@application/use-cases/CreateCpeDevice';
import { UpdateCpeDevice } from '@application/use-cases/UpdateCpeDevice';
import { DeleteCpeDevice } from '@application/use-cases/DeleteCpeDevice';
import { AssignCpeToClient } from '@application/use-cases/AssignCpeToClient';
import { createTr069Router } from './routes/tr069.routes';
import { InMemoryTr069Repository } from '../adapters/prisma/PrismaTr069Repository';
import { ListTr069Profiles } from '@application/use-cases/ListTr069Profiles';
import { CreateTr069Profile } from '@application/use-cases/CreateTr069Profile';
import { UpdateTr069Profile } from '@application/use-cases/UpdateTr069Profile';
import { DeleteTr069Profile } from '@application/use-cases/DeleteTr069Profile';
import { ListTr069Devices } from '@application/use-cases/ListTr069Devices';
import { ProvisionDevice } from '@application/use-cases/ProvisionDevice';
import { DeleteTr069Device } from '@application/use-cases/DeleteTr069Device';
import { ListIpv6Networks } from '@application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '@application/use-cases/CreateIpv6Network';
import { createHardwareRouter } from './routes/hardware.routes';
import { InMemoryHardwareRepository } from '../adapters/prisma/PrismaHardwareRepository';
import { ListHardwareAssets } from '@application/use-cases/ListHardwareAssets';
import { CreateHardwareAsset } from '@application/use-cases/CreateHardwareAsset';
import { UpdateHardwareAsset } from '@application/use-cases/UpdateHardwareAsset';
import { DeleteHardwareAsset } from '@application/use-cases/DeleteHardwareAsset';
import { DomainError } from '@domain/errors';
import { createGponRouter } from './routes/gpon.routes';
import { InMemoryGponRepository } from '../adapters/prisma/PrismaGponRepository';
import { ListOlts } from '@application/use-cases/ListOlts';
import { GetOlt } from '@application/use-cases/GetOlt';
import { CreateOlt } from '@application/use-cases/CreateOlt';
import { ListOnus } from '@application/use-cases/ListOnus';
import { GetOnu } from '@application/use-cases/GetOnu';
import { ListOnusByOlt } from '@application/use-cases/ListOnusByOlt';
import { CreateOnu } from '@application/use-cases/CreateOnu';
import { UpdateOnuStatus } from '@application/use-cases/UpdateOnuStatus';
import { createRadiusRouter } from './routes/radius.routes';
import { InMemoryRadiusSessionRepository } from '../adapters/prisma/PrismaRadiusSessionRepository';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { createLeadsRouter } from './routes/leads.routes';
import { InMemoryLeadRepository } from '../adapters/prisma/PrismaLeadRepository';
import { ListLeads } from '@application/use-cases/ListLeads';
import { GetLead } from '@application/use-cases/GetLead';
import { CreateLead } from '@application/use-cases/CreateLead';
import { UpdateLead } from '@application/use-cases/UpdateLead';
import { DeleteLead } from '@application/use-cases/DeleteLead';
import { ConvertLeadToClient } from '@application/use-cases/ConvertLeadToClient';
import { createUbicacionesRouter } from './routes/ubicaciones.routes';
import { InMemoryUbicacionRepository } from '../adapters/prisma/PrismaUbicacionRepository';
import { ListUbicaciones } from '@application/use-cases/ListUbicaciones';
import { GetUbicacion } from '@application/use-cases/GetUbicacion';
import { CreateUbicacion } from '@application/use-cases/CreateUbicacion';
import { UpdateUbicacion } from '@application/use-cases/UpdateUbicacion';
import { DeleteUbicacion } from '@application/use-cases/DeleteUbicacion';
import { createReportsRouter } from './routes/reports.routes';
import { InMemoryReportRepository } from '../adapters/in-memory/InMemoryReportRepository';
import { ListReportDefinitions } from '@application/use-cases/ListReportDefinitions';
import { GenerateReport } from '@application/use-cases/GenerateReport';
import { ExportReport } from '@application/use-cases/ExportReport';
import { createMonitoringRouter } from './routes/monitoring.routes';
import { PrismaMonitoringRepository } from '../adapters/prisma/PrismaMonitoringRepository';
import { GetMonitoringStats } from '@application/use-cases/GetMonitoringStats';
import { ListMonitoringDevices } from '@application/use-cases/ListMonitoringDevices';
import { ListMonitoringAlerts } from '@application/use-cases/ListMonitoringAlerts';
import { AcknowledgeAlert } from '@application/use-cases/AcknowledgeAlert';
import { createSearchRouter } from './routes/search.routes';
import { GlobalSearch } from '@application/use-cases/GlobalSearch';
import { createNotificationsRouter } from './routes/notifications.routes';
import { InMemoryNotificationRepository } from '../adapters/prisma/PrismaNotificationRepository';
import { ListNotifications } from '@application/use-cases/ListNotifications';
import { MarkNotificationRead } from '@application/use-cases/MarkNotificationRead';
import { MarkAllNotificationsRead } from '@application/use-cases/MarkAllNotificationsRead';
import { DeleteNotification } from '@application/use-cases/DeleteNotification';
import { profileRoutes } from './routes/profile.routes';

export function createApp() {
  const app = express();

  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  // Wire up adapters
  const splynxClient = new SplynxClient();
  const customerAdapter = new SplynxCustomerAdapter(splynxClient);
  const ticketAdapter = new SplynxTicketAdapter(splynxClient);
  const billingAdapter = new SplynxBillingAdapter(splynxClient);
  const authAdapter = new JwtAuthAdapter();

  // Wire up use cases
  const listClients = new ListClients(customerAdapter);
  const getDetail = new GetClientDetail(customerAdapter);
  const getServices = new GetClientServices(customerAdapter);
  const getInvoices = new GetClientInvoices(customerAdapter);
  const getLogs = new GetClientLogs(customerAdapter);
  const listTickets = new ListTickets(ticketAdapter);
  const getStats = new GetTicketStats(ticketAdapter);
  const createTicket = new CreateTicket(ticketAdapter);
  const getSummary = new GetBillingSummary(billingAdapter);
  const listInvoices = new ListInvoices(billingAdapter);
  const listPayments = new ListPayments(billingAdapter);
  const listTransactions = new ListTransactions(billingAdapter);

  const commentRepo = new InMemoryClientCommentRepository();
  const getComments = new GetClientComments(commentRepo);
  const createComment = new CreateClientComment(commentRepo);

  const monthlyRepo = new InMemoryMonthlyBillingRepository();
  const getMonthly = new GetMonthlyBilling(monthlyRepo);

  const settingsRepo = new InMemorySettingsRepository();
  const getSystemSettings = new GetSystemSettings(settingsRepo);
  const updateSystemSettings = new UpdateSystemSettings(settingsRepo);
  const getEmailSettings = new GetEmailSettings(settingsRepo);
  const updateEmailSettings = new UpdateEmailSettings(settingsRepo);
  const listTemplates = new ListTemplates(settingsRepo);
  const updateTemplate = new UpdateTemplate(settingsRepo);
  const listApiTokens = new ListApiTokens(settingsRepo);
  const createApiToken = new CreateApiToken(settingsRepo);
  const revokeApiToken = new RevokeApiToken(settingsRepo);
  const getFinanceSettings = new GetFinanceSettings(settingsRepo);
  const updateFinanceSettings = new UpdateFinanceSettings(settingsRepo);
  const listPaymentMethods = new ListPaymentMethods(settingsRepo);
  const createPaymentMethod = new CreatePaymentMethod(settingsRepo);
  const updatePaymentMethod = new UpdatePaymentMethod(settingsRepo);
  const deletePaymentMethod = new DeletePaymentMethod(settingsRepo);
  const listWebhooks = new ListWebhooks(settingsRepo);
  const createWebhook = new CreateWebhook(settingsRepo);
  const deleteWebhook = new DeleteWebhook(settingsRepo);
  const testWebhook = new TestWebhook(settingsRepo);
  const listBackups = new ListBackups(settingsRepo);
  const createBackup = new CreateBackup(settingsRepo);
  const getClientPortalSettings = new GetClientPortalSettings(settingsRepo);
  const updateClientPortalSettings = new UpdateClientPortalSettings(settingsRepo);

  const schedulingRepo = new InMemorySchedulingRepository();
  const listTasks = new ListTasks(schedulingRepo);
  const getTask = new GetTask(schedulingRepo);
  const createTask = new CreateTask(schedulingRepo);
  const updateTask = new UpdateTask(schedulingRepo);
  const deleteTask = new DeleteTask(schedulingRepo);
  const updateTaskStatus = new UpdateTaskStatus(schedulingRepo);

  const vozRepo = new InMemoryVozRepository();
  const listVoipCategories = new ListVoipCategories(vozRepo);
  const createVoipCategory = new CreateVoipCategory(vozRepo);
  const listVoipCdrs = new ListVoipCdrs(vozRepo);
  const listVoipPlans = new ListVoipPlans(vozRepo);
  const createVoipPlan = new CreateVoipPlan(vozRepo);

  const empresaRepo = new InMemoryEmpresaRepository();
  const listServicePlans = new ListServicePlans(empresaRepo);
  const getServicePlan = new GetServicePlan(empresaRepo);
  const createServicePlan = new CreateServicePlan(empresaRepo);
  const updateServicePlan = new UpdateServicePlan(empresaRepo);
  const deleteServicePlan = new DeleteServicePlan(empresaRepo);
  const listNetworkDevices = new ListNetworkDevices(empresaRepo);
  const getNetworkDevice = new GetNetworkDevice(empresaRepo);
  const createNetworkDevice = new CreateNetworkDevice(empresaRepo);
  const updateNetworkDevice = new UpdateNetworkDevice(empresaRepo);
  const deleteNetworkDevice = new DeleteNetworkDevice(empresaRepo);
  const listInventoryItems = new ListInventoryItems(empresaRepo);
  const getInventoryItem = new GetInventoryItem(empresaRepo);
  const createInventoryItem = new CreateInventoryItem(empresaRepo);
  const updateInventoryItem = new UpdateInventoryItem(empresaRepo);
  const deleteInventoryItem = new DeleteInventoryItem(empresaRepo);
  const listInventoryProducts = new ListInventoryProducts(empresaRepo);
  const listInventoryUnits = new ListInventoryUnits(empresaRepo);
  const createInventoryUnit = new CreateInventoryUnit(empresaRepo);
  const updateInventoryUnit = new UpdateInventoryUnit(empresaRepo);
  const updateInventoryProduct = new UpdateInventoryProduct(empresaRepo);
  const deleteInventoryProduct = new DeleteInventoryProduct(empresaRepo);
  const deleteInventoryUnit = new DeleteInventoryUnit(empresaRepo);

  const partnerRepo = new InMemoryPartnerRepository();
  const listPartners = new ListPartners(partnerRepo);
  const getPartner = new GetPartner(partnerRepo);
  const createPartner = new CreatePartner(partnerRepo);
  const updatePartner = new UpdatePartner(partnerRepo);
  const deletePartner = new DeletePartner(partnerRepo);

  const roleRepo = new InMemoryRoleRepository();
  const listRoles = new ListRoles(roleRepo);
  const getRole = new GetRole(roleRepo);
  const createRole = new CreateRole(roleRepo);
  const updateRole = new UpdateRole(roleRepo);
  const deleteRole = new DeleteRole(roleRepo);

  const adminRepo = new InMemoryAdminRepository();
  const listAdmins = new ListAdmins(adminRepo);
  const getAdmin = new GetAdmin(adminRepo);
  const createAdmin = new CreateAdmin(adminRepo);
  const updateAdmin = new UpdateAdmin(adminRepo);
  const deleteAdmin = new DeleteAdmin(adminRepo);
  const getActivityLog = new GetAdminActivityLog(adminRepo);
  const get2FAStatus = new Get2FAStatus(adminRepo);
  const enable2FA = new Enable2FA(adminRepo);
  const disable2FA = new Disable2FA(adminRepo);

  const ipNetworkRepo = new InMemoryIpNetworkRepository();
  const listIpNetworks = new ListIpNetworks(ipNetworkRepo);
  const createIpNetwork = new CreateIpNetwork(ipNetworkRepo);
  const deleteIpNetwork = new DeleteIpNetwork(ipNetworkRepo);
  const listIpPools = new ListIpPools(ipNetworkRepo);
  const createIpPool = new CreateIpPool(ipNetworkRepo);
  const deleteIpPool = new DeleteIpPool(ipNetworkRepo);
  const listIpAssignments = new ListIpAssignments(ipNetworkRepo);

  const dashboardRepo = new InMemoryDashboardRepository();
  const getDashboardStats = new GetDashboardStats(dashboardRepo);
  const getDashboardShortcuts = new GetDashboardShortcuts(dashboardRepo);
  const getRecentActivity = new GetRecentActivity(dashboardRepo);

  const messageRepo = new InMemoryMessageRepository();
  const listMessages = new ListMessages(messageRepo);
  const getMessage = new GetMessage(messageRepo);
  const createMessage = new CreateMessage(messageRepo);
  const markMessageAsRead = new MarkMessageAsRead(messageRepo);
  const deleteMessage = new DeleteMessage(messageRepo);

  const leadRepo = new InMemoryLeadRepository();
  const listLeads = new ListLeads(leadRepo);
  const getLead = new GetLead(leadRepo);
  const createLead = new CreateLead(leadRepo);
  const updateLead = new UpdateLead(leadRepo);
  const deleteLead = new DeleteLead(leadRepo);
  const convertLeadToClient = new ConvertLeadToClient(leadRepo);

  const ubicacionRepo = new InMemoryUbicacionRepository();
  const listUbicaciones = new ListUbicaciones(ubicacionRepo);
  const getUbicacion = new GetUbicacion(ubicacionRepo);
  const createUbicacion = new CreateUbicacion(ubicacionRepo);
  const updateUbicacion = new UpdateUbicacion(ubicacionRepo);
  const deleteUbicacion = new DeleteUbicacion(ubicacionRepo);

  const reportRepo = new InMemoryReportRepository();
  const listReportDefinitions = new ListReportDefinitions(reportRepo);
  const generateReport = new GenerateReport(reportRepo);
  const exportReport = new ExportReport(reportRepo);

  const creditNoteRepo = new InMemoryCreditNoteRepository();
  const listCreditNotes = new ListCreditNotes(creditNoteRepo);
  const getCreditNote = new GetCreditNote(creditNoteRepo);
  const createCreditNote = new CreateCreditNote(creditNoteRepo);
  const applyCreditNote = new ApplyCreditNote(creditNoteRepo);
  const voidCreditNote = new VoidCreditNote(creditNoteRepo);

  const proformaRepo = new InMemoryProformaRepository();
  const listProformas = new ListProformas(proformaRepo);
  const createProforma = new CreateProforma(proformaRepo);
  const convertToInvoice = new ConvertToInvoice(proformaRepo);
  const cancelProforma = new CancelProforma(proformaRepo);

  const financeHistoryRepo = new InMemoryFinanceHistoryRepository();
  const listFinanceHistory = new ListFinanceHistory(financeHistoryRepo);

  const nasRepo = new InMemoryNasRepository();
  const listNasServers = new ListNasServers(nasRepo);
  const getNasServer = new GetNasServer(nasRepo);
  const createNasServer = new CreateNasServer(nasRepo);
  const updateNasServer = new UpdateNasServer(nasRepo);
  const deleteNasServer = new DeleteNasServer(nasRepo);
  const getRadiusConfig = new GetRadiusConfig(nasRepo);
  const updateRadiusConfig = new UpdateRadiusConfig(nasRepo);

  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const listNetworkSites = new ListNetworkSites(networkSiteRepo);
  const getNetworkSite = new GetNetworkSite(networkSiteRepo);
  const createNetworkSite = new CreateNetworkSite(networkSiteRepo);
  const updateNetworkSite = new UpdateNetworkSite(networkSiteRepo);
  const deleteNetworkSite = new DeleteNetworkSite(networkSiteRepo);

  const cpeRepo = new InMemoryCpeRepository();
  const listCpeDevices = new ListCpeDevices(cpeRepo);
  const getCpeDevice = new GetCpeDevice(cpeRepo);
  const createCpeDevice = new CreateCpeDevice(cpeRepo);
  const updateCpeDevice = new UpdateCpeDevice(cpeRepo);
  const deleteCpeDevice = new DeleteCpeDevice(cpeRepo);
  const assignCpeToClient = new AssignCpeToClient(cpeRepo);

  const tr069Repo = new InMemoryTr069Repository();
  const listTr069Profiles = new ListTr069Profiles(tr069Repo);
  const createTr069Profile = new CreateTr069Profile(tr069Repo);
  const updateTr069Profile = new UpdateTr069Profile(tr069Repo);
  const deleteTr069Profile = new DeleteTr069Profile(tr069Repo);
  const listTr069Devices = new ListTr069Devices(tr069Repo);
  const provisionDevice = new ProvisionDevice(tr069Repo);
  const deleteTr069Device = new DeleteTr069Device(tr069Repo);

  const listIpv6Networks = new ListIpv6Networks(ipNetworkRepo);
  const createIpv6Network = new CreateIpv6Network(ipNetworkRepo);

  const hardwareRepo = new InMemoryHardwareRepository();
  const listHardwareAssets = new ListHardwareAssets(hardwareRepo);
  const createHardwareAsset = new CreateHardwareAsset(hardwareRepo);
  const updateHardwareAsset = new UpdateHardwareAsset(hardwareRepo);
  const deleteHardwareAsset = new DeleteHardwareAsset(hardwareRepo);

  const gponRepo = new InMemoryGponRepository();
  const listOlts = new ListOlts(gponRepo);
  const getOlt = new GetOlt(gponRepo);
  const createOlt = new CreateOlt(gponRepo);
  const listOnus = new ListOnus(gponRepo);
  const getOnu = new GetOnu(gponRepo);
  const listOnusByOlt = new ListOnusByOlt(gponRepo);
  const createOnu = new CreateOnu(gponRepo);
  const updateOnuStatus = new UpdateOnuStatus(gponRepo);

  const radiusRepo = new InMemoryRadiusSessionRepository();
  const listRadiusSessions = new ListRadiusSessions(radiusRepo);
  const disconnectSession = new DisconnectSession(radiusRepo);

  const monitoringRepo = new PrismaMonitoringRepository();
  const getMonitoringStats = new GetMonitoringStats(monitoringRepo);
  const listMonitoringDevices = new ListMonitoringDevices(monitoringRepo);
  const listMonitoringAlerts = new ListMonitoringAlerts(monitoringRepo);
  const acknowledgeAlert = new AcknowledgeAlert(monitoringRepo);

  const globalSearch = new GlobalSearch();

  const notificationRepo = new InMemoryNotificationRepository();
  const listNotifications = new ListNotifications(notificationRepo);
  const markNotificationRead = new MarkNotificationRead(notificationRepo);
  const markAllNotificationsRead = new MarkAllNotificationsRead(notificationRepo);
  const deleteNotification = new DeleteNotification(notificationRepo);

  // Routes
  app.use('/api/dashboard', createDashboardRouter(getDashboardStats, getDashboardShortcuts, getRecentActivity));
  app.use('/api/messages', createMessagesRouter(listMessages, getMessage, createMessage, markMessageAsRead, deleteMessage));
  app.use('/api/auth', createAuthRouter(authAdapter));
  app.use('/api/clients', createClientsRouter(listClients, getDetail, getServices, getInvoices, getLogs, authAdapter));
  app.use('/api/customers', createClientCommentsRouter(getComments, createComment));
  app.use('/api/tickets', createTicketsRouter(listTickets, getStats, createTicket, authAdapter));
  app.use('/api/billing', createBillingRouter(getSummary, listInvoices, listPayments, listTransactions, authAdapter));
  app.use('/api/billing', createBillingMonthlyRouter(getMonthly));
  app.use('/api/billing', createCreditNotesRouter(listCreditNotes, getCreditNote, createCreditNote, applyCreditNote, voidCreditNote));
  app.use('/api/billing', createProformasRouter(listProformas, createProforma, convertToInvoice, cancelProforma));
  app.use('/api/billing', createFinanceHistoryRouter(listFinanceHistory));
  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus));
  app.use('/api/voip', createVozRouter(listVoipCategories, createVoipCategory, listVoipCdrs, listVoipPlans, createVoipPlan));
  app.use('/api/leads', createLeadsRouter(listLeads, getLead, createLead, updateLead, deleteLead, convertLeadToClient));
  app.use('/api/locations', createUbicacionesRouter(listUbicaciones, getUbicacion, createUbicacion, updateUbicacion, deleteUbicacion));
  app.use('/api/partners', createPartnerRouter(listPartners, getPartner, createPartner, updatePartner, deletePartner));
  app.use('/api/roles', createRoleRouter(listRoles, getRole, createRole, updateRole, deleteRole));
  app.use('/api/admins', createAdminRouter(listAdmins, getAdmin, createAdmin, updateAdmin, deleteAdmin, getActivityLog, get2FAStatus, enable2FA, disable2FA));
  app.use('/api', createEmpresaRouter(
    listServicePlans, getServicePlan, createServicePlan, updateServicePlan, deleteServicePlan,
    listNetworkDevices, getNetworkDevice, createNetworkDevice, updateNetworkDevice, deleteNetworkDevice,
    listInventoryItems, getInventoryItem, createInventoryItem, updateInventoryItem, deleteInventoryItem,
    listInventoryProducts, listInventoryUnits, createInventoryUnit, updateInventoryUnit,
    updateInventoryProduct, deleteInventoryProduct, deleteInventoryUnit,
  ));
  app.use('/api', createIpNetworkRouter(
    listIpNetworks, createIpNetwork, deleteIpNetwork,
    listIpPools, createIpPool, listIpAssignments,
    deleteIpPool, listIpv6Networks, createIpv6Network,
  ));
  app.use('/api/network-sites', createNetworkSiteRouter(
    listNetworkSites, getNetworkSite, createNetworkSite, updateNetworkSite, deleteNetworkSite,
  ));
  app.use('/api/cpe', createCpeRouter(
    listCpeDevices, getCpeDevice, createCpeDevice, updateCpeDevice, deleteCpeDevice, assignCpeToClient,
  ));
  app.use('/api/tr069', createTr069Router(
    listTr069Profiles, createTr069Profile, updateTr069Profile, deleteTr069Profile,
    listTr069Devices, provisionDevice, deleteTr069Device,
  ));
  app.use('/api/hardware', createHardwareRouter(
    listHardwareAssets, createHardwareAsset, updateHardwareAsset, deleteHardwareAsset,
  ));
  app.use('/api/gpon', createGponRouter(listOlts, getOlt, listOnus, getOnu, listOnusByOlt, createOlt, createOnu, updateOnuStatus));
  app.use('/api/radius', createRadiusRouter(listRadiusSessions, disconnectSession));
  app.use('/api', createNasRouter(
    listNasServers, getNasServer, createNasServer, updateNasServer, deleteNasServer,
    getRadiusConfig, updateRadiusConfig,
  ));
  app.use(
    '/api/settings',
    createSettingsRouter(
      getSystemSettings,
      updateSystemSettings,
      getEmailSettings,
      updateEmailSettings,
      listTemplates,
      updateTemplate,
      listApiTokens,
      createApiToken,
      revokeApiToken,
      getFinanceSettings,
      updateFinanceSettings,
      listPaymentMethods,
      createPaymentMethod,
      updatePaymentMethod,
      deletePaymentMethod,
      listWebhooks,
      createWebhook,
      deleteWebhook,
      testWebhook,
      listBackups,
      createBackup,
      getClientPortalSettings,
      updateClientPortalSettings,
    ),
  );

  app.use('/api/reports', createReportsRouter(listReportDefinitions, generateReport, exportReport));
  app.use('/api/monitoring', createMonitoringRouter(getMonitoringStats, listMonitoringDevices, listMonitoringAlerts, acknowledgeAlert));
  app.use('/api/search', createSearchRouter(globalSearch));
  app.use('/api/notifications', createNotificationsRouter(listNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification));

  // Profile routes (uses internal router directly)
  const profileRouter = Router();
  profileRoutes(profileRouter);
  app.use('/api', profileRouter);

  // 404
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Global error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof DomainError) {
      const statusMap: Record<string, number> = {
        CLIENT_NOT_FOUND: 404,
        TICKET_NOT_FOUND: 404,
        AUTHENTICATION_ERROR: 401,
        SPLYNX_UNAVAILABLE: 502,
      };
      const status = statusMap[err.code] ?? 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    console.error('[UNHANDLED ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  return app;
}
