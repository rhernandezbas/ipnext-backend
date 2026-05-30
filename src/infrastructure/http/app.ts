import express, { Router, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { SplynxClient } from '../adapters/splynx/SplynxClient';
import { PrismaCustomerRepository } from '../adapters/prisma/PrismaCustomerRepository';
// SplynxTicketAdapter preserved but decabled — see AD-2 in design.md
// import { SplynxTicketAdapter } from '../adapters/splynx/SplynxTicketAdapter';
import { SplynxBillingAdapter } from '../adapters/splynx/SplynxBillingAdapter';
import { JwtAuthAdapter } from '../adapters/jwt/JwtAuthAdapter';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { CreateCustomer } from '@application/use-cases/CreateCustomer';
import { GetClientStats } from '@application/use-cases/GetClientStats';
import { DeleteCustomer } from '@application/use-cases/DeleteCustomer';
import { GetClientServices } from '@application/use-cases/GetClientServices';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetTicket } from '@application/use-cases/GetTicket';
import { UpdateTicketStatus } from '@application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '@application/use-cases/UpdateTicket';
import { CloseTicket } from '@application/use-cases/CloseTicket';
import { PrismaTicketRepository } from '../adapters/prisma/PrismaTicketRepository';
import { GetBillingSummary } from '@application/use-cases/GetBillingSummary';
import { ListInvoices } from '@application/use-cases/ListInvoices';
import { ListPayments } from '@application/use-cases/ListPayments';
import { ListTransactions } from '@application/use-cases/ListTransactions';
import { GetClientComments } from '@application/use-cases/GetClientComments';
import { CreateClientComment } from '@application/use-cases/CreateClientComment';
import { GetMonthlyBilling } from '@application/use-cases/GetMonthlyBilling';
import { PrismaClientCommentRepository } from '../adapters/prisma/PrismaClientCommentRepository';
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
import { PrismaAdminRepository } from '../adapters/prisma/PrismaAdminRepository';
import { createSettingsRouter } from './routes/settings.routes';
import { PrismaSettingsRepository } from '../adapters/prisma/PrismaSettingsRepository';
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
import { createTaskCommentsRouter } from './routes/taskComments.routes';
import { createWorkflowsRouter } from './routes/workflows.routes';
import { ReplaceTaskTemplateItems } from '@application/use-cases/ReplaceTaskTemplateItems';
import { AddChecklistItem } from '@application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '@application/use-cases/ToggleChecklistItem';
import { UpdateChecklistItem } from '@application/use-cases/UpdateChecklistItem';
import { RemoveChecklistItem } from '@application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '@application/use-cases/ReorderChecklistItems';
import { AssignTemplateToTask } from '@application/use-cases/AssignTemplateToTask';
import { ClearTaskChecklist } from '@application/use-cases/ClearTaskChecklist';
import { createProjectsRouter } from './routes/projects.routes';
import { createTaskTemplateRouter } from './routes/taskTemplate.routes';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaWorkflowRepository } from '../adapters/prisma/PrismaWorkflowRepository';
import { PrismaStageRepository } from '../adapters/prisma/PrismaStageRepository';
import { PrismaProjectCategoryRepository } from '../adapters/prisma/PrismaProjectCategoryRepository';
import { PrismaProjectTypeRepository } from '../adapters/prisma/PrismaProjectTypeRepository';
import { PrismaProjectRepository } from '../adapters/prisma/PrismaProjectRepository';
import { PrismaTaskTemplateRepository } from '../adapters/prisma/PrismaTaskTemplateRepository';
import { ListTaskTemplates } from '@application/use-cases/ListTaskTemplates';
import { GetTaskTemplate } from '@application/use-cases/GetTaskTemplate';
import { CreateTaskTemplate } from '@application/use-cases/CreateTaskTemplate';
import { UpdateTaskTemplate } from '@application/use-cases/UpdateTaskTemplate';
import { DeleteTaskTemplate } from '@application/use-cases/DeleteTaskTemplate';
import { ListProjects } from '@application/use-cases/ListProjects';
import { GetProject } from '@application/use-cases/GetProject';
import { CreateProject } from '@application/use-cases/CreateProject';
import { UpdateProject } from '@application/use-cases/UpdateProject';
import { DeleteProject } from '@application/use-cases/DeleteProject';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { BulkMoveTasksToStage } from '@application/use-cases/BulkMoveTasksToStage';
import { SendTaskToIClass } from '@application/use-cases/SendTaskToIClass';
import { buildIClassClient } from './iclass.factory';
import { SetTaskInventoryReview } from '@application/use-cases/SetTaskInventoryReview';
import { AddTaskComment } from '@application/use-cases/AddTaskComment';
import { ListTaskComments } from '@application/use-cases/ListTaskComments';
import { DeleteTaskComment } from '@application/use-cases/DeleteTaskComment';
import { PrismaTaskCommentRepository } from '../adapters/prisma/PrismaTaskCommentRepository';
import { ListWorkflows } from '@application/use-cases/ListWorkflows';
import { GetWorkflow } from '@application/use-cases/GetWorkflow';
import { CreateWorkflow } from '@application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '@application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '@application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '@application/use-cases/AddStageToWorkflow';
import { UpdateStageColor } from '@application/use-cases/UpdateStageColor';
import { RemoveStageFromWorkflow } from '@application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '@application/use-cases/ReorderStages';
import { ListProjectCategory } from '@application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '@application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '@application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '@application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '@application/use-cases/DeleteProjectCategory';
import { PrismaTaskCategoryRepository } from '../adapters/prisma/PrismaTaskCategoryRepository';
import { createTaskCategoriesRouter } from './routes/taskCategories.routes';
import { createGestionRealRouter } from './routes/gestionReal.routes';
import { createGrSyncRouter } from './routes/gr-sync.routes';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ReconcileGrClients } from '@application/use-cases/ReconcileGrClients';
import { PrismaClientMirrorReadRepository } from '../adapters/prisma/PrismaClientMirrorReadRepository';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { PrismaClientMirrorRepository } from '../adapters/prisma/PrismaClientMirrorRepository';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaMirrorCountsRepository } from '../adapters/prisma/PrismaMirrorCountsRepository';
// GR installation-order ingest (gestion-real-installation-ingest)
import { createGestionRealIngestRouter } from './routes/gestionRealIngest.routes';
import { GetIngestConfig } from '@application/use-cases/GetIngestConfig';
import { UpdateIngestConfig } from '@application/use-cases/UpdateIngestConfig';
import { GetIngestStatus } from '@application/use-cases/GetIngestStatus';
import { ListNeedsReviewTasks } from '@application/use-cases/ListNeedsReviewTasks';
import { PrismaGestionRealIngestConfigRepository } from '../adapters/prisma/PrismaGestionRealIngestConfigRepository';
import { ListTaskCategory } from '@application/use-cases/ListTaskCategory';
import { GetTaskCategory } from '@application/use-cases/GetTaskCategory';
import { CreateTaskCategory } from '@application/use-cases/CreateTaskCategory';
import { UpdateTaskCategory } from '@application/use-cases/UpdateTaskCategory';
import { DeleteTaskCategory } from '@application/use-cases/DeleteTaskCategory';
import { PrismaTaskPriorityRepository } from '../adapters/prisma/PrismaTaskPriorityRepository';
import { createTaskPrioritiesRouter } from './routes/taskPriorities.routes';
import { ListTaskPriority } from '@application/use-cases/ListTaskPriority';
import { GetTaskPriority } from '@application/use-cases/GetTaskPriority';
import { CreateTaskPriority } from '@application/use-cases/CreateTaskPriority';
import { UpdateTaskPriority } from '@application/use-cases/UpdateTaskPriority';
import { DeleteTaskPriority } from '@application/use-cases/DeleteTaskPriority';
import { PrismaTicketStatusRepository } from '../adapters/prisma/PrismaTicketStatusRepository';
import { createTicketStatusesRouter } from './routes/ticketStatuses.routes';
import { ListTicketStatuses } from '@application/use-cases/ListTicketStatuses';
import { GetTicketStatus } from '@application/use-cases/GetTicketStatus';
import { CreateTicketStatus } from '@application/use-cases/CreateTicketStatus';
import { UpdateTicketStatusCatalog } from '@application/use-cases/UpdateTicketStatusCatalog';
import { DeleteTicketStatus } from '@application/use-cases/DeleteTicketStatus';
import { ListProjectType } from '@application/use-cases/ListProjectType';
import { GetProjectType } from '@application/use-cases/GetProjectType';
import { CreateProjectType } from '@application/use-cases/CreateProjectType';
import { UpdateProjectType } from '@application/use-cases/UpdateProjectType';
import { DeleteProjectType } from '@application/use-cases/DeleteProjectType';
import { createVozRouter } from './routes/voz.routes';
import { PrismaVozRepository } from '../adapters/prisma/PrismaVozRepository';
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
import { PrismaEmpresaRepository } from '../adapters/prisma/PrismaEmpresaRepository';
import { createPartnerRouter } from './routes/partner.routes';
import { PrismaPartnerRepository } from '../adapters/prisma/PrismaPartnerRepository';
import { ListPartners } from '@application/use-cases/ListPartners';
import { GetPartner } from '@application/use-cases/GetPartner';
import { CreatePartner } from '@application/use-cases/CreatePartner';
import { UpdatePartner } from '@application/use-cases/UpdatePartner';
import { DeletePartner } from '@application/use-cases/DeletePartner';
import { createRoleRouter } from './routes/role.routes';
import { PrismaRoleRepository } from '../adapters/prisma/PrismaRoleRepository';
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
import { PrismaIpNetworkRepository } from '../adapters/prisma/PrismaIpNetworkRepository';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { DeleteIpPool } from '@application/use-cases/DeleteIpPool';
import { ListIpAssignments } from '@application/use-cases/ListIpAssignments';
import { createNasRouter } from './routes/nas.routes';
import { PrismaNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { createDashboardRouter } from './routes/dashboard.routes';
import { PrismaDashboardRepository } from '../adapters/prisma/PrismaDashboardRepository';
import { GetDashboardStats } from '@application/use-cases/GetDashboardStats';
import { GetDashboardShortcuts } from '@application/use-cases/GetDashboardShortcuts';
import { GetRecentActivity } from '@application/use-cases/GetRecentActivity';
import { createMessagesRouter } from './routes/messages.routes';
import { PrismaMessageRepository } from '../adapters/prisma/PrismaMessageRepository';
import { ListMessages } from '@application/use-cases/ListMessages';
import { GetMessage } from '@application/use-cases/GetMessage';
import { CreateMessage } from '@application/use-cases/CreateMessage';
import { MarkMessageAsRead } from '@application/use-cases/MarkMessageAsRead';
import { DeleteMessage } from '@application/use-cases/DeleteMessage';
import { PrismaCreditNoteRepository } from '../adapters/prisma/PrismaCreditNoteRepository';
import { PrismaProformaRepository } from '../adapters/prisma/PrismaProformaRepository';
import { PrismaFinanceHistoryRepository } from '../adapters/prisma/PrismaFinanceHistoryRepository';
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
import { PrismaNetworkSiteRepository } from '../adapters/prisma/PrismaNetworkSiteRepository';
import { ListNetworkSites } from '@application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '@application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '@application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '@application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '@application/use-cases/DeleteNetworkSite';
import { createCpeRouter } from './routes/cpe.routes';
import { PrismaCpeRepository } from '../adapters/prisma/PrismaCpeRepository';
import { ListCpeDevices } from '@application/use-cases/ListCpeDevices';
import { GetCpeDevice } from '@application/use-cases/GetCpeDevice';
import { CreateCpeDevice } from '@application/use-cases/CreateCpeDevice';
import { UpdateCpeDevice } from '@application/use-cases/UpdateCpeDevice';
import { DeleteCpeDevice } from '@application/use-cases/DeleteCpeDevice';
import { AssignCpeToClient } from '@application/use-cases/AssignCpeToClient';
import { createTr069Router } from './routes/tr069.routes';
import { PrismaTr069Repository } from '../adapters/prisma/PrismaTr069Repository';
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
import { PrismaHardwareRepository } from '../adapters/prisma/PrismaHardwareRepository';
import { ListHardwareAssets } from '@application/use-cases/ListHardwareAssets';
import { CreateHardwareAsset } from '@application/use-cases/CreateHardwareAsset';
import { UpdateHardwareAsset } from '@application/use-cases/UpdateHardwareAsset';
import { DeleteHardwareAsset } from '@application/use-cases/DeleteHardwareAsset';
import { errorHandler } from './middleware/errorHandler';
import { prisma } from '../database/prisma';
import { config } from '../config';
import { createGponRouter } from './routes/gpon.routes';
import { PrismaGponRepository } from '../adapters/prisma/PrismaGponRepository';
import { ListOlts } from '@application/use-cases/ListOlts';
import { GetOlt } from '@application/use-cases/GetOlt';
import { CreateOlt } from '@application/use-cases/CreateOlt';
import { ListOnus } from '@application/use-cases/ListOnus';
import { GetOnu } from '@application/use-cases/GetOnu';
import { ListOnusByOlt } from '@application/use-cases/ListOnusByOlt';
import { CreateOnu } from '@application/use-cases/CreateOnu';
import { UpdateOnuStatus } from '@application/use-cases/UpdateOnuStatus';
import { createRadiusRouter } from './routes/radius.routes';
import { PrismaRadiusSessionRepository } from '../adapters/prisma/PrismaRadiusSessionRepository';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { createLeadsRouter } from './routes/leads.routes';
import { PrismaLeadRepository } from '../adapters/prisma/PrismaLeadRepository';
import { ListLeads } from '@application/use-cases/ListLeads';
import { GetLead } from '@application/use-cases/GetLead';
import { CreateLead } from '@application/use-cases/CreateLead';
import { UpdateLead } from '@application/use-cases/UpdateLead';
import { DeleteLead } from '@application/use-cases/DeleteLead';
import { ConvertLeadToClient } from '@application/use-cases/ConvertLeadToClient';
import { createUbicacionesRouter } from './routes/ubicaciones.routes';
import { PrismaUbicacionRepository } from '../adapters/prisma/PrismaUbicacionRepository';
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
import { PrismaNotificationRepository } from '../adapters/prisma/PrismaNotificationRepository';
import { ListNotifications } from '@application/use-cases/ListNotifications';
import { MarkNotificationRead } from '@application/use-cases/MarkNotificationRead';
import { MarkAllNotificationsRead } from '@application/use-cases/MarkAllNotificationsRead';
import { DeleteNotification } from '@application/use-cases/DeleteNotification';
import { profileRoutes } from './routes/profile.routes';
import { createFeatureFlagsRouter } from './routes/featureFlags.routes';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { ListFeatureFlags } from '@application/use-cases/ListFeatureFlags';
import { GetFeatureFlag } from '@application/use-cases/GetFeatureFlag';
import { SetFeatureFlag } from '@application/use-cases/SetFeatureFlag';
import { PrismaIClassSoTypeRepository } from '../adapters/prisma/PrismaIClassSoTypeRepository';
import { SyncIClassSoTypes } from '@application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '@application/use-cases/ListIClassSoTypes';
import { AssignIClassSoTypeToProject } from '@application/use-cases/AssignIClassSoTypeToProject';
import { createIClassAdminRouter } from './routes/iclass-admin.routes';
import { createIClassClosureRouter } from './routes/iclass-closure.routes';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { SyncIClassResultCodes } from '@application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '@application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '@application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '@application/use-cases/GetClosureStatus';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaRbacUserRepository } from '../adapters/prisma/PrismaRbacUserRepository';
import { PrismaRbacRoleRepository } from '../adapters/prisma/PrismaRbacRoleRepository';
import { PrismaRbacPermissionRepository } from '../adapters/prisma/PrismaRbacPermissionRepository';
import { PrismaAuditEventRepository } from '../adapters/prisma/PrismaAuditEventRepository';
import { auditMutationsMiddleware } from './middleware/auditMutationsMiddleware';
import { PrismaRbacUserRoleRepository } from '../adapters/prisma/PrismaRbacUserRoleRepository';
import { PrismaRbacRolePermissionRepository } from '../adapters/prisma/PrismaRbacRolePermissionRepository';
import { requirePermission } from './middleware/requirePermission';
import { createAuthMiddleware } from './middleware/authMiddleware';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { BcryptPasswordHasher } from '../adapters/bcrypt/BcryptPasswordHasher';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
// SDD #2 Phase 6 — RBAC user management use cases
import { ListRbacUsers } from '@application/use-cases/rbac/ListRbacUsers';
import { GetRbacUser } from '@application/use-cases/rbac/GetRbacUser';
import { CreateRbacUser } from '@application/use-cases/rbac/CreateRbacUser';
import { UpdateRbacUser } from '@application/use-cases/rbac/UpdateRbacUser';
import { DeleteRbacUser } from '@application/use-cases/rbac/DeleteRbacUser';
import { ChangeRbacUserPassword } from '@application/use-cases/rbac/ChangeRbacUserPassword';
import { ListRolesForUser } from '@application/use-cases/rbac/ListRolesForUser';
import { SetRolesForUser } from '@application/use-cases/rbac/SetRolesForUser';
import { AssignRoleToUser } from '@application/use-cases/rbac/AssignRoleToUser';
import { RemoveRoleFromUser } from '@application/use-cases/rbac/RemoveRoleFromUser';
import { createRbacUserRouter } from './routes/rbacUser.routes';
import { toRbacRoleDto } from '@application/dto/rbacUser.dto';
// SDD #3 Phase 1a — ResolveUserPermissions use case
import { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';
// SDD #3 Phase 4a — role-permissions use cases + routes
import { ListAllPermissionsWithModule } from '@application/use-cases/rbac/ListAllPermissionsWithModule';
import { ListPermissionIdsForRole } from '@application/use-cases/rbac/ListPermissionIdsForRole';
import { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';
import { createRolePermissionsRouter } from './routes/rolePermissions.routes';
import { createPermissionsRouter } from './routes/permissions.routes';
import { createAuditEventsRouter } from './routes/auditEvents.routes';
import { ListAuditEvents } from '@application/use-cases/audit/ListAuditEvents';
// SDD #3 Phase 4b — role catalog mutation use cases
import { CreateRbacRole } from '@application/use-cases/rbac/CreateRbacRole';
import { DeleteRbacRole } from '@application/use-cases/rbac/DeleteRbacRole';

/**
 * Minimal FK lookup for scheduling use-case FK validation.
 *
 * Each branch calls findUnique on the correct Prisma delegate with its own
 * concrete argument type — no `as any` needed, TypeScript can verify each call.
 */
// Covers four entity kinds (Client, Service, Partner, Project) despite the name
// — renaming is out of scope per design AD-2.
function prismaClientLookup(model: 'Client' | 'Service' | 'Partner' | 'Project', id: string): Promise<{ id: string } | null> {
  switch (model) {
    case 'Client':  return prisma.client.findUnique({ where: { id }, select: { id: true } });
    case 'Service': return prisma.service.findUnique({ where: { id }, select: { id: true } });
    case 'Partner': return prisma.partner.findUnique({ where: { id }, select: { id: true } });
    case 'Project': return prisma.project.findUnique({ where: { id }, select: { id: true } });
  }
}

// RBAC repositories — module-level singletons so requirePerm can be a named export
const rbacUserRepo           = new PrismaRbacUserRepository();
const rbacRoleRepo           = new PrismaRbacRoleRepository();
const rbacPermissionRepo     = new PrismaRbacPermissionRepository();
const rbacUserRoleRepo       = new PrismaRbacUserRoleRepository();
const rbacRolePermissionRepo = new PrismaRbacRolePermissionRepository();
// SDD #4 — single audit repo instance shared by the middleware + emit + query endpoint
const auditEventRepo         = new PrismaAuditEventRepository();

// PasswordHasher + LoginRbacUser — module-level singletons (SDD #2 Phase 5)
const passwordHasher = new BcryptPasswordHasher();
const loginRbacUser  = new LoginRbacUser(rbacUserRepo, passwordHasher);

// SDD #3 Phase 1a — ResolveUserPermissions resolves flat permission code list for a user
const resolveUserPermissions = new ResolveUserPermissions(rbacUserRoleRepo, rbacRolePermissionRepo, rbacPermissionRepo);

// Convenience factory — routes in future SDDs import this instead of wiring the repo manually
export const requirePerm = (m: RbacModuleCode, a: PermissionAction) =>
  requirePermission(rbacUserRepo, m, a);

export function createApp() {
  const app = express();

  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  // SDD #4: audit every mutation (POST/PUT/PATCH/DELETE under /api). Reads
  // req.user at res.on('finish'), so it sits before the per-router auth MW.
  app.use(auditMutationsMiddleware(auditEventRepo));

  // Wire up adapters
  const splynxClient = new SplynxClient();
  const customerAdapter = new PrismaCustomerRepository(config.gestionReal.balanceStaleTtlMinutes);
  const ticketAdapter = new PrismaTicketRepository();   // replaces SplynxTicketAdapter (AD-2)
  const billingAdapter = new SplynxBillingAdapter(splynxClient);
  // SDD #2 Phase 5: JwtAuthAdapter now delegates login to LoginRbacUser use case.
  // No more direct Prisma.admin access in the adapter.
  const authAdapter = new JwtAuthAdapter(loginRbacUser);

  // On-demand balance refresh collaborator — only wired when GR is configured
  let balanceRefresh: RefreshClientBalanceIfStale | undefined;
  // Read-only reconcile diagnostic — only wired when GR is configured (else route 503s).
  let reconcileGrClients: ReconcileGrClients | undefined;
  if (config.gestionReal.enabled && config.gestionReal.cuit && config.gestionReal.secret) {
    const grClient = new GestionRealClient({
      baseUrl: config.gestionReal.baseUrl,
      cuit: config.gestionReal.cuit,
      secret: config.gestionReal.secret,
      timeoutMs: config.gestionReal.balanceRefreshTimeoutMs,
    });
    const mirrorRepo = new PrismaClientMirrorRepository();
    balanceRefresh = new RefreshClientBalanceIfStale(grClient, mirrorRepo, {
      ttlMinutes: config.gestionReal.balanceStaleTtlMinutes,
      timeoutMs: config.gestionReal.balanceRefreshTimeoutMs,
    });
    reconcileGrClients = new ReconcileGrClients(grClient, new PrismaClientMirrorReadRepository());
  }

  // Wire up use cases
  const listClients = new ListClients(customerAdapter);
  const getDetail = new GetClientDetail(customerAdapter, balanceRefresh);
  const getServices = new GetClientServices(customerAdapter);
  const getInvoices = new GetClientInvoices(customerAdapter);
  const getLogs = new GetClientLogs(customerAdapter);
  const createCustomer = new CreateCustomer(customerAdapter);
  const getClientStats = new GetClientStats(customerAdapter);
  const deleteCustomer = new DeleteCustomer(customerAdapter);
  const listTickets = new ListTickets(ticketAdapter);
  const getStats = new GetTicketStats(ticketAdapter);
  const createTicket = new CreateTicket(ticketAdapter);
  const getTicket = new GetTicket(ticketAdapter);
  const updateTicketStatus = new UpdateTicketStatus(ticketAdapter);
  const updateTicket = new UpdateTicket(ticketAdapter);
  const closeTicket = new CloseTicket(ticketAdapter);
  const getSummary = new GetBillingSummary(billingAdapter);
  const listInvoices = new ListInvoices(billingAdapter);
  const listPayments = new ListPayments(billingAdapter);
  const listTransactions = new ListTransactions(billingAdapter);

  const commentRepo = new PrismaClientCommentRepository();
  const getComments = new GetClientComments(commentRepo);
  const createComment = new CreateClientComment(commentRepo);

  const monthlyRepo = new InMemoryMonthlyBillingRepository();
  const getMonthly = new GetMonthlyBilling(monthlyRepo);

  const settingsRepo = new PrismaSettingsRepository();
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

  const schedulingRepo = new PrismaSchedulingRepository();
  const workflowRepo = new PrismaWorkflowRepository();
  const stageRepo = new PrismaStageRepository();
  const projectCategoryRepo = new PrismaProjectCategoryRepository();
  const projectTypeRepo = new PrismaProjectTypeRepository();

  const listTasks = new ListTasks(schedulingRepo);
  const getTask = new GetTask(schedulingRepo);
  // Scheduling reporter/assignee/watcher ids are validated against RbacUser
  // (post SDD #2 — Admin table is being phased out, no fallback). The lookup
  // returns { id } on hit, null on miss — satisfies the EntityLookup port.
  const userLookupForScheduling = {
    findById: async (id: string): Promise<{ id: string } | null> => {
      const rbacUser = await rbacUserRepo.findById(id);
      return rbacUser ? { id: rbacUser.id } : null;
    },
  };
  const createTask = new CreateTask(
    schedulingRepo,
    // EntityLookup wrappers for FK validation (return { id } | null)
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaClientLookup('Service', id) },
    { findById: (id: string) => prismaClientLookup('Partner', id) },
    userLookupForScheduling,
    { findById: (id: string) => prismaClientLookup('Project', id) },
  );
  const updateTask = new UpdateTask(
    schedulingRepo,
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaClientLookup('Service', id) },
    { findById: (id: string) => prismaClientLookup('Partner', id) },
    userLookupForScheduling,
    { findById: (id: string) => prismaClientLookup('Project', id) },
  );
  const deleteTask = new DeleteTask(schedulingRepo);
  // IClass integration: moving a task to "Enviar a IClass" delegates the OS
  // creation. The on/off decision lives in the feature flag (default OFF).
  const featureFlagRepo = new PrismaFeatureFlagRepository();
  const sendTaskToIClass = new SendTaskToIClass(schedulingRepo, featureFlagRepo, buildIClassClient());
  const moveTaskToStage = new MoveTaskToStage(schedulingRepo, stageRepo, sendTaskToIClass);

  const bulkMoveTasksToStage = new BulkMoveTasksToStage(moveTaskToStage);
  const setTaskInventoryReview = new SetTaskInventoryReview(schedulingRepo);

  const listWorkflows = new ListWorkflows(workflowRepo);
  const getWorkflow = new GetWorkflow(workflowRepo);
  const createWorkflowUC = new CreateWorkflow(workflowRepo);
  const updateWorkflowUC = new UpdateWorkflow(workflowRepo);
  const deleteWorkflowUC = new DeleteWorkflow(workflowRepo, stageRepo);
  const addStageToWorkflow = new AddStageToWorkflow(workflowRepo, stageRepo);
  const removeStageFromWorkflow = new RemoveStageFromWorkflow(stageRepo);
  const reorderStages = new ReorderStages(workflowRepo, stageRepo);
  const updateStageColor = new UpdateStageColor(stageRepo);

  const listProjectCategory = new ListProjectCategory(projectCategoryRepo);
  const getProjectCategory = new GetProjectCategory(projectCategoryRepo);
  const createProjectCategory = new CreateProjectCategory(projectCategoryRepo);
  const updateProjectCategory = new UpdateProjectCategory(projectCategoryRepo);
  const deleteProjectCategory = new DeleteProjectCategory(projectCategoryRepo);

  const taskCategoryRepo = new PrismaTaskCategoryRepository();
  const listTaskCategory = new ListTaskCategory(taskCategoryRepo);
  const getTaskCategory = new GetTaskCategory(taskCategoryRepo);
  const createTaskCategory = new CreateTaskCategory(taskCategoryRepo);
  const updateTaskCategory = new UpdateTaskCategory(taskCategoryRepo);
  const deleteTaskCategory = new DeleteTaskCategory(taskCategoryRepo);

  const taskPriorityRepo = new PrismaTaskPriorityRepository();
  const listTaskPriority = new ListTaskPriority(taskPriorityRepo);
  const getTaskPriority = new GetTaskPriority(taskPriorityRepo);
  const createTaskPriority = new CreateTaskPriority(taskPriorityRepo);
  const updateTaskPriority = new UpdateTaskPriority(taskPriorityRepo);
  const deleteTaskPriority = new DeleteTaskPriority(taskPriorityRepo);

  const ticketStatusRepo = new PrismaTicketStatusRepository();
  const listTicketStatuses = new ListTicketStatuses(ticketStatusRepo);
  const getTicketStatus = new GetTicketStatus(ticketStatusRepo);
  const createTicketStatus = new CreateTicketStatus(ticketStatusRepo);
  const updateTicketStatusCatalog = new UpdateTicketStatusCatalog(ticketStatusRepo);
  const deleteTicketStatus = new DeleteTicketStatus(ticketStatusRepo);

  const listProjectType = new ListProjectType(projectTypeRepo);
  const getProjectType = new GetProjectType(projectTypeRepo);
  const createProjectType = new CreateProjectType(projectTypeRepo);
  const updateProjectType = new UpdateProjectType(projectTypeRepo);
  const deleteProjectType = new DeleteProjectType(projectTypeRepo);

  const vozRepo = new PrismaVozRepository();
  const listVoipCategories = new ListVoipCategories(vozRepo);
  const createVoipCategory = new CreateVoipCategory(vozRepo);
  const listVoipCdrs = new ListVoipCdrs(vozRepo);
  const listVoipPlans = new ListVoipPlans(vozRepo);
  const createVoipPlan = new CreateVoipPlan(vozRepo);

  const empresaRepo = new PrismaEmpresaRepository();
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

  const partnerRepo = new PrismaPartnerRepository();
  const listPartners = new ListPartners(partnerRepo);
  const getPartner = new GetPartner(partnerRepo);
  const createPartner = new CreatePartner(partnerRepo);
  const updatePartner = new UpdatePartner(partnerRepo);
  const deletePartner = new DeletePartner(partnerRepo);

  const roleRepo = new PrismaRoleRepository();
  const listRoles = new ListRoles(roleRepo);
  const getRole = new GetRole(roleRepo);
  const createRole = new CreateRole(roleRepo);
  const updateRole = new UpdateRole(roleRepo);
  const deleteRole = new DeleteRole(roleRepo);

  const adminRepo = new PrismaAdminRepository();
  const listAdmins = new ListAdmins(adminRepo);
  const getAdmin = new GetAdmin(adminRepo);
  const createAdmin = new CreateAdmin(adminRepo);
  const updateAdmin = new UpdateAdmin(adminRepo);
  const deleteAdmin = new DeleteAdmin(adminRepo);
  const getActivityLog = new GetAdminActivityLog(adminRepo);
  const get2FAStatus = new Get2FAStatus(adminRepo);
  const enable2FA = new Enable2FA(adminRepo);
  const disable2FA = new Disable2FA(adminRepo);

  const ipNetworkRepo = new PrismaIpNetworkRepository();
  const listIpNetworks = new ListIpNetworks(ipNetworkRepo);
  const createIpNetwork = new CreateIpNetwork(ipNetworkRepo);
  const deleteIpNetwork = new DeleteIpNetwork(ipNetworkRepo);
  const listIpPools = new ListIpPools(ipNetworkRepo);
  const createIpPool = new CreateIpPool(ipNetworkRepo);
  const deleteIpPool = new DeleteIpPool(ipNetworkRepo);
  const listIpAssignments = new ListIpAssignments(ipNetworkRepo);

  const dashboardRepo = new PrismaDashboardRepository();
  const getDashboardStats = new GetDashboardStats(dashboardRepo);
  const getDashboardShortcuts = new GetDashboardShortcuts(dashboardRepo);
  const getRecentActivity = new GetRecentActivity(dashboardRepo);

  const messageRepo = new PrismaMessageRepository();
  const listMessages = new ListMessages(messageRepo);
  const getMessage = new GetMessage(messageRepo);
  const createMessage = new CreateMessage(messageRepo);
  const markMessageAsRead = new MarkMessageAsRead(messageRepo);
  const deleteMessage = new DeleteMessage(messageRepo);

  const leadRepo = new PrismaLeadRepository();
  const listLeads = new ListLeads(leadRepo);
  const getLead = new GetLead(leadRepo);
  const createLead = new CreateLead(leadRepo);
  const updateLead = new UpdateLead(leadRepo);
  const deleteLead = new DeleteLead(leadRepo);
  const convertLeadToClient = new ConvertLeadToClient(leadRepo);

  const ubicacionRepo = new PrismaUbicacionRepository();
  const listUbicaciones = new ListUbicaciones(ubicacionRepo);
  const getUbicacion = new GetUbicacion(ubicacionRepo);
  const createUbicacion = new CreateUbicacion(ubicacionRepo);
  const updateUbicacion = new UpdateUbicacion(ubicacionRepo);
  const deleteUbicacion = new DeleteUbicacion(ubicacionRepo);

  const reportRepo = new InMemoryReportRepository();
  const listReportDefinitions = new ListReportDefinitions(reportRepo);
  const generateReport = new GenerateReport(reportRepo);
  const exportReport = new ExportReport(reportRepo);

  const creditNoteRepo = new PrismaCreditNoteRepository();
  const listCreditNotes = new ListCreditNotes(creditNoteRepo);
  const getCreditNote = new GetCreditNote(creditNoteRepo);
  const createCreditNote = new CreateCreditNote(creditNoteRepo);
  const applyCreditNote = new ApplyCreditNote(creditNoteRepo);
  const voidCreditNote = new VoidCreditNote(creditNoteRepo);

  const proformaRepo = new PrismaProformaRepository();
  const listProformas = new ListProformas(proformaRepo);
  const createProforma = new CreateProforma(proformaRepo);
  const convertToInvoice = new ConvertToInvoice(proformaRepo);
  const cancelProforma = new CancelProforma(proformaRepo);

  const financeHistoryRepo = new PrismaFinanceHistoryRepository();
  const listFinanceHistory = new ListFinanceHistory(financeHistoryRepo);

  const nasRepo = new PrismaNasRepository();
  const listNasServers = new ListNasServers(nasRepo);
  const getNasServer = new GetNasServer(nasRepo);
  const createNasServer = new CreateNasServer(nasRepo);
  const updateNasServer = new UpdateNasServer(nasRepo);
  const deleteNasServer = new DeleteNasServer(nasRepo);
  const getRadiusConfig = new GetRadiusConfig(nasRepo);
  const updateRadiusConfig = new UpdateRadiusConfig(nasRepo);

  const networkSiteRepo = new PrismaNetworkSiteRepository();
  const listNetworkSites = new ListNetworkSites(networkSiteRepo);
  const getNetworkSite = new GetNetworkSite(networkSiteRepo);
  const createNetworkSite = new CreateNetworkSite(networkSiteRepo);
  const updateNetworkSite = new UpdateNetworkSite(networkSiteRepo);
  const deleteNetworkSite = new DeleteNetworkSite(networkSiteRepo);

  const cpeRepo = new PrismaCpeRepository();
  const listCpeDevices = new ListCpeDevices(cpeRepo);
  const getCpeDevice = new GetCpeDevice(cpeRepo);
  const createCpeDevice = new CreateCpeDevice(cpeRepo);
  const updateCpeDevice = new UpdateCpeDevice(cpeRepo);
  const deleteCpeDevice = new DeleteCpeDevice(cpeRepo);
  const assignCpeToClient = new AssignCpeToClient(cpeRepo);

  const tr069Repo = new PrismaTr069Repository();
  const listTr069Profiles = new ListTr069Profiles(tr069Repo);
  const createTr069Profile = new CreateTr069Profile(tr069Repo);
  const updateTr069Profile = new UpdateTr069Profile(tr069Repo);
  const deleteTr069Profile = new DeleteTr069Profile(tr069Repo);
  const listTr069Devices = new ListTr069Devices(tr069Repo);
  const provisionDevice = new ProvisionDevice(tr069Repo);
  const deleteTr069Device = new DeleteTr069Device(tr069Repo);

  const listIpv6Networks = new ListIpv6Networks(ipNetworkRepo);
  const createIpv6Network = new CreateIpv6Network(ipNetworkRepo);

  const hardwareRepo = new PrismaHardwareRepository();
  const listHardwareAssets = new ListHardwareAssets(hardwareRepo);
  const createHardwareAsset = new CreateHardwareAsset(hardwareRepo);
  const updateHardwareAsset = new UpdateHardwareAsset(hardwareRepo);
  const deleteHardwareAsset = new DeleteHardwareAsset(hardwareRepo);

  const gponRepo = new PrismaGponRepository();
  const listOlts = new ListOlts(gponRepo);
  const getOlt = new GetOlt(gponRepo);
  const createOlt = new CreateOlt(gponRepo);
  const listOnus = new ListOnus(gponRepo);
  const getOnu = new GetOnu(gponRepo);
  const listOnusByOlt = new ListOnusByOlt(gponRepo);
  const createOnu = new CreateOnu(gponRepo);
  const updateOnuStatus = new UpdateOnuStatus(gponRepo);

  const radiusRepo = new PrismaRadiusSessionRepository();
  const listRadiusSessions = new ListRadiusSessions(radiusRepo);
  const disconnectSession = new DisconnectSession(radiusRepo);

  const monitoringRepo = new PrismaMonitoringRepository();
  const getMonitoringStats = new GetMonitoringStats(monitoringRepo);
  const listMonitoringDevices = new ListMonitoringDevices(monitoringRepo);
  const listMonitoringAlerts = new ListMonitoringAlerts(monitoringRepo);
  const acknowledgeAlert = new AcknowledgeAlert(monitoringRepo);

  const globalSearch = new GlobalSearch();

  const notificationRepo = new PrismaNotificationRepository();
  const listNotifications = new ListNotifications(notificationRepo);
  const markNotificationRead = new MarkNotificationRead(notificationRepo);
  const markAllNotificationsRead = new MarkAllNotificationsRead(notificationRepo);
  const deleteNotification = new DeleteNotification(notificationRepo);

  // Routes
  app.use('/api/dashboard', createDashboardRouter(getDashboardStats, getDashboardShortcuts, getRecentActivity));
  app.use('/api/messages', createMessagesRouter(listMessages, getMessage, createMessage, markMessageAsRead, deleteMessage));
  app.use('/api/auth', createAuthRouter(authAdapter, rbacUserRepo, rbacUserRoleRepo, resolveUserPermissions));
  app.use('/api/clients', createClientsRouter(listClients, getDetail, getServices, getInvoices, getLogs, authAdapter, createCustomer, getClientStats, deleteCustomer));
  app.use('/api/customers', createClientCommentsRouter(getComments, createComment));
  // TicketStatus catalog — mounted BEFORE the tickets router to avoid /:id catch-all swallowing /statuses.
  app.use('/api/tickets/statuses', createTicketStatusesRouter(
    authAdapter,
    listTicketStatuses, getTicketStatus, createTicketStatus, updateTicketStatusCatalog, deleteTicketStatus,
  ));
  app.use('/api/tickets', createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateTicketStatus, updateTicket, closeTicket, authAdapter));
  app.use('/api/billing', createBillingRouter(getSummary, listInvoices, listPayments, listTransactions, authAdapter));
  app.use('/api/billing', createBillingMonthlyRouter(getMonthly));
  app.use('/api/billing', createCreditNotesRouter(listCreditNotes, getCreditNote, createCreditNote, applyCreditNote, voidCreditNote));
  app.use('/api/billing', createProformasRouter(listProformas, createProforma, convertToInvoice, cancelProforma));
  app.use('/api/billing', createFinanceHistoryRouter(listFinanceHistory));
  // IMPORTANT: workflows router MUST be mounted BEFORE scheduling router because
  // both share the /api/scheduling prefix and scheduling has a /:id catch-all
  // that would otherwise swallow /workflows, /project-categories, /project-types.
  app.use('/api/scheduling', createWorkflowsRouter(
    authAdapter,
    listWorkflows, getWorkflow, createWorkflowUC, updateWorkflowUC, deleteWorkflowUC,
    addStageToWorkflow, removeStageFromWorkflow, reorderStages, updateStageColor,
    listProjectCategory, getProjectCategory, createProjectCategory, updateProjectCategory, deleteProjectCategory,
    listProjectType, getProjectType, createProjectType, updateProjectType, deleteProjectType,
  ));
  // TaskCategory catalog — mounted before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskCategoriesRouter(
    authAdapter,
    listTaskCategory, getTaskCategory, createTaskCategory, updateTaskCategory, deleteTaskCategory,
  ));
  // TaskPriority catalog — also before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskPrioritiesRouter(
    authAdapter,
    listTaskPriority, getTaskPriority, createTaskPriority, updateTaskPriority, deleteTaskPriority,
  ));
  // Gestión Real mirror — read-only sync status endpoint.
  app.use('/api/gestion-real', createGestionRealRouter(
    authAdapter,
    new GetGestionRealSyncStatus(new PrismaSyncStateRepository(), new PrismaMirrorCountsRepository()),
  ));
  // GR sync admin — reset the gr-clients cursor to force a full backfill next tick.
  app.use('/api/admin/gr-sync', createGrSyncRouter(
    authAdapter,
    new ResetGrClientsCursor(new PrismaSyncStateRepository()),
    reconcileGrClients,
  ));
  // Task comments — mounted BEFORE the scheduling catch-all router to avoid /:id swallowing
  const taskCommentRepo = new PrismaTaskCommentRepository();
  const addTaskComment = new AddTaskComment(taskCommentRepo);
  const listTaskComments = new ListTaskComments(taskCommentRepo);
  const deleteTaskComment = new DeleteTaskComment(taskCommentRepo);
  app.use('/api/scheduling', createTaskCommentsRouter(listTaskComments, addTaskComment, deleteTaskComment));

  // Instantiate checklist use cases (change 5)
  const taskTemplateRepoForChecklist = new PrismaTaskTemplateRepository();
  const replaceTemplateItemsUC = new ReplaceTaskTemplateItems(taskTemplateRepoForChecklist);
  const addChecklistItemUC = new AddChecklistItem(schedulingRepo);
  const toggleChecklistItemUC = new ToggleChecklistItem(schedulingRepo);
  const updateChecklistItemUC = new UpdateChecklistItem(schedulingRepo);
  const removeChecklistItemUC = new RemoveChecklistItem(schedulingRepo);
  const reorderChecklistItemsUC = new ReorderChecklistItems(schedulingRepo);
  const assignTemplateToTaskUC = new AssignTemplateToTask(schedulingRepo, taskTemplateRepoForChecklist);
  const clearTaskChecklistUC = new ClearTaskChecklist(schedulingRepo);

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, authAdapter, stageRepo, {
    addChecklistItem: addChecklistItemUC,
    toggleChecklistItem: toggleChecklistItemUC,
    updateChecklistItem: updateChecklistItemUC,
    removeChecklistItem: removeChecklistItemUC,
    reorderChecklistItems: reorderChecklistItemsUC,
    assignTemplateToTask: assignTemplateToTaskUC,
    clearTaskChecklist: clearTaskChecklistUC,
  }, setTaskInventoryReview, bulkMoveTasksToStage));
  const projectRepo = new PrismaProjectRepository();
  const listProjectsUC   = new ListProjects(projectRepo);
  const getProjectUC     = new GetProject(projectRepo);
  const createProjectUC  = new CreateProject(projectRepo, projectCategoryRepo, projectTypeRepo, workflowRepo, adminRepo, partnerRepo);
  const updateProjectUC  = new UpdateProject(projectRepo, projectCategoryRepo, projectTypeRepo, workflowRepo, adminRepo, partnerRepo);
  const deleteProjectUC  = new DeleteProject(projectRepo);

  // IClass SO type catalog — must come after projectRepo is defined
  const iclassSoTypeRepo = new PrismaIClassSoTypeRepository();
  const syncIClassSoTypes = new SyncIClassSoTypes(buildIClassClient(), iclassSoTypeRepo);
  const listIClassSoTypes = new ListIClassSoTypes(iclassSoTypeRepo);
  const assignIClassSoType = new AssignIClassSoTypeToProject(projectRepo, iclassSoTypeRepo);

  app.use('/api/projects', createProjectsRouter(listProjectsUC, getProjectUC, createProjectUC, updateProjectUC, deleteProjectUC, authAdapter, assignIClassSoType));
  // GR installation-order ingest admin — config/status/needs-review (projectRepo + schedulingRepo already built above).
  const grIngestConfigRepo = new PrismaGestionRealIngestConfigRepository();
  app.use('/api/gestion-real-ingest', createGestionRealIngestRouter(
    authAdapter,
    new GetIngestConfig(grIngestConfigRepo),
    new UpdateIngestConfig(grIngestConfigRepo, projectRepo),
    new GetIngestStatus(new PrismaSyncStateRepository()),
    new ListNeedsReviewTasks(schedulingRepo),
  ));
  const taskTemplateRepo = new PrismaTaskTemplateRepository();
  app.use(
    '/api/task-templates',
    createTaskTemplateRouter(
      new ListTaskTemplates(taskTemplateRepo),
      new GetTaskTemplate(taskTemplateRepo),
      new CreateTaskTemplate(taskTemplateRepo),
      new UpdateTaskTemplate(taskTemplateRepo),
      new DeleteTaskTemplate(taskTemplateRepo),
      authAdapter,
      replaceTemplateItemsUC,
    ),
  );
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

  // IClass admin — SO type catalog sync + list (admin-only).
  app.use('/api/admin/iclass', createIClassAdminRouter(syncIClassSoTypes, listIClassSoTypes, authAdapter));

  // IClass closure loop — result-code catalog + configurable result→stage mapping + status + backfill.
  const iclassResultCodeRepo = new PrismaIClassResultCodeRepository();
  const closureIngest = new IngestClosedServiceOrders(
    buildIClassClient(),
    new PrismaClosedServiceOrderRepository(),
    iclassResultCodeRepo,
    schedulingRepo,
    new PrismaSyncStateRepository(),
  );
  app.use('/api/admin/iclass', createIClassClosureRouter(
    new SyncIClassResultCodes(buildIClassClient(), iclassResultCodeRepo),
    new ListIClassResultCodes(iclassResultCodeRepo),
    new AssignResultCodeStage(iclassResultCodeRepo, stageRepo),
    new GetClosureStatus(new PrismaSyncStateRepository()),
    new BackfillClosedServiceOrders(buildIClassClient(), schedulingRepo, closureIngest),
    authAdapter,
  ));

  // Feature flags — runtime toggles persisted in DB (admin-only).
  // featureFlagRepo is created earlier (wired into SendTaskToIClass).
  app.use('/api/admin/feature-flags', createFeatureFlagsRouter(
    authAdapter,
    new ListFeatureFlags(featureFlagRepo),
    new GetFeatureFlag(featureFlagRepo),
    new SetFeatureFlag(featureFlagRepo),
  ));

  // SDD #2 Phase 6 — RBAC user management CRUD + role assignment endpoints
  // Use cases instantiated here (inside createApp) so they can access the module-level repos.
  const listRbacUsersUC   = new ListRbacUsers(rbacUserRepo, rbacUserRoleRepo, rbacRoleRepo);
  const getRbacUserUC     = new GetRbacUser(rbacUserRepo, rbacUserRoleRepo, rbacRoleRepo);
  const createRbacUserUC  = new CreateRbacUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo, passwordHasher);
  const updateRbacUserUC  = new UpdateRbacUser(rbacUserRepo, passwordHasher);
  const deleteRbacUserUC  = new DeleteRbacUser(rbacUserRepo, rbacUserRoleRepo, rbacRoleRepo);
  const changePasswordUC  = new ChangeRbacUserPassword(rbacUserRepo, passwordHasher);
  const listRolesForUserUC = new ListRolesForUser(rbacUserRepo, rbacUserRoleRepo, rbacRoleRepo);
  const setRolesForUserUC  = new SetRolesForUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);
  const assignRoleToUserUC = new AssignRoleToUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);
  const removeRoleFromUserUC = new RemoveRoleFromUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);

  const authMiddlewareForRbac = createAuthMiddleware(authAdapter);

  app.use(
    '/api/admin/rbac/users',
    authMiddlewareForRbac,
    requirePerm('admin', 'manage'),
    createRbacUserRouter({
      listUsers: listRbacUsersUC,
      getUser: getRbacUserUC,
      createUser: createRbacUserUC,
      updateUser: updateRbacUserUC,
      deleteUser: deleteRbacUserUC,
      changePassword: changePasswordUC,
      listRolesForUser: listRolesForUserUC,
      setRolesForUser: setRolesForUserUC,
      assignRoleToUser: assignRoleToUserUC,
      removeRoleFromUser: removeRoleFromUserUC,
    }),
  );

  // /api/admin/rbac/roles — role catalog CRUD (SDD #3 Phase 4b)
  const createRbacRoleUC = new CreateRbacRole(rbacRoleRepo);
  const deleteRbacRoleUC = new DeleteRbacRole(rbacRoleRepo);

  const rbacRolesRouter = Router();
  rbacRolesRouter.use(authMiddlewareForRbac);

  rbacRolesRouter.get('/', requirePerm('rbac', 'read'), async (_req, res, next) => {
    try {
      const roles = await rbacRoleRepo.listAll();
      res.json({ roles: roles.map(toRbacRoleDto) });
    } catch (err) {
      next(err);
    }
  });

  rbacRolesRouter.post('/', requirePerm('rbac', 'manage_roles'), async (req, res, next) => {
    try {
      const role = await createRbacRoleUC.execute(req.body);
      res.status(201).json(toRbacRoleDto(role));
    } catch (err) {
      next(err);
    }
  });

  rbacRolesRouter.delete('/:id', requirePerm('rbac', 'manage_roles'), async (req, res, next) => {
    try {
      await deleteRbacRoleUC.execute(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/admin/rbac/roles', rbacRolesRouter);

  // SDD #3 Phase 4a — role-permissions sub-resource + permissions catalog
  // IMPORTANT: these are mounted AFTER the inline rbacRolesRouter (GET /api/admin/rbac/roles)
  // because Express matches routes in registration order and /:id/permissions needs the
  // roles router to have registered first so GET / (list) doesn't shadow GET /:id/permissions.
  const listAllPermissionsUC  = new ListAllPermissionsWithModule(rbacPermissionRepo);
  const listPermIdsForRoleUC  = new ListPermissionIdsForRole(rbacRoleRepo, rbacRolePermissionRepo);
  const setRolePermissionsUC  = new SetRolePermissions(rbacRoleRepo, rbacRolePermissionRepo, rbacPermissionRepo);

  app.use(
    '/api/admin/rbac/roles',
    authMiddlewareForRbac,
    createRolePermissionsRouter(
      listPermIdsForRoleUC,
      setRolePermissionsUC,
      requirePerm('rbac', 'read'),
      requirePerm('rbac', 'manage_roles'),
      auditEventRepo,
    ),
  );

  app.use(
    '/api/admin/rbac/permissions',
    authMiddlewareForRbac,
    requirePerm('rbac', 'read'),
    createPermissionsRouter(listAllPermissionsUC),
  );

  // SDD #4 — audit log query endpoint
  app.use(
    '/api/admin/audit-events',
    authMiddlewareForRbac,
    requirePerm('admin', 'view_activity_log'),
    createAuditEventsRouter(new ListAuditEvents(auditEventRepo)),
  );

  // Profile routes (uses internal router directly)
  const profileRouter = Router();
  profileRoutes(profileRouter);
  app.use('/api', profileRouter);

  // 404
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Global error handler (shared with route tests — single source of truth).
  app.use(errorHandler);

  return app;
}
