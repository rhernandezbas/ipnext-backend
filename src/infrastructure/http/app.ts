import express, { Router, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { createLoginRateLimiter } from './middleware/rateLimiters';
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
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { GetTicketStats } from '@application/use-cases/GetTicketStats';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { GetTicket } from '@application/use-cases/GetTicket';
import { UpdateTicketStatus } from '@application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '@application/use-cases/UpdateTicket';
import { CloseTicket } from '@application/use-cases/CloseTicket';
import { ArchiveTicket } from '@application/use-cases/ArchiveTicket';
import { DeleteTicketHard } from '@application/use-cases/DeleteTicketHard';
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
import { createTicketCommentsRouter } from './routes/ticketComments.routes';
import { ListTicketComments } from '@application/use-cases/ListTicketComments';
import { AddTicketComment } from '@application/use-cases/AddTicketComment';
import { PrismaTicketCommentRepository } from '../adapters/prisma/PrismaTicketCommentRepository';
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
import { PrismaTaskActivityRepository } from '../adapters/prisma/PrismaTaskActivityRepository';
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
import { GetTaskActivity } from '@application/use-cases/GetTaskActivity';
import { RecordTaskActivity } from '@application/use-cases/RecordTaskActivity';
import { DefaultTaskActivityRecorder } from '../services/DefaultTaskActivityRecorder';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { CreateTaskFromTicket } from '@application/use-cases/CreateTaskFromTicket';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { BulkMoveTasksToStage } from '@application/use-cases/BulkMoveTasksToStage';
import { SendTaskToIClass } from '@application/use-cases/SendTaskToIClass';
import { ListIClassNodes } from '@application/use-cases/ListIClassNodes';
import { ResendTaskToIClassWithNode } from '@application/use-cases/ResendTaskToIClassWithNode';
import { buildIClassClient } from './iclass.factory';
import { PrismaIClassDispatchAttemptRepository } from '../adapters/prisma/PrismaIClassDispatchAttemptRepository';
import { SetTaskInventoryReview } from '@application/use-cases/SetTaskInventoryReview';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
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
import { UpdateStage } from '@application/use-cases/UpdateStage';
import { RemoveStageFromWorkflow } from '@application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '@application/use-cases/ReorderStages';
import { ListProjectCategory } from '@application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '@application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '@application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '@application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '@application/use-cases/DeleteProjectCategory';
import { PrismaTaskCategoryRepository } from '../adapters/prisma/PrismaTaskCategoryRepository';
import { createTaskCategoriesRouter } from './routes/taskCategories.routes';
// ContractTechnology catalog
import { PrismaContractTechnologyRepository } from '../adapters/prisma/PrismaContractTechnologyRepository';
import { createContractTechnologiesRouter } from './routes/contractTechnologies.routes';
import { ListContractTechnology } from '@application/use-cases/ListContractTechnology';
import { GetContractTechnology } from '@application/use-cases/GetContractTechnology';
import { CreateContractTechnology } from '@application/use-cases/CreateContractTechnology';
import { UpdateContractTechnology } from '@application/use-cases/UpdateContractTechnology';
import { DeleteContractTechnology } from '@application/use-cases/DeleteContractTechnology';
// Global contracts listing — feeds the frontend contracts page.
import { PrismaContractRepository } from '../adapters/prisma/PrismaContractRepository';
import { createContractsRouter } from './routes/contracts.routes';
import { ListContracts } from '@application/use-cases/ListContracts';
import { GetContractStats } from '@application/use-cases/GetContractStats';
// #43 — ServiceCatalog ABM + ContractService CRUD + Contract name.
import { PrismaServiceCatalogRepository } from '../adapters/prisma/PrismaServiceCatalogRepository';
import { PrismaContractServiceRepository } from '../adapters/prisma/PrismaContractServiceRepository';
import { createServiceCatalogRouter } from './routes/serviceCatalog.routes';
import { createContractServicesRouter } from './routes/contractServices.routes';
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import { ListServiceCatalog } from '@application/use-cases/ListServiceCatalog';
import { CreateServiceCatalog } from '@application/use-cases/CreateServiceCatalog';
import { UpdateServiceCatalog } from '@application/use-cases/UpdateServiceCatalog';
import { DeleteServiceCatalog } from '@application/use-cases/DeleteServiceCatalog';
import { AddContractService } from '@application/use-cases/AddContractService';
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { createGestionRealRouter } from './routes/gestionReal.routes';
import { createGrSyncRouter } from './routes/gr-sync.routes';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ArmGrContractsBackfill } from '@application/use-cases/ArmGrContractsBackfill';
import { ResyncAllGr } from '@application/use-cases/ResyncAllGr';
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
// GR client-sync config (gr-clients-sync-config-page) — RBAC-guarded settings endpoints
import { createGestionRealSyncRouter } from './routes/gestionRealSync.routes';
import { GetSyncConfig } from '@application/use-cases/GetSyncConfig';
import { UpdateSyncConfig } from '@application/use-cases/UpdateSyncConfig';
import { PrismaGestionRealSyncConfigRepository } from '../adapters/prisma/PrismaGestionRealSyncConfigRepository';
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
import { PrismaDeviceTypeCatalogRepository } from '../adapters/prisma/PrismaDeviceTypeCatalogRepository';
import { createDeviceTypeCatalogRouter } from './routes/deviceTypeCatalog.routes';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { ListDeviceType } from '@application/use-cases/ListDeviceType';
import { GetDeviceType } from '@application/use-cases/GetDeviceType';
import { CreateDeviceType } from '@application/use-cases/CreateDeviceType';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import { DeleteDeviceType } from '@application/use-cases/DeleteDeviceType';
import { PrismaTicketStatusRepository } from '../adapters/prisma/PrismaTicketStatusRepository';
import { createTicketStatusesRouter } from './routes/ticketStatuses.routes';
import { ListTicketStatuses } from '@application/use-cases/ListTicketStatuses';
import { GetTicketStatus } from '@application/use-cases/GetTicketStatus';
import { CreateTicketStatus } from '@application/use-cases/CreateTicketStatus';
import { UpdateTicketStatusCatalog } from '@application/use-cases/UpdateTicketStatusCatalog';
import { DeleteTicketStatus } from '@application/use-cases/DeleteTicketStatus';
import { PrismaTicketAreaCatalogRepository } from '../adapters/prisma/PrismaTicketAreaCatalogRepository';
import { createTicketAreasRouter } from './routes/ticketAreas.routes';
import { ListTicketAreas } from '@application/use-cases/ListTicketAreas';
import { GetTicketArea } from '@application/use-cases/GetTicketArea';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import { UpdateTicketArea } from '@application/use-cases/UpdateTicketArea';
import { DeleteTicketArea } from '@application/use-cases/DeleteTicketArea';
// #79 — Ticket SLA timer config (singleton)
import { PrismaTicketSlaConfigRepository } from '../adapters/prisma/PrismaTicketSlaConfigRepository';
import { createTicketSlaConfigRouter } from './routes/ticketSlaConfig.routes';
import { GetTicketSlaConfig } from '@application/use-cases/GetTicketSlaConfig';
import { UpdateTicketSlaConfig } from '@application/use-cases/UpdateTicketSlaConfig';
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
// World A Inventory use cases removed in Wave 7 (Capstone).
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
import { ListNetworkSitesWithUisp } from '@application/use-cases/ListNetworkSitesWithUisp';
// UISP mirror routes
import { createUispRouter } from './routes/uisp.routes';
import { PrismaUispSiteRepository } from '../adapters/prisma/PrismaUispSiteRepository';
import { PrismaUispDeviceRepository } from '../adapters/prisma/PrismaUispDeviceRepository';
import { ListUispSites } from '@application/use-cases/ListUispSites';
import { GetUispSiteDetail } from '@application/use-cases/GetUispSiteDetail';
import { GetUispSyncStatus } from '@application/use-cases/GetUispSyncStatus';
import { TriggerUispSync } from '@application/use-cases/TriggerUispSync';
import { UispSyncScheduler } from '../scheduling/UispSyncScheduler';
// Gigared TV integration routes (#47)
import { createGigaredRouter, createGigaredReadyMiddleware } from './routes/gigared.routes';
import { PrismaGigaredConfigRepository } from '../adapters/prisma/PrismaGigaredConfigRepository';
import { GigaredClient } from '../adapters/gigared/GigaredClient';
import { GetGigaredConfig } from '@application/use-cases/gigared/GetGigaredConfig';
import { UpdateGigaredConfig } from '@application/use-cases/gigared/UpdateGigaredConfig';
import { GetGigaredSummary } from '@application/use-cases/gigared/GetGigaredSummary';
import { ListGigaredAccounts } from '@application/use-cases/gigared/ListGigaredAccounts';
import { GetGigaredCustomerAccount } from '@application/use-cases/gigared/GetGigaredCustomerAccount';
import { LinkCustomerToCic } from '@application/use-cases/gigared/LinkCustomerToCic';
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import { AddTvService } from '@application/use-cases/gigared/AddTvService';
import { RemoveTvService } from '@application/use-cases/gigared/RemoveTvService';
import { SetOttStatus } from '@application/use-cases/gigared/SetOttStatus';
import { CancelTv } from '@application/use-cases/gigared/CancelTv';
import { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import { PrismaTvCredentialsReader } from '../adapters/prisma/PrismaTvCredentialsReader';
import { PrismaClientTvCancellationRepository } from '../adapters/prisma/PrismaClientTvCancellationRepository';
import { PrismaClientTvActivationRepository } from '../adapters/prisma/PrismaClientTvActivationRepository';
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
import { PrismaIClassNodeRepository } from '../adapters/prisma/PrismaIClassNodeRepository';
import { SyncIClassNodes } from '@application/use-cases/SyncIClassNodes';
import { ListIClassNodeCatalog } from '@application/use-cases/ListIClassNodeCatalog';
import { AssignIClassNodeToNetworkSite } from '@application/use-cases/AssignIClassNodeToNetworkSite';
import { createIClassAdminRouter } from './routes/iclass-admin.routes';
import { createIClassClosureRouter } from './routes/iclass-closure.routes';
import { TaskAutocompleteScheduler } from '../scheduling/TaskAutocompleteScheduler';
import { BackfillScheduler } from '../scheduling/BackfillScheduler';
import { PrismaIClassClosureConfigRepository } from '../adapters/prisma/PrismaIClassClosureConfigRepository';
import { GetIClassClosureConfig } from '@application/use-cases/GetIClassClosureConfig';
import { UpdateIClassClosureConfig } from '@application/use-cases/UpdateIClassClosureConfig';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { SyncIClassResultCodes } from '@application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '@application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '@application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '@application/use-cases/GetClosureStatus';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { ListInFlightTasks } from '@application/use-cases/ListInFlightTasks';
import { ReconcileTaskClosure } from '@application/use-cases/ReconcileTaskClosure';
import { createContractInventoryRouter } from './routes/contractInventory.routes';
import { createMaterialTypeCatalogRouter } from './routes/materialTypeCatalog.routes';
import { createTaskAuditFindingsRouter } from './routes/taskAuditFindings.routes';
import { ListTaskAuditFindings } from '@application/use-cases/ListTaskAuditFindings';
import { PrismaTaskAuditRepository } from '../adapters/prisma/PrismaTaskAuditRepository';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { PrismaStockLocationRepository } from '../adapters/prisma/PrismaStockLocationRepository';
import { PrismaInventoryAssetRepository } from '../adapters/prisma/PrismaInventoryAssetRepository';
import { PrismaInventoryMovementRepository } from '../adapters/prisma/PrismaInventoryMovementRepository';
import { PrismaMaterialStockRepository } from '../adapters/prisma/PrismaMaterialStockRepository';
import { PrismaUnitOfWork } from '../adapters/prisma/PrismaUnitOfWork';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { StageMaterialDeduction } from '@application/use-cases/StageMaterialDeduction';
import { AddAssetToDepot } from '@application/use-cases/AddAssetToDepot';
import { AddMaterialToDepot } from '@application/use-cases/AddMaterialToDepot';
import { createInventoryRouter } from './routes/inventory.routes';
// Wave 7 (Capstone) — dashboard use cases
import { GetInventoryOverview } from '@application/use-cases/GetInventoryOverview';
import { ListInventoryMovements } from '@application/use-cases/ListInventoryMovements';
import { GetLowStockAlerts } from '@application/use-cases/GetLowStockAlerts';
// EPIC #38 W5b — vehicle stock
import { GetVehicleStock } from '@application/use-cases/GetVehicleStock';
import { IssueStockToVehicle } from '@application/use-cases/IssueStockToVehicle';
import { ResolveVehicleLocation } from '@application/use-cases/ResolveVehicleLocation';
import { PrismaVehicleRepository } from '../adapters/prisma/PrismaVehicleRepository';
import { CreateVehicle } from '@application/use-cases/CreateVehicle';
import { UpdateVehicle } from '@application/use-cases/UpdateVehicle';
import { DeleteVehicle } from '@application/use-cases/DeleteVehicle';
import { ListVehicles } from '@application/use-cases/ListVehicles';
import { GetVehicle } from '@application/use-cases/GetVehicle';
import { createVehicleRouter } from './routes/vehicle.routes';
import { PrismaReturnSuggestionRepository } from '../adapters/prisma/PrismaReturnSuggestionRepository';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { RetireContractEquipment } from '@application/use-cases/RetireContractEquipment';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { CreateManualSuggestion } from '@application/use-cases/CreateManualSuggestion';
import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { ListClientEquipment } from '@application/use-cases/ListClientEquipment';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { RemoveInstalledItem } from '@application/use-cases/RemoveInstalledItem';
import { RecordMaterialConsumption } from '@application/use-cases/RecordMaterialConsumption';
import { ListTaskMaterialConsumptions } from '@application/use-cases/ListTaskMaterialConsumptions';
import { DeleteMaterialConsumption } from '@application/use-cases/DeleteMaterialConsumption';
import { PrismaInventorySuggestionRepository } from '../adapters/prisma/PrismaInventorySuggestionRepository';
import { PrismaContractInventoryRepository } from '../adapters/prisma/PrismaContractInventoryRepository';
import { PrismaMaterialCatalogRepository } from '../adapters/prisma/PrismaMaterialCatalogRepository';
import { PrismaTaskMaterialConsumptionRepository } from '../adapters/prisma/PrismaTaskMaterialConsumptionRepository';
import { PrismaMaterialDeductionSuggestionRepository } from '../adapters/prisma/PrismaMaterialDeductionSuggestionRepository';
import { ListPendingDeductions } from '@application/use-cases/ListPendingDeductions';
import { ConfirmMaterialDeduction } from '@application/use-cases/ConfirmMaterialDeduction';
import { MaterialCatalogService } from '@application/services/MaterialCatalogService';
import { ListMaterial } from '@application/use-cases/ListMaterial';
import { GetMaterial } from '@application/use-cases/GetMaterial';
import { CreateMaterial } from '@application/use-cases/CreateMaterial';
import { UpdateMaterial } from '@application/use-cases/UpdateMaterial';
import { DeleteMaterial } from '@application/use-cases/DeleteMaterial';
import { ListTechniciansWithStock } from '@application/use-cases/ListTechniciansWithStock';
import { ListReturnSuggestionsByTask } from '@application/use-cases/ListReturnSuggestionsByTask';
import { buildClosureSideEffects } from '../scheduling/closureSideEffects';
import { ReprocessClosureSideEffects } from '@application/use-cases/ReprocessClosureSideEffects';
import { GetPendingSideEffectsCount } from '@application/use-cases/GetPendingSideEffectsCount';
import { GetPendingSideEffectsList } from '@application/use-cases/GetPendingSideEffectsList';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaRbacUserRepository } from '../adapters/prisma/PrismaRbacUserRepository';
import { PrismaRbacRoleRepository } from '../adapters/prisma/PrismaRbacRoleRepository';
import { PrismaRbacPermissionRepository } from '../adapters/prisma/PrismaRbacPermissionRepository';
import { PrismaAuditEventRepository } from '../adapters/prisma/PrismaAuditEventRepository';
import { PrismaSessionRepository } from '../adapters/prisma/PrismaSessionRepository';
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
import { createSessionsRouter } from './routes/sessions.routes';
import { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';
import { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory';
// SDD #3 Phase 4b — role catalog mutation use cases
import { CreateRbacRole } from '@application/use-cases/rbac/CreateRbacRole';
import { DeleteRbacRole } from '@application/use-cases/rbac/DeleteRbacRole';

/**
 * Minimal FK lookup for scheduling use-case FK validation.
 *
 * Each branch calls findUnique on the correct Prisma delegate with its own
 * concrete argument type — no `as any` needed, TypeScript can verify each call.
 */
// Covers entity kinds used for FK validation in scheduling use cases.
// #70: the declared shape includes grClienteId so reverting the select below breaks the COMPILE,
// not just runtime (RegisterGigaredAccount needs it to derive the deterministic password).
function prismaClientLookup(model: 'Client' | 'Contract' | 'Partner' | 'Project' | 'Ticket', id: string): Promise<{ id: string; grClienteId?: string | null; tvActivationSeq?: number | null } | null> {
  switch (model) {
    // #70 — Client carries grClienteId so RegisterGigaredAccount can derive the deterministic
    // TV password server-side. Selecting it here is harmless for the existence-only callers.
    // #81 — also carries tvActivationSeq so every TV use case resolves the CURRENT internal_id
    // (currentTvInternalId(id, seq)) instead of the bare Client.id. Cast keeps it compile-safe
    // before the Prisma Client is regenerated with the new column (mirror of tvCancelledAt).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'Client':   return (prisma as any).client.findUnique({ where: { id }, select: { id: true, grClienteId: true, tvActivationSeq: true } });
    case 'Contract': return prisma.contract.findUnique({ where: { id }, select: { id: true } });
    case 'Partner':  return prisma.partner.findUnique({ where: { id }, select: { id: true } });
    case 'Project':  return prisma.project.findUnique({ where: { id }, select: { id: true } });
    case 'Ticket':   return (prisma as any).ticket.findUnique({ where: { id }, select: { id: true } });
  }
}

// #47k — ownership-aware Contract lookup for the Gigared use cases. Returns clientId so each
// destructive TV use case can assert the contract belongs to the target customer before any
// Gigared write (a foreign contractId → 404, no cross-customer reconcile). One findUnique.
function prismaContractOwnershipLookup(id: string): Promise<{ id: string; clientId: string } | null> {
  return prisma.contract.findUnique({ where: { id }, select: { id: true, clientId: true } });
}

// #40 — ProjectKindLookup wiring: a single findUnique resolves both project
// existence AND the isNetworkProject flag, so CreateTask's symmetric project↔kind
// guard runs from ONE query (no N+1). Replaces the old prismaClientLookup('Project')
// wrapper at the CreateTask project slot.
function prismaProjectKindLookup(id: string): Promise<{ id: string; isNetworkProject: boolean } | null> {
  return (prisma.project as any).findUnique({ where: { id }, select: { id: true, isNetworkProject: true } });
}

// RBAC repositories — module-level singletons so requirePerm can be a named export
const rbacUserRepo           = new PrismaRbacUserRepository();
const rbacRoleRepo           = new PrismaRbacRoleRepository();
const rbacPermissionRepo     = new PrismaRbacPermissionRepository();
const rbacUserRoleRepo       = new PrismaRbacUserRoleRepository();
const rbacRolePermissionRepo = new PrismaRbacRolePermissionRepository();
// SDD #4 — single audit repo instance shared by the middleware + emit + query endpoint
const auditEventRepo         = new PrismaAuditEventRepository();
// SDD #5 — single session repo shared by auth middleware + login/logout + endpoints
const sessionRepo            = new PrismaSessionRepository();

// PasswordHasher + LoginRbacUser — module-level singletons (SDD #2 Phase 5)
const passwordHasher = new BcryptPasswordHasher();
const loginRbacUser  = new LoginRbacUser(rbacUserRepo, passwordHasher);

// SDD #3 Phase 1a — ResolveUserPermissions resolves flat permission code list for a user
const resolveUserPermissions = new ResolveUserPermissions(rbacUserRoleRepo, rbacRolePermissionRepo, rbacPermissionRepo);

// Convenience factory — routes in future SDDs import this instead of wiring the repo manually
export const requirePerm = (m: RbacModuleCode, a: PermissionAction) =>
  requirePermission(rbacUserRepo, m, a);

export function createApp(taskAutocomplete?: TaskAutocompleteScheduler | null, backfillScheduler?: BackfillScheduler | null, uispSyncScheduler?: UispSyncScheduler | null) {
  const app = express();

  // SDD #6a — behind EasyPanel's proxy; trust the first hop so the rate limiter
  // and req.ip see the real client IP (not the proxy's).
  app.set('trust proxy', 1);

  // SDD #6a — security headers (helmet) + CORS origin from env.
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  // #44 — ticket comment images travel as base64 data-URIs; the default 100kb limit
  // would reject them. This path-scoped 8mb parser MUST be registered BEFORE the global
  // express.json() — the global parser runs ahead of every router and would otherwise
  // reject big bodies with 413 before the comments router ever sees them. body-parser
  // skips the second parse (req._body), so the double registration is safe.
  app.use('/api/tickets/:ticketId/comments', express.json({ limit: '8mb' }));
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
  const getContracts = new GetClientContracts(customerAdapter);
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
  // ticketStatusRepo is needed by CloseTicket (#46 M1: resolve the closed-like
  // catalog name instead of hardcoding 'closed'). Instantiated here so it is in
  // scope for closeTicket; reused below for the status-catalog use cases.
  const ticketStatusRepo = new PrismaTicketStatusRepository();
  const closeTicket = new CloseTicket(ticketAdapter, ticketStatusRepo);
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
  // task-activity-log (#10) — read side + best-effort recorder for write UCs
  const taskActivityRepo = new PrismaTaskActivityRepository();
  const getTaskActivity = new GetTaskActivity(schedulingRepo, taskActivityRepo);
  const taskActivityRecorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(taskActivityRepo));
  // Scheduling reporter/assignee/watcher ids are validated against RbacUser
  // (post SDD #2 — Admin table is being phased out, no fallback). The lookup
  // returns { id, name } on hit, null on miss — satisfies the EntityLookup port.
  // The name powers the watcher add/remove diff in the activity feed (#17).
  const userLookupForScheduling = {
    findById: async (id: string): Promise<{ id: string; name?: string } | null> => {
      const rbacUser = await rbacUserRepo.findById(id);
      return rbacUser ? { id: rbacUser.id, name: rbacUser.name } : null;
    },
  };
  // network-node-task (#29): instanciar antes de createTask para inyectarlo en el constructor
  const networkSiteRepoForCreateTask = new PrismaNetworkSiteRepository();

  const createTask = new CreateTask(
    schedulingRepo,
    // EntityLookup wrappers for FK validation (return { id } | null)
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaClientLookup('Contract', id) },
    { findById: (id: string) => prismaClientLookup('Partner', id) },
    userLookupForScheduling,
    // #40 — project slot uses the kind-aware lookup (existence + isNetworkProject).
    { findById: (id: string) => prismaProjectKindLookup(id) },
    { findById: (id: string) => prismaClientLookup('Ticket', id) },
    taskActivityRecorder,
    networkSiteRepoForCreateTask,
  );
  const createTaskFromTicket = new CreateTaskFromTicket(createTask, schedulingRepo);
  const updateTask = new UpdateTask(
    schedulingRepo,
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaClientLookup('Contract', id) },
    { findById: (id: string) => prismaClientLookup('Partner', id) },
    userLookupForScheduling,
    // #40 — project slot uses the kind-aware lookup (existence + isNetworkProject),
    // so the symmetric project↔kind guard runs on update too.
    { findById: (id: string) => prismaProjectKindLookup(id) },
    taskActivityRecorder,
  );
  const deleteTask = new DeleteTask(schedulingRepo);
  // IClass integration: moving a task to "Enviar a IClass" delegates the OS
  // creation. The on/off decision lives in the feature flag (default OFF).
  const featureFlagRepo = new PrismaFeatureFlagRepository();
  // Audit repo for IClass dispatch attempts — injected as 4th arg (AD-6: optional on SendTaskToIClass).
  const iclassDispatchAttemptRepo = new PrismaIClassDispatchAttemptRepository();
  const sendTaskToIClass = new SendTaskToIClass(schedulingRepo, featureFlagRepo, buildIClassClient(), iclassDispatchAttemptRepo, taskActivityRecorder, networkSiteRepoForCreateTask);
  const moveTaskToStage = new MoveTaskToStage(schedulingRepo, stageRepo, sendTaskToIClass, taskActivityRecorder);

  const bulkMoveTasksToStage = new BulkMoveTasksToStage(moveTaskToStage);
  const setTaskInventoryReview = new SetTaskInventoryReview(schedulingRepo, taskActivityRecorder);
  // #41 — general status (open / closed / dismissed) writer.
  const setTaskGeneralStatus = new SetTaskGeneralStatus(schedulingRepo, taskActivityRecorder);

  const listWorkflows = new ListWorkflows(workflowRepo);
  const getWorkflow = new GetWorkflow(workflowRepo);
  const createWorkflowUC = new CreateWorkflow(workflowRepo);
  const updateWorkflowUC = new UpdateWorkflow(workflowRepo);
  const deleteWorkflowUC = new DeleteWorkflow(workflowRepo, stageRepo);
  const addStageToWorkflow = new AddStageToWorkflow(workflowRepo, stageRepo);
  const removeStageFromWorkflow = new RemoveStageFromWorkflow(stageRepo);
  const reorderStages = new ReorderStages(workflowRepo, stageRepo);
  const updateStageColor = new UpdateStageColor(stageRepo);
  const updateStageUC = new UpdateStage(stageRepo);

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

  const contractTechnologyRepo = new PrismaContractTechnologyRepository();
  const listContractTechnology = new ListContractTechnology(contractTechnologyRepo);
  const getContractTechnology = new GetContractTechnology(contractTechnologyRepo);
  const createContractTechnology = new CreateContractTechnology(contractTechnologyRepo);
  const updateContractTechnology = new UpdateContractTechnology(contractTechnologyRepo);
  const deleteContractTechnology = new DeleteContractTechnology(contractTechnologyRepo);

  // Global contracts listing.
  const contractRepo = new PrismaContractRepository();
  const listContracts = new ListContracts(contractRepo);
  const getContractStats = new GetContractStats(contractRepo);

  const taskPriorityRepo = new PrismaTaskPriorityRepository();
  const listTaskPriority = new ListTaskPriority(taskPriorityRepo);
  const getTaskPriority = new GetTaskPriority(taskPriorityRepo);
  const createTaskPriority = new CreateTaskPriority(taskPriorityRepo);
  const updateTaskPriority = new UpdateTaskPriority(taskPriorityRepo);
  const deleteTaskPriority = new DeleteTaskPriority(taskPriorityRepo);

  const deviceTypeCatalogRepo    = new PrismaDeviceTypeCatalogRepository();
  const deviceTypeCatalogService = new DeviceTypeCatalogService(deviceTypeCatalogRepo);
  const listDeviceType           = new ListDeviceType(deviceTypeCatalogRepo);
  const getDeviceType            = new GetDeviceType(deviceTypeCatalogRepo);
  const createDeviceType         = new CreateDeviceType(deviceTypeCatalogRepo);
  const updateDeviceType         = new UpdateDeviceType(deviceTypeCatalogRepo);
  const deleteDeviceType         = new DeleteDeviceType(deviceTypeCatalogRepo);

  const listTicketStatuses = new ListTicketStatuses(ticketStatusRepo);
  const getTicketStatus = new GetTicketStatus(ticketStatusRepo);
  const createTicketStatus = new CreateTicketStatus(ticketStatusRepo);
  const updateTicketStatusCatalog = new UpdateTicketStatusCatalog(ticketStatusRepo);
  const deleteTicketStatus = new DeleteTicketStatus(ticketStatusRepo);

  // TicketArea catalog — #49
  const ticketAreaRepo = new PrismaTicketAreaCatalogRepository();
  const listTicketAreas = new ListTicketAreas(ticketAreaRepo);
  const getTicketArea = new GetTicketArea(ticketAreaRepo);
  const createTicketArea = new CreateTicketArea(ticketAreaRepo);
  const updateTicketArea = new UpdateTicketArea(ticketAreaRepo);
  const deleteTicketArea = new DeleteTicketArea(ticketAreaRepo);

  // #79 — Ticket SLA timer config (singleton)
  const ticketSlaConfigRepo = new PrismaTicketSlaConfigRepository();
  const getTicketSlaConfig = new GetTicketSlaConfig(ticketSlaConfigRepo);
  const updateTicketSlaConfig = new UpdateTicketSlaConfig(ticketSlaConfigRepo);

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
  // World A Inventory use cases removed in Wave 7 (Capstone).

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
  // uispSiteRepo created here (eagerly) so UpdateNetworkSite can be fully instantiated
  // before the network-site router is wired. This prevents the deferred-closure bug
  // where createNetworkSiteRouter captured an undefined updateNetworkSite reference.
  const uispSiteRepoForNs = new PrismaUispSiteRepository();
  const updateNetworkSite = new UpdateNetworkSite(networkSiteRepo, uispSiteRepoForNs);
  const deleteNetworkSite = new DeleteNetworkSite(networkSiteRepo);
  // uisp-networksite-autoimport: enriched list (batch join with UISP mirror, no N+1)
  const listNetworkSitesWithUisp = new ListNetworkSitesWithUisp(networkSiteRepo, uispSiteRepoForNs);

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
  app.use('/api/auth', createAuthRouter(authAdapter, rbacUserRepo, rbacUserRoleRepo, resolveUserPermissions, sessionRepo, createLoginRateLimiter()));
  app.use('/api/clients', createClientsRouter(listClients, getDetail, getContracts, getInvoices, getLogs, authAdapter, createCustomer, getClientStats, deleteCustomer));
  app.use('/api/customers', createClientCommentsRouter(getComments, createComment));
  // TicketStatus catalog — mounted BEFORE the tickets router to avoid /:id catch-all swallowing /statuses.
  app.use('/api/tickets/statuses', createTicketStatusesRouter(
    authAdapter,
    listTicketStatuses, getTicketStatus, createTicketStatus, updateTicketStatusCatalog, deleteTicketStatus,
  ));
  // TicketArea catalog — mounted BEFORE the tickets router (#49)
  app.use('/api/tickets/areas', createTicketAreasRouter(
    authAdapter,
    requirePerm,
    listTicketAreas, getTicketArea, createTicketArea, updateTicketArea, deleteTicketArea,
  ));
  // #79 — SLA timer config — mounted BEFORE the tickets router so /:id doesn't swallow it
  app.use('/api/tickets/sla-config', createTicketSlaConfigRouter(
    authAdapter,
    requirePerm,
    getTicketSlaConfig, updateTicketSlaConfig,
  ));
  // #85 — archive + hard-delete use cases
  const archiveTicket = new ArchiveTicket(ticketAdapter, ticketStatusRepo);
  const deleteTicketHard = new DeleteTicketHard(ticketAdapter);
  app.use('/api/tickets', createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateTicketStatus, updateTicket, closeTicket, ticketStatusRepo, authAdapter, rbacUserRepo, createTaskFromTicket, schedulingRepo, stageRepo, ticketAreaRepo, archiveTicket, deleteTicketHard, rbacUserRepo));
  // #44 — persisted ticket comments. Mounted on /api/tickets; the tickets router has no
  // catch-all and /:id does not capture /:id/comments (distinct segments), so no collision.
  const ticketCommentRepo = new PrismaTicketCommentRepository();
  app.use('/api/tickets', createTicketCommentsRouter(
    new ListTicketComments(ticketCommentRepo, ticketAdapter),
    new AddTicketComment(ticketCommentRepo, ticketAdapter),
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      read: requirePerm('tickets', 'read'),
      write: requirePerm('tickets', 'write'),
    },
  ));
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
    requirePerm,
    listWorkflows, getWorkflow, createWorkflowUC, updateWorkflowUC, deleteWorkflowUC,
    addStageToWorkflow, removeStageFromWorkflow, reorderStages, updateStageColor, updateStageUC,
    listProjectCategory, getProjectCategory, createProjectCategory, updateProjectCategory, deleteProjectCategory,
    listProjectType, getProjectType, createProjectType, updateProjectType, deleteProjectType,
  ));
  // TaskCategory catalog — mounted before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskCategoriesRouter(
    authAdapter,
    listTaskCategory, getTaskCategory, createTaskCategory, updateTaskCategory, deleteTaskCategory,
  ));
  // ContractTechnology catalog — mounted at /api root (no catch-all conflict).
  app.use('/api', createContractTechnologiesRouter(
    authAdapter,
    listContractTechnology, getContractTechnology, createContractTechnology,
    updateContractTechnology, deleteContractTechnology,
  ));
  // Global contracts listing — mounted at /api root, before the catch-all.
  app.use('/api', createContractsRouter(authAdapter, listContracts, getContractStats));
  // #43 — ServiceCatalog ABM + ContractService CRUD + Contract name, mounted at /api root.
  const serviceCatalogRepo  = new PrismaServiceCatalogRepository();
  const contractServiceRepo = new PrismaContractServiceRepository();
  const contractLookup = { findById: (id: string) => prismaClientLookup('Contract', id) };
  app.use('/api', createServiceCatalogRouter(
    authAdapter,
    requirePerm,
    new ListServiceCatalog(serviceCatalogRepo),
    new CreateServiceCatalog(serviceCatalogRepo),
    new UpdateServiceCatalog(serviceCatalogRepo),
    new DeleteServiceCatalog(serviceCatalogRepo),
  ));
  app.use('/api', createContractServicesRouter(
    authAdapter,
    requirePerm,
    new UpdateContractName(contractRepo),
    new AddContractService(contractServiceRepo, serviceCatalogRepo, contractLookup),
    new UpdateContractService(contractServiceRepo),
    new RemoveContractService(contractServiceRepo),
    new ListContractServiceHistory(contractServiceRepo),
  ));
  // TaskPriority catalog — also before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskPrioritiesRouter(
    authAdapter,
    listTaskPriority, getTaskPriority, createTaskPriority, updateTaskPriority, deleteTaskPriority,
  ));
  // DeviceTypeCatalog — mounted at /api/inventory BEFORE any catch-all.
  app.use('/api/inventory', createDeviceTypeCatalogRouter(
    authAdapter,
    requirePerm,
    listDeviceType, getDeviceType, createDeviceType, updateDeviceType, deleteDeviceType,
    deviceTypeCatalogService,
  ));
  // MaterialCatalog — mirrors DeviceTypeCatalog, mounted at /api/inventory.
  const materialCatalogRepo = new PrismaMaterialCatalogRepository();
  const taskMaterialConsumptionRepo = new PrismaTaskMaterialConsumptionRepository();
  const materialCatalogService = new MaterialCatalogService(materialCatalogRepo);
  const listMaterial = new ListMaterial(materialCatalogRepo);
  const getMaterial = new GetMaterial(materialCatalogRepo);
  const createMaterial = new CreateMaterial(materialCatalogRepo);
  const updateMaterial = new UpdateMaterial(materialCatalogRepo);
  const deleteMaterial = new DeleteMaterial(materialCatalogRepo);
  app.use('/api/inventory', createMaterialTypeCatalogRouter(
    authAdapter,
    requirePerm,
    listMaterial, getMaterial, createMaterial, updateMaterial, deleteMaterial,
    materialCatalogService,
  ));
  // GR client-sync config — RBAC-guarded settings (config GET/PUT + status).
  // Mounted at the more-specific /api/gestion-real/sync path BEFORE the broader
  // /api/gestion-real read-only mount below, so its RBAC-guarded GET /status takes
  // precedence over the legacy auth-only /sync/status (Express matches in order).
  const grSyncConfigRepo = new PrismaGestionRealSyncConfigRepository();
  // Shared SyncState repo + reset/arm/resync-all use cases — wired into both the
  // RBAC sync router (/resync-all, /reset) and the auth-only admin router.
  const grSyncState = new PrismaSyncStateRepository();
  const resetGrClientsCursor = new ResetGrClientsCursor(grSyncState);
  const armGrContractsBackfill = new ArmGrContractsBackfill(grSyncState);
  const resyncAllGr = new ResyncAllGr(resetGrClientsCursor, armGrContractsBackfill);
  app.use('/api/gestion-real/sync', createGestionRealSyncRouter(
    authAdapter,
    requirePerm,
    new GetSyncConfig(grSyncConfigRepo),
    new UpdateSyncConfig(grSyncConfigRepo),
    new GetGestionRealSyncStatus(grSyncState, new PrismaMirrorCountsRepository()),
    resetGrClientsCursor,
    resyncAllGr,
  ));
  // Gestión Real mirror — read-only sync status endpoint (legacy, auth-only).
  app.use('/api/gestion-real', createGestionRealRouter(
    authAdapter,
    new GetGestionRealSyncStatus(new PrismaSyncStateRepository(), new PrismaMirrorCountsRepository()),
  ));
  // GR sync admin — reset the gr-clients cursor to force a full backfill next tick.
  app.use('/api/admin/gr-sync', createGrSyncRouter(
    authAdapter,
    resetGrClientsCursor,
    reconcileGrClients,
  ));
  // Task comments — mounted BEFORE the scheduling catch-all router to avoid /:id swallowing
  const taskCommentRepo = new PrismaTaskCommentRepository();
  const addTaskComment = new AddTaskComment(taskCommentRepo, taskActivityRecorder);
  const listTaskComments = new ListTaskComments(taskCommentRepo);
  const deleteTaskComment = new DeleteTaskComment(taskCommentRepo, taskActivityRecorder);
  app.use('/api/scheduling', createTaskCommentsRouter(
    listTaskComments,
    addTaskComment,
    deleteTaskComment,
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      read: requirePerm('scheduling', 'read'),
      write: requirePerm('scheduling', 'write'),
      delete: requirePerm('scheduling', 'delete'),
    },
  ));

  // IClass closure → inventory: task-scoped suggestion staging + contract installed items.
  // Mounted at /api BEFORE the scheduling /:id catch-all so /scheduling/:taskId/inventory/* survives.
  // Permisos granulares: suggestions usan scheduling.*, contract inventory usa inventory.* (migrado de clients.*).
  const inventorySuggestionRepo = new PrismaInventorySuggestionRepository();
  const contractInventoryRepo = new PrismaContractInventoryRepository();
  // Inventory Foundation (W1) — unified asset/material ledger repos for the dual-write.
  const stockLocationRepo = new PrismaStockLocationRepository();
  const inventoryAssetRepo = new PrismaInventoryAssetRepository();
  const inventoryMovementRepo = new PrismaInventoryMovementRepository();
  // Inventory Foundation (W2 Fix #1/#3) — single transaction boundary for the
  // confirm/replace dual-write (asset + INSTALL movement + CII + setStatus).
  const inventoryUow = new PrismaUnitOfWork();
  const correctConfirmedDeviceType = new CorrectConfirmedDeviceType(inventorySuggestionRepo, contractInventoryRepo);
  // EPIC #38 W6 — material-deduction staging hook, injected into BOTH consumption
  // channels (RecordMaterialConsumption + ConfirmInventorySuggestion.handleMaterial).
  // Flag-gated (inventory-material-auto-deduct, default OFF); best-effort in callers.
  const materialStockRepo = new PrismaMaterialStockRepository();
  const materialDeductionSuggestionRepo = new PrismaMaterialDeductionSuggestionRepository();
  const stageMaterialDeduction = new StageMaterialDeduction(
    featureFlagRepo, materialStockRepo, materialDeductionSuggestionRepo,
    new ResolveTechnicianLocation(stockLocationRepo),
  );
  app.use('/api', createContractInventoryRouter(
    new ListTaskInventorySuggestions(inventorySuggestionRepo, contractInventoryRepo, schedulingRepo),
    new ConfirmInventorySuggestion(
      inventorySuggestionRepo, contractInventoryRepo, schedulingRepo, rbacUserRepo,
      deviceTypeCatalogRepo, materialCatalogRepo, taskMaterialConsumptionRepo,
      stockLocationRepo, inventoryAssetRepo, inventoryMovementRepo, inventoryUow,
      stageMaterialDeduction,
    ),
    new DiscardInventorySuggestion(inventorySuggestionRepo),
    correctConfirmedDeviceType,
    new ListContractInstalledItems(contractInventoryRepo, rbacUserRepo),
    new ListClientEquipment(contractInventoryRepo),
    new AddInstalledItemManually(contractInventoryRepo),
    new UpdateInstalledItem(contractInventoryRepo),
    new RemoveInstalledItem(contractInventoryRepo),
    new RecordMaterialConsumption(taskMaterialConsumptionRepo, materialCatalogRepo, {
      stage: stageMaterialDeduction,
      scheduling: schedulingRepo,
    }),
    new ListTaskMaterialConsumptions(taskMaterialConsumptionRepo, rbacUserRepo),
    new DeleteMaterialConsumption(taskMaterialConsumptionRepo),
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      taskRead:      requirePerm('scheduling', 'read'),   // suggestions — unchanged
      taskWrite:     requirePerm('scheduling', 'write'),  // suggestions — unchanged
      contractRead:  requirePerm('inventory', 'read'),    // ← was 'clients','read'
      contractWrite: requirePerm('inventory', 'write'),   // ← was 'clients','write'
      materialWrite: requirePerm('inventory', 'write'),   // material consumption mutations
      manage:        requirePerm('inventory', 'manage'),  // admin — correct confirmed device type
    },
    deviceTypeCatalogService,
    new CreateManualSuggestion(inventorySuggestionRepo, schedulingRepo, contractInventoryRepo, deviceTypeCatalogService),
  ));

  // Inventory depot read surface (EPIC #38 W3) + closure-detected returns (W4).
  // GET /depot (inventory.read); GET /returns/pending (inventory.read);
  // POST /returns/:id/confirm + /discard (inventory.write — the ONLY stock mutation).
  const returnSuggestionRepo = new PrismaReturnSuggestionRepository();
  const inventoryDepotLocation = new ResolveDepotLocation(stockLocationRepo);

  // #39 — manual equipment retirement
  const retireContractEquipment = new RetireContractEquipment(
    schedulingRepo,
    contractInventoryRepo,
    inventoryAssetRepo,
    inventoryMovementRepo,
    inventoryDepotLocation,
    inventoryUow,
  );

  // EPIC #38 W5b — vehicle stock repos + use cases (wired before createInventoryRouter call)
  const vehicleRepo = new PrismaVehicleRepository();
  const resolveVehicleLocation = new ResolveVehicleLocation(stockLocationRepo);
  const getVehicleStock = new GetVehicleStock(vehicleRepo, stockLocationRepo, inventoryAssetRepo, materialStockRepo, deviceTypeCatalogRepo, materialCatalogRepo);
  const issueStockToVehicle = new IssueStockToVehicle(vehicleRepo, inventoryDepotLocation, resolveVehicleLocation, inventoryAssetRepo, inventoryUow);

  app.use('/api/inventory', createInventoryRouter(
    new GetDepotStock(stockLocationRepo, inventoryAssetRepo, materialStockRepo, deviceTypeCatalogRepo, materialCatalogRepo),
    new ListPendingReturns(returnSuggestionRepo),
    new ConfirmAssetReturn(
      returnSuggestionRepo, inventoryAssetRepo, inventoryMovementRepo, stockLocationRepo,
      deviceTypeCatalogRepo, inventoryDepotLocation, inventoryUow,
    ),
    // EPIC #38 W5a — technician stock: GET /technicians/:id/stock (read) +
    // POST /technicians/:id/issue (write). "Issue" = TRANSFER movement, NOT the ISSUE type.
    new GetTechnicianStock(stockLocationRepo, inventoryAssetRepo, materialStockRepo, deviceTypeCatalogRepo, materialCatalogRepo),
    new IssueStockToTechnician(
      inventoryDepotLocation,
      new ResolveTechnicianLocation(stockLocationRepo),
      inventoryAssetRepo,
      inventoryUow,
    ),
    createAuthMiddleware(authAdapter, sessionRepo),
    requirePerm('inventory', 'read'),
    requirePerm('inventory', 'write'),
    // EPIC #38 W6 — material deduction routes. FIX 6: enriched with material/user/task data.
    new ListPendingDeductions(materialDeductionSuggestionRepo, materialCatalogRepo, rbacUserRepo, schedulingRepo),
    new ConfirmMaterialDeduction(
      materialDeductionSuggestionRepo,
      taskMaterialConsumptionRepo,
      inventoryMovementRepo,
      materialStockRepo,
      stockLocationRepo,
      inventoryDepotLocation,
      inventoryUow,
    ),
    // EPIC #38 W5b — vehicle stock routes (appended at END per W6 ordering rule)
    getVehicleStock,
    issueStockToVehicle,
    // Wave 7 (Capstone) — dashboard read routes (appended LAST)
    new GetInventoryOverview(stockLocationRepo),
    new ListInventoryMovements(inventoryMovementRepo, materialCatalogRepo, stockLocationRepo, rbacUserRepo, schedulingRepo),
    new GetLowStockAlerts(materialCatalogRepo),
    // EPIC #38 follow-up — depot stock entry
    new AddAssetToDepot(inventoryAssetRepo, inventoryMovementRepo, deviceTypeCatalogRepo, inventoryDepotLocation, inventoryUow),
    new AddMaterialToDepot(inventoryMovementRepo, materialCatalogRepo, materialStockRepo, inventoryDepotLocation),
    // FIX B — technician list: GET /technicians (inventory.read)
    new ListTechniciansWithStock(rbacUserRepo, stockLocationRepo),
    // FIX C — return suggestions by task: GET /returns/by-task/:taskId (inventory.read)
    new ListReturnSuggestionsByTask(returnSuggestionRepo),
  ));

  // EPIC #38 W5b — vehicle catalog CRUD surface. Mounted at /api/vehicles (fresh prefix).
  app.use('/api/vehicles', createVehicleRouter(
    new ListVehicles(vehicleRepo),
    new GetVehicle(vehicleRepo),
    new CreateVehicle(vehicleRepo),
    new UpdateVehicle(vehicleRepo),
    new DeleteVehicle(vehicleRepo),
    createAuthMiddleware(authAdapter, sessionRepo),
    requirePerm('inventory', 'read'),
    requirePerm('inventory', 'manage'),
  ));

  // F6 — AI installation audit read surface (before the scheduling /:id catch-all).
  app.use('/api', createTaskAuditFindingsRouter(
    new ListTaskAuditFindings(new PrismaTaskAuditRepository()),
    createAuthMiddleware(authAdapter, sessionRepo),
    requirePerm('scheduling', 'read'),
  ));

  // Instantiate checklist use cases (change 5)
  const taskTemplateRepoForChecklist = new PrismaTaskTemplateRepository();
  const replaceTemplateItemsUC = new ReplaceTaskTemplateItems(taskTemplateRepoForChecklist);
  const addChecklistItemUC = new AddChecklistItem(schedulingRepo, taskActivityRecorder);
  const toggleChecklistItemUC = new ToggleChecklistItem(schedulingRepo, taskActivityRecorder);
  const updateChecklistItemUC = new UpdateChecklistItem(schedulingRepo, taskActivityRecorder);
  const removeChecklistItemUC = new RemoveChecklistItem(schedulingRepo, taskActivityRecorder);
  const reorderChecklistItemsUC = new ReorderChecklistItems(schedulingRepo, taskActivityRecorder);
  const assignTemplateToTaskUC = new AssignTemplateToTask(schedulingRepo, taskTemplateRepoForChecklist, taskActivityRecorder);
  const clearTaskChecklistUC = new ClearTaskChecklist(schedulingRepo, taskActivityRecorder);

  // IClass manual resend use cases
  const listIClassNodes = new ListIClassNodes(buildIClassClient());
  const resendTaskToIClassWithNode = new ResendTaskToIClassWithNode(
    schedulingRepo,
    featureFlagRepo,
    buildIClassClient(),
    iclassDispatchAttemptRepo,
    stageRepo,
  );

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, authAdapter, stageRepo, {
    addChecklistItem: addChecklistItemUC,
    toggleChecklistItem: toggleChecklistItemUC,
    updateChecklistItem: updateChecklistItemUC,
    removeChecklistItem: removeChecklistItemUC,
    reorderChecklistItems: reorderChecklistItemsUC,
    assignTemplateToTask: assignTemplateToTaskUC,
    clearTaskChecklist: clearTaskChecklistUC,
  }, setTaskInventoryReview, bulkMoveTasksToStage, {
    listIClassNodes,
    resendTaskToIClassWithNode,
    requirePerm,
  }, getTaskActivity, requirePerm('inventory', 'write'), retireContractEquipment, setTaskGeneralStatus, requirePerm('scheduling', 'write')));
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

  // IClass node catalog (nodes-city-mapper #45) — nodes ARE the cities.
  const iclassNodeRepo = new PrismaIClassNodeRepository();
  const syncIClassNodes = new SyncIClassNodes(buildIClassClient(), iclassNodeRepo);
  const listIClassNodeCatalog = new ListIClassNodeCatalog(iclassNodeRepo);
  const assignIClassNodeToNetworkSite = new AssignIClassNodeToNetworkSite(networkSiteRepo, iclassNodeRepo);

  app.use('/api/projects', createProjectsRouter(listProjectsUC, getProjectUC, createProjectUC, updateProjectUC, deleteProjectUC, authAdapter, assignIClassSoType, requirePerm('inventory', 'manage'), requirePerm('scheduling', 'manage')));
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
  app.use('/api/admins', createAdminRouter(listAdmins, getAdmin, createAdmin, updateAdmin, deleteAdmin, get2FAStatus, enable2FA, disable2FA));
  app.use('/api', createEmpresaRouter(
    listServicePlans, getServicePlan, createServicePlan, updateServicePlan, deleteServicePlan,
    listNetworkDevices, getNetworkDevice, createNetworkDevice, updateNetworkDevice, deleteNetworkDevice,
  ));
  app.use('/api', createIpNetworkRouter(
    listIpNetworks, createIpNetwork, deleteIpNetwork,
    listIpPools, createIpPool, listIpAssignments,
    deleteIpPool, listIpv6Networks, createIpv6Network,
  ));
  // FIX-5: /api/network-sites was unauthenticated — all CRUD was open including the
  // uispSiteId connector field. Adding createAuthMiddleware (auth-only, no granular guard yet —
  // that is the known deferred permission pass).
  app.use('/api/network-sites', createAuthMiddleware(authAdapter, sessionRepo), createNetworkSiteRouter(
    listNetworkSites, getNetworkSite, createNetworkSite, updateNetworkSite, deleteNetworkSite,
    listNetworkSitesWithUisp, assignIClassNodeToNetworkSite,
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
  app.use('/api/admin/iclass', createIClassAdminRouter(syncIClassSoTypes, listIClassSoTypes, authAdapter, syncIClassNodes, listIClassNodeCatalog));

  // IClass closure loop — result-code catalog + configurable result→stage mapping + status + backfill.
  const iclassResultCodeRepo = new PrismaIClassResultCodeRepository();
  const closedServiceOrderRepo = new PrismaClosedServiceOrderRepository();
  const closureIngest = new IngestClosedServiceOrders(
    buildIClassClient(),
    closedServiceOrderRepo,
    iclassResultCodeRepo,
    schedulingRepo,
    new PrismaSyncStateRepository(),
    // #41 — pass the activity recorder so a closure into a `hecho` stage emits the
    // System `status_changed` alongside generalStatus='closed' (REQ-GS-ICLASS-CLOSEDBY-FLOW-1).
    { ...buildClosureSideEffects(), recorder: taskActivityRecorder },
  );
  // GetPendingSideEffectsCount — usa el mismo closedServiceOrderRepo construido arriba.
  const getPendingSideEffectsCount = new GetPendingSideEffectsCount(closedServiceOrderRepo);
  const getPendingSideEffectsList = new GetPendingSideEffectsList(closedServiceOrderRepo);

  // #35 Part 2 — reconcile page: list in-flight tasks + per-task sync reconcile.
  // Reusa closureIngest (mismo processSummary que el poll) dentro de un backfill;
  // ReconcileTaskClosure delega en backfill.reconcileOne con la misma ventana.
  const reconcileBackfill = new BackfillClosedServiceOrders(buildIClassClient(), schedulingRepo, closureIngest);
  const listInFlightTasks = new ListInFlightTasks(schedulingRepo);
  const reconcileTaskClosure = new ReconcileTaskClosure(schedulingRepo, reconcileBackfill);

  const iclassClosureConfigRepo = new PrismaIClassClosureConfigRepository();
  app.use('/api/admin/iclass', createIClassClosureRouter(
    new SyncIClassResultCodes(buildIClassClient(), iclassResultCodeRepo),
    new ListIClassResultCodes(iclassResultCodeRepo),
    new AssignResultCodeStage(iclassResultCodeRepo, stageRepo),
    new GetClosureStatus(new PrismaSyncStateRepository()),
    backfillScheduler ?? null,
    taskAutocomplete ?? null,
    getPendingSideEffectsCount,
    getPendingSideEffectsList,
    new GetIClassClosureConfig(iclassClosureConfigRepo),
    new UpdateIClassClosureConfig(iclassClosureConfigRepo),
    listInFlightTasks,
    reconcileTaskClosure,
    requirePerm('iclass', 'manage'),
    authAdapter,
  ));

  // Feature flags — runtime toggles persisted in DB.
  // GETs remain auth-only (reading flag state is harmless).
  // PATCH is guarded by admin.flags — only super_admin (*) can flip flags until
  // the operator assigns this permission to a role via the roles UI.
  // featureFlagRepo is created earlier (wired into SendTaskToIClass).
  app.use('/api/admin/feature-flags', createFeatureFlagsRouter(
    authAdapter,
    new ListFeatureFlags(featureFlagRepo),
    new GetFeatureFlag(featureFlagRepo),
    new SetFeatureFlag(featureFlagRepo),
    requirePerm('admin', 'flags'),
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

  const authMiddlewareForRbac = createAuthMiddleware(authAdapter, sessionRepo);

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

  // SDD #5 — session management endpoints (+ sessions-history: history endpoint)
  app.use(
    '/api/admin/sessions',
    authMiddlewareForRbac,
    createSessionsRouter(
      new ListActiveSessions(sessionRepo),
      new RevokeSession(sessionRepo),
      new RevokeAllSessionsForUser(sessionRepo),
      new ListSessionHistory(sessionRepo),
      requirePerm('admin', 'view_sessions'),
      requirePerm('admin', 'revoke_sessions'),
    ),
  );

  // Profile routes (uses internal router directly)
  const profileRouter = Router();
  profileRoutes(profileRouter);
  app.use('/api', profileRouter);

  // UISP mirror read + sync routes (/api/uisp)
  // uispSiteRepoForNs was already created above (for UpdateNetworkSite eager wiring).
  // We reuse it here for the UISP read routes — same Prisma repo instance, no double-init.
  const uispSiteRepo   = uispSiteRepoForNs;
  const uispDeviceRepo = new PrismaUispDeviceRepository();
  const uispSyncState  = new PrismaSyncStateRepository();
  const uispConfigured = !!(config.uisp.baseUrl && config.uisp.token);
  const listUispSitesUC    = new ListUispSites(uispSiteRepo);
  // GetUispSiteDetail gets networkSiteRepo for reverse lookup (linkedNetworkSite)
  const getUispSiteDetailUC = new GetUispSiteDetail(uispSiteRepo, uispDeviceRepo, networkSiteRepo);
  const getUispSyncStatusUC = new GetUispSyncStatus(uispSyncState, featureFlagRepo, uispConfigured);
  const triggerUispSyncUC   = new TriggerUispSync(uispSyncScheduler ?? { triggerNow: async () => ({ queued: false, reason: 'flag-disabled' as const }) } as unknown as UispSyncScheduler);
  app.use('/api/uisp', createAuthMiddleware(authAdapter, sessionRepo), createUispRouter(
    listUispSitesUC,
    getUispSiteDetailUC,
    getUispSyncStatusUC,
    triggerUispSyncUC,
    requirePerm('uisp', 'read'),
    requirePerm('uisp', 'manage'),
  ));

  // Gigared TV integration (#47) — /api/gigared. apiKey read per-request from DB (flag-gated).
  // Reuses featureFlagRepo (762), serviceCatalogRepo + contractServiceRepo + contractLookup (#43, ~1068).
  const gigaredConfigRepo = new PrismaGigaredConfigRepository();
  const gigaredClient = new GigaredClient({ configProvider: gigaredConfigRepo });
  const gigaredCustomerLookup = { findById: (id: string) => prismaClientLookup('Client', id) };
  // #47k — ownership-aware contract lookup ({ id, clientId }) so the TV use cases reject a
  // contractId that belongs to another customer (404, no cross-customer write).
  const gigaredContractLookup = { findById: (id: string) => prismaContractOwnershipLookup(id) };
  // #72 — local TV-cancel flag repo (Client.tvCancelledAt). GR sync never touches it.
  const gigaredTvCancellation = new PrismaClientTvCancellationRepository();
  // #81 — TV reactivation seq repo (Client.tvActivationSeq). RegisterGigaredAccount lo incrementa
  // SOLO en re-alta para mintear un internal_id + mail frescos (nunca quemados). Mirror-only.
  const gigaredTvActivation = new PrismaClientTvActivationRepository();
  app.use('/api/gigared', createAuthMiddleware(authAdapter, sessionRepo), createGigaredRouter({
    getConfig:          new GetGigaredConfig(gigaredConfigRepo, featureFlagRepo),
    updateConfig:       new UpdateGigaredConfig(gigaredConfigRepo, featureFlagRepo),
    getSummary:         new GetGigaredSummary(gigaredClient),
    listAccounts:       new ListGigaredAccounts(gigaredClient),
    getCustomerAccount: new GetGigaredCustomerAccount(gigaredClient, gigaredCustomerLookup, gigaredTvCancellation),
    linkCustomerToCic:  new LinkCustomerToCic(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation),
    registerAccount:    new RegisterGigaredAccount(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation, gigaredTvActivation),
    addTvService:       new AddTvService(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup),
    removeTvService:    new RemoveTvService(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup),
    setOttStatus:       new SetOttStatus(gigaredClient, gigaredCustomerLookup),
    cancelTv:           new CancelTv(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup, gigaredTvCancellation),
    changeTvPassword:   new ChangeTvPassword(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo),
    // #65 fix wave H3 — superficie dedicada para las credenciales (guard tv.register).
    getTvCredentials:   new GetTvCredentials(gigaredCustomerLookup, new PrismaTvCredentialsReader()),
    requireRead:        requirePerm('tv', 'read'),
    // #50 — granular TV permissions (replace generic tv.write).
    requireLink:        requirePerm('tv', 'link'),
    requireRegister:    requirePerm('tv', 'register'),
    requirePacks:       requirePerm('tv', 'packs'),
    requireOtt:         requirePerm('tv', 'ott'),
    requireCancel:      requirePerm('tv', 'cancel'),
    requireManage:      requirePerm('tv', 'manage'),
    gigaredReady:       createGigaredReadyMiddleware(gigaredConfigRepo, featureFlagRepo),
    gigaredProbeReady:  createGigaredReadyMiddleware(gigaredConfigRepo, featureFlagRepo, { requireFlag: false }),
  }));

  // 404
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Global error handler (shared with route tests — single source of truth).
  app.use(errorHandler);

  return app;
}
