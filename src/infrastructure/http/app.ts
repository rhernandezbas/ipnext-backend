import express, { Router, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import {
  createLoginRateLimiter,
  createMessagingSendRateLimiter,
  createExternalWriteRateLimiter,
  createPortalLoginRateLimiter,
  createPortalLoginIpRateLimiter,
  createPortalGeneralRateLimiter,
  createPortalTicketCreateRateLimiter,
  createPortalTicketMessageSendRateLimiter,
} from './middleware/rateLimiters';
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
import { UpdateClientLocation } from '@application/use-cases/UpdateClientLocation';
import { UpdateContractLocation } from '@application/use-cases/UpdateContractLocation';
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
// task-photos — adjuntos (fotos) de tarea
import { createTaskAttachmentsRouter } from './routes/taskAttachments.routes';
import { AttachPhotosToTask } from '@application/use-cases/AttachPhotosToTask';
import { ListTaskAttachments } from '@application/use-cases/ListTaskAttachments';
import { GetTaskAttachmentFile } from '@application/use-cases/GetTaskAttachmentFile';
import { DeleteTaskAttachment } from '@application/use-cases/DeleteTaskAttachment';
import { PrismaTaskAttachmentRepository } from '../adapters/prisma/PrismaTaskAttachmentRepository';
import { MinioFileStorage } from '../adapters/minio/MinioFileStorage';
import { JimpImageProcessor } from '../adapters/image/JimpImageProcessor';
import { createTaskCommentsRouter } from './routes/taskComments.routes';
import { createTicketCommentsRouter } from './routes/ticketComments.routes';
import { ListTicketComments } from '@application/use-cases/ListTicketComments';
import { AddTicketComment } from '@application/use-cases/AddTicketComment';
// portal-ticket-messaging (v2.B) — mensajería (respuesta PÚBLICA del staff), lado admin.
import { createTicketMessagesRouter } from './routes/ticketMessages.routes';
import { SendStaffTicketReply } from '@application/use-cases/SendStaffTicketReply';
import { GetTicketUnreadCount } from '@application/use-cases/GetTicketUnreadCount';
import { GetTicketMessageAttachmentFile } from '@application/use-cases/GetTicketMessageAttachmentFile';
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
import { ArchiveTask } from '@application/use-cases/ArchiveTask';
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
import { PrismaContractServiceEventRepository } from '../adapters/prisma/PrismaContractServiceEventRepository';
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
// internal-news — tablón interno del equipo (BE Batch 5 wiring)
import { PrismaNewsPostRepository } from '../adapters/prisma/PrismaNewsPostRepository';
import { PrismaNewsCategoryRepository } from '../adapters/prisma/PrismaNewsCategoryRepository';
import { createNewsRouter } from './routes/news.routes';
// N2 — media (adjuntos) + difundir al NOC de las Noticias.
import { PrismaNewsPostAttachmentRepository } from '../adapters/prisma/PrismaNewsPostAttachmentRepository';
import { createNewsMediaRouter } from './routes/newsMedia.routes';
import { AttachFilesToNews } from '@application/use-cases/AttachFilesToNews';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { GetNewsAttachmentFile } from '@application/use-cases/GetNewsAttachmentFile';
import { DeleteNewsAttachment } from '@application/use-cases/DeleteNewsAttachment';
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
// BroadcastToNoc (el motor N1) se importa una sola vez en el cluster nocBroadcast (N1/N3) más abajo;
// N2 lo reutiliza desde ahí (mismo símbolo, file-scoped) para BroadcastNewsToNoc.
import { ListNewsPosts } from '@application/use-cases/ListNewsPosts';
import { GetNewsPost } from '@application/use-cases/GetNewsPost';
import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { CreateExternalNews } from '@application/use-cases/CreateExternalNews';
import { UpdateNewsPost } from '@application/use-cases/UpdateNewsPost';
import { ArchiveNewsPost } from '@application/use-cases/ArchiveNewsPost';
import { MarkNewsRead } from '@application/use-cases/MarkNewsRead';
import { GetNewsUnreadCount } from '@application/use-cases/GetNewsUnreadCount';
import { ListNewsCategories } from '@application/use-cases/ListNewsCategories';
import { CreateNewsCategory } from '@application/use-cases/CreateNewsCategory';
import { UpdateNewsCategory } from '@application/use-cases/UpdateNewsCategory';
import { DeleteNewsCategory } from '@application/use-cases/DeleteNewsCategory';
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
import { createNasRouter } from './routes/nas.routes';
import { PrismaNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
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
// contract-node-ap-auto-assign (Fase B) — picker manual del nodo/AP de un contrato
import { createAccessPointsRouter } from './routes/accessPoints.routes';
import { PrismaAccessPointRepository } from '../adapters/prisma/PrismaAccessPointRepository';
import { ListAssignableAccessPoints } from '@application/use-cases/ListAssignableAccessPoints';
import { SetContractNetworkAssignment } from '@application/use-cases/SetContractNetworkAssignment';
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
import { TransferTvToCustomer } from '@application/use-cases/gigared/TransferTvToCustomer';
import { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import { PrismaTvCredentialsReader } from '../adapters/prisma/PrismaTvCredentialsReader';
import { PrismaClientTvCancellationRepository } from '../adapters/prisma/PrismaClientTvCancellationRepository';
import { PrismaTvCicReuseEligibilityRepository } from '../adapters/prisma/PrismaTvCicReuseEligibilityRepository';
import { PrismaClientTvActivationRepository } from '../adapters/prisma/PrismaClientTvActivationRepository';
import { PrismaClientTvCancelStatusRepository } from '../adapters/prisma/PrismaClientTvCancelStatusRepository';
import { CancelTvJobRunner } from '../scheduling/CancelTvJobRunner';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import { PrismaTvActivationEventRepository } from '../adapters/prisma/PrismaTvActivationEventRepository';
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
import { OrchestratorRadiusSessionRepository } from '../adapters/orchestrator/OrchestratorRadiusSessionRepository';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
// === RADIUS accounting / network audit ===
import { PrismaRadiusEventRepository } from '../adapters/prisma/PrismaRadiusEventRepository';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { PrismaRadiusAuthEventRepository } from '../adapters/prisma/PrismaRadiusAuthEventRepository';
import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';
import { PrismaRadiusSessionCureEventRepository } from '../adapters/prisma/PrismaRadiusSessionCureEventRepository';
import { ListRadiusSessionCures } from '@application/use-cases/ListRadiusSessionCures';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';
import { createLeadsRouter } from './routes/leads.routes';
import { PrismaLeadRepository } from '../adapters/prisma/PrismaLeadRepository';
// #80 — Recaptación
import { createRecaptureRouter } from './routes/recapture.routes';
// actions-worklist (W2) — worklist de titularidad + bajas recientes
import { createActionsRouter } from './routes/actions.routes';
import { ListOwnershipCases } from '@application/use-cases/actions/ListOwnershipCases';
import { UpdateOwnershipCase } from '@application/use-cases/actions/UpdateOwnershipCase';
import { ListRecentBajas } from '@application/use-cases/actions/ListRecentBajas';
import { PrismaOwnershipCaseRepository } from '../adapters/prisma/PrismaOwnershipCaseRepository';
import { PrismaContractPairingReader } from '../adapters/prisma/PrismaContractPairingReader';
import { PrismaRetirementOrderReader } from '../adapters/prisma/PrismaRetirementOrderReader';
import { PrismaRecaptureRepository } from '../adapters/prisma/PrismaRecaptureRepository';
import { ListRecaptureLeads } from '@application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '@application/use-cases/recapture/GetRecaptureLead';
import { AssignRecaptureLeadsBulk } from '@application/use-cases/recapture/AssignRecaptureLeadsBulk';
import { UpdateRecaptureLeadStatus } from '@application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '@application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '@application/use-cases/recapture/IngestChurnedClients';
import { ImportCsvLeads } from '@application/use-cases/recapture/ImportCsvLeads';
import { AssignRecaptureLead } from '@application/use-cases/recapture/AssignRecaptureLead';
import { createPortfolioRouter } from './routes/portfolio.routes';
import { PrismaPortfolioReadRepository } from '../adapters/prisma/PrismaPortfolioReadRepository';
import { GetMyPortfolio } from '@application/use-cases/portfolio/GetMyPortfolio';
import { GetPortfolioByVendedor } from '@application/use-cases/portfolio/GetPortfolioByVendedor';
import { GetAllPortfolios } from '@application/use-cases/portfolio/GetAllPortfolios';
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
import { createIClassStatusesRouter } from './routes/iclassStatuses.routes';
import { PrismaIClassStatusCatalogRepository } from '../adapters/prisma/PrismaIClassStatusCatalogRepository';
import { SyncIClassStatuses } from '@application/use-cases/SyncIClassStatuses';
import { ListIClassStatusCatalog } from '@application/use-cases/ListIClassStatusCatalog';
import { UpdateIClassStatusCatalog } from '@application/use-cases/UpdateIClassStatusCatalog';
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
// iclass-os-actions (Ola A + B)
import { CloseIClassServiceOrder } from '@application/use-cases/CloseIClassServiceOrder';
import { AssignIClassTeam } from '@application/use-cases/AssignIClassTeam';
import { SyncIClassTeams } from '@application/use-cases/SyncIClassTeams';
import { ListIClassTeams } from '@application/use-cases/ListIClassTeams';
import { PrismaIClassTeamRepository } from '../adapters/prisma/PrismaIClassTeamRepository';
import { createIClassTeamsRouter } from './routes/iclassTeams.routes';
// iclass-gps-audit — ubicación de cuadrillas + auditoría de presencia en sitio
import { createTechnicianLocationRouter } from './routes/technicianLocation.routes';
import { buildTeamLocationSource } from './iclass.factory';
import { PrismaTeamLocationRepository } from '../adapters/prisma/PrismaTeamLocationRepository';
import { GetTeamsLiveStatus } from '@application/use-cases/GetTeamsLiveStatus';
import { GetTeamDailyJourney } from '@application/use-cases/GetTeamDailyJourney';
import { AuditServiceOrderPresence } from '@application/use-cases/AuditServiceOrderPresence';
import { ListSuspiciousClosures } from '@application/use-cases/ListSuspiciousClosures';
// iclass-ops-config (Ola A: mapeo técnico↔cuadrilla + auto-asignar; Ola C: dispatch preview)
import { SetTechnicianTeamMapping } from '@application/use-cases/SetTechnicianTeamMapping';
import { ListTechnicianTeamMappings } from '@application/use-cases/ListTechnicianTeamMappings';
import { AutoAssignIClassTeamOnTaskUpdate } from '@application/use-cases/AutoAssignIClassTeamOnTaskUpdate';
import { GetIClassDispatchPreview } from '@application/use-cases/GetIClassDispatchPreview';
import { createIClassTechnicianTeamsRouter } from './routes/iclassTechnicianTeams.routes';
import { createIClassDispatchPreviewRouter } from './routes/iclassDispatchPreview.routes';
// Mis clientes (Fase 2b) — agente↔vendedor (GR) mapping, isolated from the core user model.
import { SetVendedorMapping } from '@application/use-cases/SetVendedorMapping';
import { ListVendedorMappings } from '@application/use-cases/ListVendedorMappings';
import { ListDistinctVendedores } from '@application/use-cases/ListDistinctVendedores';
import { createGrVendedorMappingsRouter } from './routes/grVendedorMappings.routes';
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
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { RouteAssetToDisposition } from '@application/services/RouteAssetToDisposition';
import { RetireInstalledItem } from '@application/use-cases/RetireInstalledItem';
import { CreateManualSuggestion } from '@application/use-cases/CreateManualSuggestion';
import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { ListClientEquipment } from '@application/use-cases/ListClientEquipment';
import { AddContractEquipment } from '@application/use-cases/AddContractEquipment';
// service-transfer (W3): transferencia de equipos entre contratos (lote atómico + ledger TRANSFER).
import { TransferContractEquipment } from '@application/use-cases/TransferContractEquipment';
import { InstallContractAsset } from '@application/services/InstallContractAsset';
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
import { UnlockRbacUser } from '@application/use-cases/rbac/UnlockRbacUser';
import { ListRolesForUser } from '@application/use-cases/rbac/ListRolesForUser';
import { SetRolesForUser } from '@application/use-cases/rbac/SetRolesForUser';
import { AssignRoleToUser } from '@application/use-cases/rbac/AssignRoleToUser';
import { RemoveRoleFromUser } from '@application/use-cases/rbac/RemoveRoleFromUser';
import { createRbacUserRouter } from './routes/rbacUser.routes';
import { toRbacRoleDto } from '@application/dto/rbacUser.dto';
// PPPoE management (#pppoe-service Fase B)
import { createPppoeRouter } from './routes/pppoe.routes';
import { PrismaPppoeServiceRepository } from '../adapters/prisma/PrismaPppoeServiceRepository';
import { RouterOsGateway } from '../adapters/routeros/RouterOsGateway';
import { RouterOsEnforcementAdapter } from '../adapters/routeros/RouterOsEnforcementAdapter';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { OrchestratorEnforcementAdapter } from '../adapters/orchestrator/OrchestratorEnforcementAdapter';
import { PerNasEnforcementGateway } from '../adapters/enforcement/PerNasEnforcementGateway';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
// pppoe-move-nas W1: move radius-aware (subsume al legacy) + registro visible de movimientos.
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { ListPppoeNasMoveEvents } from '@application/use-cases/ListPppoeNasMoveEvents';
import { PrismaPppoeNasMoveEventRepository } from '../adapters/prisma/PrismaPppoeNasMoveEventRepository';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
// service-transfer (W2): transferencia de PPPoE entre contratos (as-is | recreate).
import { TransferPppoe } from '@application/use-cases/TransferPppoe';
import { GetPppoeCallerId } from '@application/use-cases/GetPppoeCallerId';
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
// pppoe-bulk-select-filter (v2): hermano liviano de ListAllPppoeServices — { ids, total } del filtro.
import { ListAllPppoeServiceIds } from '@application/use-cases/ListAllPppoeServiceIds';
import { ListInternetServiceHistory } from '@application/use-cases/ListInternetServiceHistory';
import { ListInternetActivationOperators } from '@application/use-cases/ListInternetActivationOperators';
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
// pppoe-search-bulk-plan: bulk plan change use case + shared service
import { BulkChangePppoePlan } from '@application/use-cases/BulkChangePppoePlan';
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';
import { RecordPppoeEnforceEvent } from '@application/use-cases/RecordPppoeEnforceEvent';
// add-by-pppoe — inspección SSH de antena airOS para detección de equipos del contrato
import { InspectPppoeDevices } from '@application/use-cases/InspectPppoeDevices';
// smartolt-provision (K2) — aprovisionamiento automático de ONUs fibra Huawei vía SmartOLT
import { createFiberRouter } from './routes/fiber.routes';
import { SmartOltHttpGateway } from '../adapters/smartolt/SmartOltHttpGateway';
import { PrismaSmartOltOltConfigRepository } from '../adapters/prisma/PrismaSmartOltOltConfigRepository';
import {
  ProvisionFiberOnu,
  FiberContractSnapshot,
  FiberInstallTaskWriter,
} from '@application/use-cases/ProvisionFiberOnu';
import { ListUnconfiguredOnus } from '@application/use-cases/ListUnconfiguredOnus';
import { ListSmartOltOlts } from '@application/use-cases/ListSmartOltOlts';
import { UpdateSmartOltOlt } from '@application/use-cases/UpdateSmartOltOlt';
import { PregenInstallPppoe } from '@application/use-cases/PregenInstallPppoe';
import { Ssh2AirOsGateway } from '../adapters/airos/Ssh2AirOsGateway';
import { createInspectPppoeDevicesRouter } from './routes/inspectPppoeDevices.routes';
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { ServiceCutRunner } from '../scheduling/ServiceCutRunner';
import { PrismaServiceCutBatchRepository } from '../adapters/prisma/PrismaServiceCutBatchRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
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
// Plan catalog (plan-catalog)
import { createPlanRouter } from './routes/plan.routes';
import { PrismaPlanRepository } from '../adapters/prisma/PrismaPlanRepository';
import { ListPlans } from '@application/use-cases/ListPlans';
import { CreatePlan } from '@application/use-cases/CreatePlan';
import { UpdatePlan } from '@application/use-cases/UpdatePlan';
import { DeletePlan } from '@application/use-cases/DeletePlan';
// ── Zonas visuales (customer-zones-map) ──────────────────────────────────────
import { createZonesRouter } from './routes/zones.routes';
// ── External API v1 — API-key auth, read-only, machine-to-machine ────────────
import { createExternalV1Router } from './routes/externalV1.routes';
import { createApiKeyMiddleware } from './middleware/apiKeyMiddleware';
// ── NOC Alerts Hub (noc-alerts-hub, Fase A) — wiring vive en composeAlertsModule ─
import { composeAlertsModule } from './composeAlertsModule';
// ── ai-assistant-multiagent — config del asistente IA; wiring en composeAssistantModule ─
import { composeAssistantModule } from './composeAssistantModule';
// ── ai-assistant-multiagent — MOTOR del asistente; wiring en composeAssistantEngine ─────
import { composeAssistantEngine } from './composeAssistantEngine';
import { ChatMessageThreadReader } from '@infrastructure/adapters/assistant/ChatMessageThreadReader';
import { CustomerAssistantClientResolver } from '@infrastructure/adapters/assistant/CustomerAssistantClientResolver';
import { PrismaZoneRepository } from '../adapters/prisma/PrismaZoneRepository';
import { ListZones } from '@application/use-cases/ListZones';
import { CreateZone } from '@application/use-cases/CreateZone';
import { GetZone } from '@application/use-cases/GetZone';
import { UpdateZone } from '@application/use-cases/UpdateZone';
import { DeleteZone } from '@application/use-cases/DeleteZone';
// ── messaging-inbox (F1) — Chatwoot webhook ingest + inbox reads/send (RBAC-1/2/4) ─
import { createMessagingRouter } from './routes/messaging.routes';
import { createChatwootSignatureMiddleware, rawBodyJsonParser } from './middleware/chatwootSignatureMiddleware';
import { HttpChatwootGateway } from '../adapters/chatwoot/HttpChatwootGateway';
import { PrismaConversationRepository } from '../adapters/prisma/PrismaConversationRepository';
import { PrismaChatMessageRepository } from '../adapters/prisma/PrismaChatMessageRepository';
import { PrismaWebhookDeliveryRepository } from '../adapters/prisma/PrismaWebhookDeliveryRepository';
// messaging-inbox-v2-media (F1.5 fase A, Tanda 1) — recibir media entrante
import { PrismaChatMessageAttachmentRepository } from '../adapters/prisma/PrismaChatMessageAttachmentRepository';
import { FireAndForgetChatMediaDownloadTrigger } from '../adapters/chatwoot/FireAndForgetChatMediaDownloadTrigger';
import { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';
import { GetChatAttachmentFile } from '@application/use-cases/messaging/GetChatAttachmentFile';
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { GetConversation } from '@application/use-cases/messaging/GetConversation';
// Aliased: `ListMessages` already names an unrelated notifications-inbox use case above (:318).
import { ListMessages as ListChatMessages } from '@application/use-cases/messaging/ListMessages';
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
// messaging-inbox-notes (edit/delete) — editar/soft-delete una nota interna.
import { EditInternalNote } from '@application/use-cases/messaging/EditInternalNote';
import { DeleteInternalNote } from '@application/use-cases/messaging/DeleteInternalNote';
import { attachMessagingManage } from './middleware/attachMessagingManage';
import { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
// conversation-snooze (Ola 6c) — posponer una conversación hasta un timestamp futuro.
import { SnoozeConversation } from '@application/use-cases/messaging/SnoozeConversation';
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';
// F1.5-C2 (asignación) — LOCAL-only (Chatwoot nunca se entera de assigneeId/areaId)
import { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
// conversation-labels (Ola 5) — catálogo de etiquetas + asignación N:M por conversación.
import { createMessagingLabelsRouter } from './routes/messagingLabels.routes';
import { PrismaConversationLabelRepository } from '../adapters/prisma/PrismaConversationLabelRepository';
import { ListLabels } from '@application/use-cases/messaging/ListLabels';
import { CreateLabel } from '@application/use-cases/messaging/CreateLabel';
import { UpdateLabel } from '@application/use-cases/messaging/UpdateLabel';
import { DeleteLabel } from '@application/use-cases/messaging/DeleteLabel';
import { SetConversationLabels } from '@application/use-cases/messaging/SetConversationLabels';
import { ListAssignableUsers } from '@application/use-cases/messaging/ListAssignableUsers';
// inbox-template-send (HTTP-1/HTTP-2) — enviar template aprobado desde el hilo.
import { SendTemplateMessage } from '@application/use-cases/messaging/SendTemplateMessage';
// inbox-views (Ola 1) — contadores por vista del inbox (badges de la sidebar).
import { GetInboxViewCounts } from '@application/use-cases/messaging/GetInboxViewCounts';
// previous-conversations (Ola 6a) — lista de conversaciones previas del contacto (panel de contexto).
import { ListPreviousConversations } from '@application/use-cases/messaging/ListPreviousConversations';
// note-mentions (Ola 6b) — @menciones en notas internas + vista "Menciones".
import { PrismaConversationMentionRepository } from '../adapters/prisma/PrismaConversationMentionRepository';
import { MarkConversationMentionsRead } from '@application/use-cases/messaging/MarkConversationMentionsRead';
// conversation-events (Ola 2) — historial de transiciones + reports de agregación (cimiento Ola 3).
import { PrismaConversationEventRepository } from '../adapters/prisma/PrismaConversationEventRepository';
import { createMessagingReportsRouter } from './routes/messagingReports.routes';
import { GetReportsOverview } from '@application/use-cases/messaging/GetReportsOverview';
import { GetTrafficReport } from '@application/use-cases/messaging/GetTrafficReport';
import { GetResolutionsReport } from '@application/use-cases/messaging/GetResolutionsReport';
// ── messaging-bulk (F2) — envío masivo por template WhatsApp (Twilio directo) ─
import { createMessagingBulkRouter } from './routes/messagingBulk.routes';
import { TwilioContentGateway } from '../adapters/twilio/TwilioContentGateway';
import { PrismaCampaignRepository } from '../adapters/prisma/PrismaCampaignRepository';
import { PrismaCampaignInboxProjector } from '../adapters/prisma/PrismaCampaignInboxProjector';
import { TokenBucketRateLimiter } from '@application/util/TokenBucketRateLimiter';
import { CampaignRunner } from '../scheduling/CampaignRunner';
// Aliased: `ListTemplates` already names an unrelated settings/email-templates use case above (:58).
import { ListTemplates as ListMessagingTemplates } from '@application/use-cases/messaging/ListTemplates';
import { PreviewCampaignSegment } from '@application/use-cases/messaging/PreviewCampaignSegment';
import { ListSegmentRecipients } from '@application/use-cases/messaging/ListSegmentRecipients';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { SendCampaign } from '@application/use-cases/messaging/SendCampaign';
import { TransitionTaskAfterSend } from '@application/use-cases/messaging/TransitionTaskAfterSend';
import { GetCampaign } from '@application/use-cases/messaging/GetCampaign';
import { ListCampaigns } from '@application/use-cases/messaging/ListCampaigns';
import { AuthorizeCampaignSend } from '@application/use-cases/messaging/AuthorizeCampaignSend';
// campaign-chatwoot-label (Batch 6, D5.d) — catálogo de labels de Chatwoot.
import { ListChatwootLabels } from '@application/use-cases/messaging/ListChatwootLabels';
import { CreateChatwootLabel } from '@application/use-cases/messaging/CreateChatwootLabel';
import { BULK_SUPER_ADMIN_SENTINEL } from '@domain/services/bulkRecipientAuthorization';
// ── Change 3 (templates CRUD) — VER/CREAR/SUBMIT/BORRAR templates WhatsApp ─────
import { createMessagingTemplatesRouter } from './routes/templates.routes';
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { DeleteTemplate } from '@application/use-cases/messaging/DeleteTemplate';
// Ola 4 (inbox-Chatwoot) — respuestas rápidas / macros (canned responses CRUD).
import { createCannedResponsesRouter } from './routes/cannedResponses.routes';
// N1 (noc-broadcast) — fundación de la difusión NOC vía Evolution API.
import { createNocBroadcastRouter } from './routes/nocBroadcast.routes';
import { PrismaNocBroadcastConfigRepository } from '../adapters/prisma/PrismaNocBroadcastConfigRepository';
import { EvolutionApiHttpGateway } from '../adapters/evolution/EvolutionApiHttpGateway';
import { GetNocBroadcastConfig } from '@application/use-cases/nocBroadcast/GetNocBroadcastConfig';
import { UpdateNocBroadcastConfig } from '@application/use-cases/nocBroadcast/UpdateNocBroadcastConfig';
import { SendNocBroadcastTest } from '@application/use-cases/nocBroadcast/SendNocBroadcastTest';
// Motor compartido: N3 (BroadcastTaskToNoc) y N2 (BroadcastNewsToNoc, wiring más arriba) lo reusan.
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { BroadcastTaskToNoc } from '@application/use-cases/nocBroadcast/BroadcastTaskToNoc';
import { ListCannedResponses } from '@application/use-cases/messaging/ListCannedResponses';
import { CreateCannedResponse } from '@application/use-cases/messaging/CreateCannedResponse';
import { UpdateCannedResponse } from '@application/use-cases/messaging/UpdateCannedResponse';
import { DeleteCannedResponse } from '@application/use-cases/messaging/DeleteCannedResponse';
import { PrismaCannedResponseRepository } from '../adapters/prisma/PrismaCannedResponseRepository';
// bulk-task-recipients (D2, D6, B6) — 5to dominio de destinatarios "Tarea":
// resolver Prisma (TaskRecipientSource) + repo Prisma del config-CRUD
// (TaskStageRecipientConfigRepository), sus use cases de config y el router
// self-contained `/api/messaging/config/task-stages`.
import { PrismaTaskRecipientSource } from '../adapters/prisma/PrismaTaskRecipientSource';
import { PrismaTaskStageRecipientConfigRepository } from '../adapters/prisma/PrismaTaskStageRecipientConfigRepository';
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';
import { createTaskStageConfigRouter } from './routes/taskStageConfig.routes';
// bulk-task-stage-transition (B1.8) — config singleton del estado resultante global.
import { PrismaTaskStageTransitionConfigRepository } from '../adapters/prisma/PrismaTaskStageTransitionConfigRepository';
import { GetTaskStageTransitionConfig } from '@application/use-cases/GetTaskStageTransitionConfig';
import { SetTaskStageTransitionConfig } from '@application/use-cases/SetTaskStageTransitionConfig';
// finance-growth Fase 1 — ingest global de cobranza GR (design.md Decision 4b).
import { createFinanceGrowthRouter } from './routes/financeGrowth.routes';
import { ListFinanceInvoiceTypes } from '@application/use-cases/finance/ListFinanceInvoiceTypes';
import { ReclassifyFinanceInvoiceType } from '@application/use-cases/finance/ReclassifyFinanceInvoiceType';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';
import { RearmFinanceReceiptsBackfill } from '@application/use-cases/finance/RearmFinanceReceiptsBackfill';
import { PrismaFinanceInvoiceTypeClassificationRepository } from '../adapters/prisma/PrismaFinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptIngestScheduler, FinanceReceiptIngestSchedulerStatus } from '../scheduling/FinanceReceiptIngestScheduler';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
// finance-growth Fase 2 — settables CRUD (design.md HTTP Contract).
import { PrismaFinanceTechnologyCostRepository } from '../adapters/prisma/PrismaFinanceTechnologyCostRepository';
import { PrismaFinancePlanPriceRepository } from '../adapters/prisma/PrismaFinancePlanPriceRepository';
import { PrismaFinanceTargetsConfigRepository } from '../adapters/prisma/PrismaFinanceTargetsConfigRepository';
import { PrismaFinanceInflationIndexRepository } from '../adapters/prisma/PrismaFinanceInflationIndexRepository';
import { GetFinanceTechnologyCosts } from '@application/use-cases/finance/GetFinanceTechnologyCosts';
import { UpdateFinanceTechnologyCost } from '@application/use-cases/finance/UpdateFinanceTechnologyCost';
import { GetFinancePlanPrices } from '@application/use-cases/finance/GetFinancePlanPrices';
import { UpdateFinancePlanPrice } from '@application/use-cases/finance/UpdateFinancePlanPrice';
import { GetFinanceTargets } from '@application/use-cases/finance/GetFinanceTargets';
import { UpdateFinanceTargets } from '@application/use-cases/finance/UpdateFinanceTargets';
import { ListFinanceInflationIndex } from '@application/use-cases/finance/ListFinanceInflationIndex';
import { UpdateFinanceInflationIndex } from '@application/use-cases/finance/UpdateFinanceInflationIndex';
// finance-growth Fase 3 rework (J1) — manual backfill trigger for FinanceMonthlySnapshot/FinanceCohortSnapshot.
import { PrismaFinanceReceiptItemRepository } from '../adapters/prisma/PrismaFinanceReceiptItemRepository';
import { PrismaFinanceReceiptApplicationRepository } from '../adapters/prisma/PrismaFinanceReceiptApplicationRepository';
import { PrismaFinanceMonthlySnapshotRepository } from '../adapters/prisma/PrismaFinanceMonthlySnapshotRepository';
import { PrismaFinanceCohortSnapshotRepository } from '../adapters/prisma/PrismaFinanceCohortSnapshotRepository';
import { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';
import { BackfillFinanceMonthlySnapshots } from '@application/use-cases/finance/BackfillFinanceMonthlySnapshots';
// finance-growth Fase 4 — read API (design.md HTTP Contract, tasks.md 4.x).
import { GetFinanceOverview } from '@application/use-cases/finance/GetFinanceOverview';
import { GetFinanceCohorts } from '@application/use-cases/finance/GetFinanceCohorts';
import { ComputeCacAndPayback } from '@application/use-cases/finance/ComputeCacAndPayback';
import { RankEarlyChurnByVendor } from '@application/use-cases/finance/RankEarlyChurnByVendor';
import { RankNetGrowthByNode } from '@application/use-cases/finance/RankNetGrowthByNode';
import { RankCancellationReasonsByLostRevenue } from '@application/use-cases/finance/RankCancellationReasonsByLostRevenue';

// customer-portal-api Fase 7 (task 7.1) — wiring del portal de clientes.
import { createPortalRouter } from './routes/portal.routes';
import { createPortalAccountsAdminRouter } from './routes/portalAccountsAdmin.routes';
import { createPortalAuthMiddleware } from './middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from './middleware/portalKillSwitchMiddleware';
import { createPortalAccountDeletionAuditRecorder } from '../audit/portalAccountDeletionAudit';
import { PrismaPortalAccountRepository } from '../adapters/prisma/PrismaPortalAccountRepository';
import { PrismaPortalSessionRepository } from '../adapters/prisma/PrismaPortalSessionRepository';
import { PrismaClientPortalLookup } from '../adapters/prisma/PrismaClientPortalLookup';
import { JwtPortalTokenService } from '../adapters/jwt/JwtPortalTokenService';
import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import { GetPortalMe } from '@application/use-cases/portal/GetPortalMe';
import { ListPortalInvoices } from '@application/use-cases/portal/ListPortalInvoices';
import { ListPortalPlans } from '@application/use-cases/portal/ListPortalPlans';
import { ListPortalTasks } from '@application/use-cases/portal/ListPortalTasks';
import { ListPortalTickets } from '@application/use-cases/portal/ListPortalTickets';
import { GetPortalTicket } from '@application/use-cases/portal/GetPortalTicket';
import { CreatePortalTicket } from '@application/use-cases/portal/CreatePortalTicket';
import { ListPortalTicketTopics } from '@application/use-cases/portal/ListPortalTicketTopics';
import { DeleteMyPortalAccount } from '@application/use-cases/portal/DeleteMyPortalAccount';
// portal-ticket-messaging (v2.B) — mensajería interna de un reclamo, lado portal.
import { ListPortalTicketMessages } from '@application/use-cases/portal/ListPortalTicketMessages';
import { SendPortalTicketMessage } from '@application/use-cases/portal/SendPortalTicketMessage';
import { GetPortalTicketMessageAttachmentFile } from '@application/use-cases/portal/GetPortalTicketMessageAttachmentFile';
import { CreatePortalAccount } from '@application/use-cases/portal-admin/CreatePortalAccount';
import { RegeneratePortalPassword } from '@application/use-cases/portal-admin/RegeneratePortalPassword';
import { SetPortalAccountStatus } from '@application/use-cases/portal-admin/SetPortalAccountStatus';
import { DeletePortalAccountAdmin } from '@application/use-cases/portal-admin/DeletePortalAccountAdmin';
import { ListPortalAccounts } from '@application/use-cases/portal-admin/ListPortalAccounts';

// portal-promos — promociones en la app de clientes (client-facing + admin CRUD).
import { PrismaPortalPromoRepository } from '../adapters/prisma/PrismaPortalPromoRepository';
import { PrismaPortalPromoResponseRepository } from '../adapters/prisma/PrismaPortalPromoResponseRepository';
import { ListPortalPromos } from '@application/use-cases/portal/ListPortalPromos';
import { GetPortalPromo } from '@application/use-cases/portal/GetPortalPromo';
import { InterestInPortalPromo } from '@application/use-cases/portal/InterestInPortalPromo';
import { DismissPortalPromo } from '@application/use-cases/portal/DismissPortalPromo';
// portal-benefits — pestaña Catálogo (Disponibles/Activados).
import { ListPortalBenefits } from '@application/use-cases/portal/ListPortalBenefits';
import { createPromosRouter } from './routes/promos.routes';
import { ListPortalPromosAdmin } from '@application/use-cases/promos/ListPortalPromosAdmin';
import { GetPortalPromoAdmin } from '@application/use-cases/promos/GetPortalPromoAdmin';
import { CreatePortalPromo } from '@application/use-cases/promos/CreatePortalPromo';
import { UpdatePortalPromo } from '@application/use-cases/promos/UpdatePortalPromo';
import { PreviewPromoAudience } from '@application/use-cases/promos/PreviewPromoAudience';

// portal-push-notifications — dispositivos + preferencias (client-facing) y
// avisos de servicio (admin, push.send).
import { PrismaPortalPushTokenRepository } from '../adapters/prisma/PrismaPortalPushTokenRepository';
import { PrismaPortalPushPreferenceRepository } from '../adapters/prisma/PrismaPortalPushPreferenceRepository';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { UnregisterPortalPushToken } from '@application/use-cases/portal/UnregisterPortalPushToken';
import { GetPortalPushPreferences } from '@application/use-cases/portal/GetPortalPushPreferences';
import { UpdatePortalPushPreferences } from '@application/use-cases/portal/UpdatePortalPushPreferences';
import { SendPushServiceAlert } from '@application/use-cases/notifications/SendPushServiceAlert';
import { PreviewPushServiceAlert } from '@application/use-cases/notifications/PreviewPushServiceAlert';
import { FcmPushSender } from '../adapters/fcm/FcmPushSender';
import { NoopPushSender } from '../adapters/fcm/NoopPushSender';
import type { PushSender } from '@domain/ports/PushSender';

// portal-notification-inbox — buzón del portal (respaldo del push, con o sin
// token). `SendPushServiceAlert` lo necesita para escribir 1 fila por cuenta
// destinataria; el portal expone GET/unread-count/read/read-all sobre lo mismo.
import { PrismaPortalNotificationRepository } from '../adapters/prisma/PrismaPortalNotificationRepository';
import { ListPortalNotifications } from '@application/use-cases/portal/ListPortalNotifications';
import { GetPortalNotificationsUnreadCount } from '@application/use-cases/portal/GetPortalNotificationsUnreadCount';
import { MarkPortalNotificationsRead } from '@application/use-cases/portal/MarkPortalNotificationsRead';
import { MarkAllPortalNotificationsRead } from '@application/use-cases/portal/MarkAllPortalNotificationsRead';

// wifi-self-service (F0) — "Mi WiFi" (portal, ResolveWifiEligibility +
// GET/PUT/devices) y `/api/wifi` (admin, wifi.read/wifi.manage).
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { UpdatePortalWifiBand } from '@application/use-cases/wifi/UpdatePortalWifiBand';
import { ListPortalWifiDevices } from '@application/use-cases/wifi/ListPortalWifiDevices';
import { GetAdminOnuWifiStatus } from '@application/use-cases/wifi/GetAdminOnuWifiStatus';
import { SetAdminWifiBand } from '@application/use-cases/wifi/SetAdminWifiBand';
import { EnableOnuTr069 } from '@application/use-cases/wifi/EnableOnuTr069';
import { createWifiRouter } from './routes/wifi.routes';

// portal-equipment-reboot — "Reiniciar mi equipo" (extiende wifi-self-service:
// reusa el MISMO smartoltWifiGateway/getOnuWifiStatus, elegibilidad MÁS AMPLIA).
import { ResolveEquipmentRebootEligibility } from '@application/use-cases/equipment/ResolveEquipmentRebootEligibility';
import { GetPortalEquipmentStatus } from '@application/use-cases/equipment/GetPortalEquipmentStatus';
import { RebootPortalEquipment } from '@application/use-cases/equipment/RebootPortalEquipment';

/**
 * Minimal FK lookup for scheduling use-case FK validation.
 *
 * Each branch calls findUnique on the correct Prisma delegate with its own
 * concrete argument type — no `as any` needed, TypeScript can verify each call.
 */
// Covers entity kinds used for FK validation in scheduling use cases.
// #70: the declared shape includes grClienteId so reverting the select below breaks the COMPILE,
// not just runtime (RegisterGigaredAccount needs it to derive the deterministic password).
function prismaClientLookup(model: 'Client' | 'Contract' | 'Partner' | 'Project' | 'Ticket', id: string): Promise<{ id: string; name?: string; grClienteId?: string | null; tvActivationSeq?: number | null } | null> {
  switch (model) {
    // #70 — Client carries grClienteId so RegisterGigaredAccount can derive the deterministic
    // TV password server-side. Selecting it here is harmless for the existence-only callers.
    // #81 — also carries tvActivationSeq so every TV use case resolves the CURRENT internal_id
    // (currentTvInternalId(id, seq)) instead of the bare Client.id. Cast keeps it compile-safe
    // before the Prisma Client is regenerated with the new column (mirror of tvCancelledAt).
    // service-transfer — also carries name so TransferTvToCustomer can snapshot legible
    // oldValue/newValue ("de quién a quién") in the transfer-out/in history events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'Client':   return (prisma as any).client.findUnique({ where: { id }, select: { id: true, name: true, grClienteId: true, tvActivationSeq: true } });
    case 'Contract': return prisma.contract.findUnique({ where: { id }, select: { id: true } });
    case 'Partner':  return prisma.partner.findUnique({ where: { id }, select: { id: true } });
    case 'Project':  return prisma.project.findUnique({ where: { id }, select: { id: true } });
    case 'Ticket':   return (prisma as any).ticket.findUnique({ where: { id }, select: { id: true } });
  }
}

// #47k — ownership-aware Contract lookup for the Gigared use cases. Returns clientId so each
// destructive TV use case can assert the contract belongs to the target customer before any
// Gigared write (a foreign contractId → 404, no cross-customer reconcile). One findUnique.
// #115 — grContratoId added to the select so RegisterGigaredAccount can derive the deterministic
// TV identity (email + password) from the contract's grContratoId without a second query (no N+1).
function prismaContractOwnershipLookup(id: string): Promise<{ id: string; clientId: string; grContratoId: string | null } | null> {
  return prisma.contract.findUnique({ where: { id }, select: { id: true, clientId: true, grContratoId: true } });
}

// service-transfer (W2) — contract lookup con clientId + NOMBRE del cliente para TransferPppoe:
// ownership del contrato destino (existencia + resolución del cliente) y snapshot LEGIBLE
// ("de quién a quién") de los eventos transfer-out/in. UN findUnique con JOIN al Client (no N+1).
async function prismaContractClientNameLookup(
  id: string,
): Promise<{ id: string; clientId: string; clientName: string | null } | null> {
  const row = await prisma.contract.findUnique({
    where: { id },
    select: { id: true, clientId: true, client: { select: { name: true } } },
  });
  return row ? { id: row.id, clientId: row.clientId, clientName: row.client?.name ?? null } : null;
}

// smartolt-provision (K2) — contract lookup para ProvisionFiberOnu: cliente
// (nombre + grClienteId) + plan + grContratoId en UN findUnique con JOIN al
// Client (precedente prismaContractClientNameLookup, no N+1).
async function prismaFiberContractLookup(id: string): Promise<FiberContractSnapshot | null> {
  const row = await prisma.contract.findUnique({
    where: { id },
    select: {
      id: true,
      plan: true,
      grContratoId: true,
      client: { select: { id: true, name: true, grClienteId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    plan: row.plan,
    grContratoId: row.grContratoId ?? null,
    clientId: row.client.id,
    clientName: row.client.name,
    grClienteId: row.client.grClienteId ?? null,
  };
}

// smartolt-provision (K2) — resultado auditable: la ÚLTIMA tarea no archivada del
// contrato (la de instalación del ingest K1 típicamente) recibe el bloque
// "── Aprovisionamiento ONU ──" appendeado a su description. Best-effort en el
// use case: sin tarea no es error.
const prismaFiberInstallTaskWriter: FiberInstallTaskWriter = {
  async findLatestByContract(contractId: string) {
    const row = await prisma.scheduledTask.findFirst({
      where: { contractId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, description: true },
    });
    return row ? { id: row.id, description: row.description ?? null } : null;
  },
  // K3 fix wave M4 — lookup directo: el watcher audita en la tarea MATCHEADA por serial.
  async findById(taskId: string) {
    const row = await prisma.scheduledTask.findUnique({
      where: { id: taskId },
      select: { id: true, description: true },
    });
    return row ? { id: row.id, description: row.description ?? null } : null;
  },
  async updateDescription(taskId: string, description: string) {
    await prisma.scheduledTask.update({ where: { id: taskId }, data: { description } });
  },
};

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

// finance-growth Fase 1 — pacing snapshot when the scheduler is disabled/not
// yet bootstrapped (GR off, or GR_CUIT/GR_SECRET missing) — GET /sync/status
// still responds 200 with an honest "idle" snapshot instead of 500.
// fix-wave-2 LOW: was hardcoded to 20000 — now mirrors
// FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS so a change to the base pacing default
// doesn't leave this idle snapshot silently out of sync with reality.
const FINANCE_RECEIPT_INGEST_IDLE_STATUS: FinanceReceiptIngestSchedulerStatus = {
  requestIntervalMs: FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs,
  effectiveIntervalMs: FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs,
  degraded: false,
  consecutiveFailures: 0,
  activeLane: 'idle',
  // fix-wave-2 R3 — no scheduler instance at all ⇒ definitionally not running.
  enabled: false,
};

export function createApp(taskAutocomplete?: TaskAutocompleteScheduler | null, backfillScheduler?: BackfillScheduler | null, uispSyncScheduler?: UispSyncScheduler | null, financeReceiptIngestScheduler?: FinanceReceiptIngestScheduler | null) {
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
  // messaging-inbox (F1) — same "path-scoped parser BEFORE the global express.json()"
  // pattern as the ticket-comments override above. `rawBodyJsonParser()` (B5) captures
  // the untouched bytes into `req.rawBody` via its `verify` hook while ALSO parsing
  // `req.body` as JSON — chatwootSignatureMiddleware (HOOK-1/2) recomputes the HMAC over
  // req.rawBody, and ReceiveChatwootWebhook consumes the already-parsed req.body. Must
  // stay registered here, BEFORE the global express.json() below (body-parser's
  // req._body guard makes the second global parse a no-op, same safety as :829).
  app.use('/api/messaging/webhook', rawBodyJsonParser());
  // bulk-csv-recipients (fix wave, C1) — same "path-scoped parser BEFORE the
  // global express.json()" pattern as the two overrides above. Without this,
  // the global 100kb default 413s a realistic CSV (~2000 contacts already
  // exceeds 100kb; the CSV-5 cap is 5000 rows) BEFORE it ever reaches
  // /segment/preview, /segment/recipients or /campaigns — the feature is
  // unusable and the TooManyManualContactsError 422 (the real business cap) is
  // unreachable. 2mb covers 5000 rows × ~100 bytes/row (~500KB) with generous
  // headroom. body-parser's req._body guard makes the second (global) parse a
  // no-op, same safety net as the two overrides above.
  app.use('/api/messaging/bulk', express.json({ limit: '2mb' }));
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
  // CreateTicket enforces the contract requirement: customer must exist, contract
  // must exist, and the contract must belong to the customer (422 otherwise).
  // customerLookup = existence; contractLookup = ownership-aware (returns clientId).
  const createTicket = new CreateTicket(
    ticketAdapter,
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaContractOwnershipLookup(id) },
  );
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

  // iclass-status-sync — instantiated early so it can be passed to PrismaSchedulingRepository
  // for the iclassStatus resolution on listTasks/getTask. Also referenced by the closure ingest
  // (below) and the status routes.
  const iclassStatusCatalogRepo = new PrismaIClassStatusCatalogRepository();
  const schedulingRepo = new PrismaSchedulingRepository(iclassStatusCatalogRepo);
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
  // updateTask is instantiated below (after iclassTeamRepo + autoAssigner are ready)
  // to inject the optional IClassAutoAssigner collaborator (AD-2).
  let updateTask: UpdateTask;
  // deleteTask se instancia más abajo (tras taskAttachmentRepo + taskPhotoStorage)
  // para poder limpiar de forma EAGER los binarios del storage al borrar la tarea
  // (el cascade de Postgres borra las filas de adjuntos pero NO los objetos de MinIO).
  let deleteTask: DeleteTask;
  const archiveTask = new ArchiveTask(schedulingRepo);
  // IClass integration: moving a task to "Enviar a IClass" delegates the OS
  // creation. The on/off decision lives in the feature flag (default OFF).
  const featureFlagRepo = new PrismaFeatureFlagRepository();
  // Audit repo for IClass dispatch attempts — injected as 4th arg (AD-6: optional on SendTaskToIClass).
  const iclassDispatchAttemptRepo = new PrismaIClassDispatchAttemptRepository();
  // sendTaskToIClass + moveTaskToStage + bulkMoveTasksToStage are declared after autoAssignIClassTeam
  // (iclass-ops-config block) so autoAssignIClassTeam can be passed as the 7th arg (#130).
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
  // client-geolocation — Prominense-owned GPS update use cases.
  const updateClientLocation = new UpdateClientLocation(customerAdapter);
  const updateContractLocation = new UpdateContractLocation(contractRepo);

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
  // listIpNetworks / listIpPools se construyen más abajo: necesitan nasRepo + router + orchestrator
  // (los counts se calculan de las IPs REALMENTE asignadas, ruteadas por nas.type, como FindFreeIp).
  const createIpNetwork = new CreateIpNetwork(ipNetworkRepo);
  const deleteIpNetwork = new DeleteIpNetwork(ipNetworkRepo);
  const createIpPool = new CreateIpPool(ipNetworkRepo);
  const deleteIpPool = new DeleteIpPool(ipNetworkRepo);
  // Bug 3: GET /api/ip-assignments ahora usa PppoeService como fuente de datos
  // (ListPppoeAssignments). El ListIpAssignments legacy ya no se usa en rutas.
  const listPppoeAssignmentsForIpRoute = new ListPppoeAssignments(new PrismaPppoeServiceRepository());

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
  // NAS live-counters: se construye después del orchestrator (singleton compartido creado abajo)
  // Para evitar forward-reference, se construye en diferido justo antes de los use cases NAS.
  const createNasServer = new CreateNasServer(nasRepo);
  const updateNasServer = new UpdateNasServer(nasRepo);
  const deleteNasServer = new DeleteNasServer(nasRepo);
  const getRadiusConfig = new GetRadiusConfig(nasRepo);
  const updateRadiusConfig = new UpdateRadiusConfig(nasRepo);

  // ─── radius-orchestrator singleton — compartido por PPPoE (enforcement), Plan catalog (sync)
  //     e IP allocator (assigned-ips por RADIUS). Creado acá (temprano) porque FindFreeIp lo necesita.
  // Opt-in: si ORCHESTRATOR_BASE_URL no está configurado, los métodos fallan al USARSE con error
  // claro (OrchestratorUnreachableError → 502). El resto de la app arranca igual. SERVER-SIDE.
  const orchestrator = new HttpRadiusOrchestratorGateway({
    baseUrl: config.orchestrator.baseUrl,
    token: config.orchestrator.token,
    timeoutMs: config.orchestrator.timeoutMs,
  });

  // ip-allocator (FindFreeIp): primer IP libre = rango del pool − IPs asignadas, ruteadas por nas.type:
  //   'radius_orchestrator' → RADIUS (orchestrator.listAssignedIps, radreply Framed-IP);
  //   resto                → router (/ppp secret, remote-address vivos).
  const findFreeIp = new FindFreeIp(ipNetworkRepo, nasRepo, new RouterOsGateway(), orchestrator);

  // Gestión de Red IP — counts REALES: la verdad de las IPs asignadas vive en el RADIUS
  // (radius_orchestrator → orchestrator) o el router (resto), no en la tabla IpAssignment (vacía en prod).
  // Mismo ruteo por nas.type que el allocator. Degrada por pool/red si el NAS está caído (no 500).
  const listIpNetworks = new ListIpNetworks(ipNetworkRepo, nasRepo, new RouterOsGateway(), orchestrator);
  const listIpPools = new ListIpPools(ipNetworkRepo, nasRepo, new RouterOsGateway(), orchestrator);

  // NAS live-counters: clientCount/lastSeen en vivo para radius_orchestrator via orchestrator.
  // #1: ipNetworkRepo y orchestrator se inyectan directo a los use cases — cada request
  // crea su propio NasLiveStatsProvider fresco (evita cache singleton entre requests).
  const listNasServers = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
  const getNasServer = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);

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

  // gestion-red-sessions — las sesiones del tab "Sesiones activas" salen del radius-orchestrator
  // EN VIVO (GET /sessions), NO de la tabla LOCAL `radiusSession` (que nunca se popula → siempre 0).
  // LÍMITE CONOCIDO (no bug): el orchestrator HA solo termina Acceso Sur/NE8000; las sesiones de
  // MikroTik legacy NO están en GET /sessions. El use case cruza cada sesión a su contrato
  // (pppoe→contract→client) por username en BATCH (findByUsernames).
  const radiusRepo = new OrchestratorRadiusSessionRepository(orchestrator);
  const listRadiusSessions = new ListRadiusSessions(radiusRepo, new PrismaPppoeServiceRepository());
  const disconnectSession = new DisconnectSession(radiusRepo);
  // === RADIUS accounting / network audit ===
  const radiusEventRepo = new PrismaRadiusEventRepository();
  const listRadiusEvents = new ListRadiusEvents(radiusEventRepo);
  const listNe8000Audit = new ListNe8000PppoeAudit(new PrismaPppoeServiceRepository(), radiusEventRepo, nasRepo, config.networkAudit.ne8000NasIp);
  // RADIUS auth events (radpostauth) — read-only para el FE.
  const radiusAuthEventRepo = new PrismaRadiusAuthEventRepository();
  const listRadiusAuthFailures = new ListRadiusAuthFailures(radiusAuthEventRepo);
  // radius-session-autocure BE-1 (REQ-CURE-5/6) — registro de curas + core compartido watcher/manual.
  const radiusSessionCureEventRepo = new PrismaRadiusSessionCureEventRepository();
  const listRadiusSessionCures = new ListRadiusSessionCures(radiusSessionCureEventRepo);
  const cureStuckSession = new CureStuckSession(orchestrator, radiusSessionCureEventRepo, {
    staleMs: config.radiusAutoCure.staleMs,
    persistenceMs: config.radiusAutoCure.persistenceMs,
    recencyMs: config.radiusAutoCure.recencyMs,
  });

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

  // internal-news — tablón interno del equipo. Aditivo, dark (sin FE consumidor
  // todavía) — NEWS-HTTP-4: nada de lo de arriba (notifications) se toca.
  const newsCategoryRepo = new PrismaNewsCategoryRepository();
  const newsPostRepo = new PrismaNewsPostRepository();
  // N2 — repo de adjuntos de noticia: inyectado en List/Get para que el DTO exponga los
  // attachments; y en el media router de más abajo. El media router en sí se monta luego
  // (necesita el gateway NOC + el storage MinIO, construidos más adelante).
  const newsAttachmentRepo = new PrismaNewsPostAttachmentRepository();
  const listNewsPosts = new ListNewsPosts(newsPostRepo, newsAttachmentRepo);
  const getNewsPost = new GetNewsPost(newsPostRepo, newsAttachmentRepo);
  const createNewsPost = new CreateNewsPost(newsPostRepo, newsCategoryRepo);
  const updateNewsPost = new UpdateNewsPost(newsPostRepo, newsCategoryRepo);
  const archiveNewsPost = new ArchiveNewsPost(newsPostRepo);
  const markNewsRead = new MarkNewsRead(newsPostRepo);
  const getNewsUnreadCount = new GetNewsUnreadCount(newsPostRepo);
  const listNewsCategories = new ListNewsCategories(newsCategoryRepo);
  const createNewsCategory = new CreateNewsCategory(newsCategoryRepo);
  const updateNewsCategory = new UpdateNewsCategory(newsCategoryRepo);
  const deleteNewsCategory = new DeleteNewsCategory(newsCategoryRepo);
  const deleteNotification = new DeleteNotification(notificationRepo);

  // Routes
  app.use('/api/dashboard', createDashboardRouter(getDashboardStats, getDashboardShortcuts, getRecentActivity));
  app.use('/api/messages', createMessagesRouter(listMessages, getMessage, createMessage, markMessageAsRead, deleteMessage));
  app.use('/api/auth', createAuthRouter(authAdapter, rbacUserRepo, rbacUserRoleRepo, resolveUserPermissions, sessionRepo, createLoginRateLimiter(config.loginRateLimit)));
  app.use('/api/clients', createClientsRouter(listClients, getDetail, getContracts, getInvoices, getLogs, authAdapter, sessionRepo, createCustomer, getClientStats, deleteCustomer, updateClientLocation, requirePerm));
  app.use('/api/customers', createClientCommentsRouter(getComments, createComment));
  // TicketStatus catalog — mounted BEFORE the tickets router to avoid /:id catch-all swallowing /statuses.
  app.use('/api/tickets/statuses', createTicketStatusesRouter(
    authAdapter,
    sessionRepo,
    listTicketStatuses, getTicketStatus, createTicketStatus, updateTicketStatusCatalog, deleteTicketStatus,
  ));
  // TicketArea catalog — mounted BEFORE the tickets router (#49)
  app.use('/api/tickets/areas', createTicketAreasRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    listTicketAreas, getTicketArea, createTicketArea, updateTicketArea, deleteTicketArea,
  ));
  // #79 — SLA timer config — mounted BEFORE the tickets router so /:id doesn't swallow it
  app.use('/api/tickets/sla-config', createTicketSlaConfigRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    getTicketSlaConfig, updateTicketSlaConfig,
  ));
  // #85 — archive + hard-delete use cases
  const archiveTicket = new ArchiveTicket(ticketAdapter, ticketStatusRepo);
  const deleteTicketHard = new DeleteTicketHard(ticketAdapter);
  app.use('/api/tickets', createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateTicketStatus, updateTicket, closeTicket, ticketStatusRepo, authAdapter, sessionRepo, rbacUserRepo, createTaskFromTicket, schedulingRepo, stageRepo, ticketAreaRepo, archiveTicket, deleteTicketHard, rbacUserRepo));
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
  app.use('/api/billing', createBillingRouter(getSummary, listInvoices, listPayments, listTransactions, authAdapter, sessionRepo));
  app.use('/api/billing', createBillingMonthlyRouter(getMonthly));
  app.use('/api/billing', createCreditNotesRouter(listCreditNotes, getCreditNote, createCreditNote, applyCreditNote, voidCreditNote));
  app.use('/api/billing', createProformasRouter(listProformas, createProforma, convertToInvoice, cancelProforma));
  app.use('/api/billing', createFinanceHistoryRouter(listFinanceHistory));
  // IMPORTANT: workflows router MUST be mounted BEFORE scheduling router because
  // both share the /api/scheduling prefix and scheduling has a /:id catch-all
  // that would otherwise swallow /workflows, /project-categories, /project-types.
  app.use('/api/scheduling', createWorkflowsRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    listWorkflows, getWorkflow, createWorkflowUC, updateWorkflowUC, deleteWorkflowUC,
    addStageToWorkflow, removeStageFromWorkflow, reorderStages, updateStageColor, updateStageUC,
    listProjectCategory, getProjectCategory, createProjectCategory, updateProjectCategory, deleteProjectCategory,
    listProjectType, getProjectType, createProjectType, updateProjectType, deleteProjectType,
  ));
  // TaskCategory catalog — mounted before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskCategoriesRouter(
    authAdapter,
    sessionRepo,
    listTaskCategory, getTaskCategory, createTaskCategory, updateTaskCategory, deleteTaskCategory,
  ));
  // ContractTechnology catalog — mounted at /api root (no catch-all conflict).
  app.use('/api', createContractTechnologiesRouter(
    authAdapter,
    sessionRepo,
    listContractTechnology, getContractTechnology, createContractTechnology,
    updateContractTechnology, deleteContractTechnology,
  ));
  // contract-node-ap-auto-assign (Fase B, PICK-3) — picker manual del nodo/AP de un contrato.
  const setContractNetworkAssignment = new SetContractNetworkAssignment(
    contractRepo,
    networkSiteRepo,
    new PrismaAccessPointRepository(),
  );
  // Global contracts listing — mounted at /api root, before the catch-all.
  app.use('/api', createContractsRouter(authAdapter, sessionRepo, listContracts, getContractStats, updateContractLocation, requirePerm, setContractNetworkAssignment));
  // #43 — ServiceCatalog ABM + ContractService CRUD + Contract name, mounted at /api root.
  const serviceCatalogRepo     = new PrismaServiceCatalogRepository();
  const contractServiceRepo    = new PrismaContractServiceRepository();
  // #110 — append-only ledger for non-TV contract service events.
  const contractServiceEventRepo = new PrismaContractServiceEventRepository();
  // #110 — TV activation event repo instantiated here (also reused by the Gigared router below).
  // PrismaTvActivationEventRepository has no local deps — safe to instantiate early.
  const contractServicesTvEventRepo = new PrismaTvActivationEventRepository();
  const contractLookup = { findById: (id: string) => prismaClientLookup('Contract', id) };
  app.use('/api', createServiceCatalogRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    new ListServiceCatalog(serviceCatalogRepo),
    new CreateServiceCatalog(serviceCatalogRepo),
    new UpdateServiceCatalog(serviceCatalogRepo),
    new DeleteServiceCatalog(serviceCatalogRepo),
  ));
  app.use('/api', createContractServicesRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    new UpdateContractName(contractRepo),
    new AddContractService(contractServiceRepo, serviceCatalogRepo, contractLookup, contractServiceEventRepo),
    new UpdateContractService(contractServiceRepo, contractServiceEventRepo),
    new RemoveContractService(contractServiceRepo, contractServiceEventRepo),
    // #110 — cross-source: non-TV from contractServiceEventRepo, TV from contractServicesTvEventRepo.
    new ListContractServiceHistory(contractServiceRepo, contractServiceEventRepo, contractServicesTvEventRepo),
  ));
  // TaskPriority catalog — also before the scheduling catch-all router.
  app.use('/api/scheduling', createTaskPrioritiesRouter(
    authAdapter,
    sessionRepo,
    listTaskPriority, getTaskPriority, createTaskPriority, updateTaskPriority, deleteTaskPriority,
  ));
  // DeviceTypeCatalog — mounted at /api/inventory BEFORE any catch-all.
  app.use('/api/inventory', createDeviceTypeCatalogRouter(
    authAdapter,
    sessionRepo,
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
    sessionRepo,
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
    sessionRepo,
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
    sessionRepo,
    new GetGestionRealSyncStatus(new PrismaSyncStateRepository(), new PrismaMirrorCountsRepository()),
  ));
  // GR sync admin — reset the gr-clients cursor to force a full backfill next tick.
  app.use('/api/admin/gr-sync', createGrSyncRouter(
    authAdapter,
    sessionRepo,
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
  // Cambio A — shared install/dual-write service for the dedup-aware contract add.
  const installContractAsset = new InstallContractAsset(deviceTypeCatalogRepo);
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
  // service-transfer (W3) — mueve ContractInstalledItems a otro contrato (lote atómico via
  // inventoryUow: legacy + ledger TRANSFER en UNA tx) con eventos transfer-out/in al historial.
  // Mismo lookup ownership-aware + nombre de cliente que TransferPppoe (W2).
  const transferContractEquipment = new TransferContractEquipment(
    contractInventoryRepo,
    { findById: (id: string) => prismaContractClientNameLookup(id) },
    new ResolveClientLocation(stockLocationRepo),
    inventoryUow,
    new PrismaServiceCatalogRepository(),
    new PrismaContractServiceEventRepository(),
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
    new AddContractEquipment(
      contractInventoryRepo, deviceTypeCatalogRepo,
      stockLocationRepo, inventoryAssetRepo, inventoryMovementRepo, inventoryUow,
      installContractAsset,
    ),
    new UpdateInstalledItem(contractInventoryRepo),
    new RemoveInstalledItem(contractInventoryRepo),
    new RetireInstalledItem(
      contractInventoryRepo,
      new RouteAssetToDisposition(
        new ResolveDepotLocation(stockLocationRepo),
        new ResolveTechnicianLocation(stockLocationRepo),
        new ResolveClientLocation(stockLocationRepo),
      ),
      inventoryUow,
      inventoryAssetRepo,
      inventoryMovementRepo,
    ),
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
      transfer:      requirePerm('inventory', 'transfer'), // service-transfer (W3) — granular, write NO alcanza
    },
    deviceTypeCatalogService,
    new CreateManualSuggestion(inventorySuggestionRepo, schedulingRepo, contractInventoryRepo, deviceTypeCatalogService),
    transferContractEquipment,
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
  // resendTaskToIClassWithNode declared after autoAssignIClassTeam (iclass-ops-config block) — #130.

  // iclass-os-actions (Ola A): CloseIClassServiceOrder — uses the already-built repos.
  // iclassResultCodeRepo is declared here early so CloseIClassServiceOrder can reference it;
  // the same instance is reused below in the closure loop (IClass admin routes).
  const iclassResultCodeRepo = new PrismaIClassResultCodeRepository();
  const closeIClassServiceOrder = new CloseIClassServiceOrder(
    schedulingRepo,
    buildIClassClient(),
    iclassResultCodeRepo,
    featureFlagRepo,
    taskActivityRecorder,
  );

  // iclass-os-actions (Ola B): AssignIClassTeam + team catalog use cases.
  const iclassTeamRepo = new PrismaIClassTeamRepository();
  const assignIClassTeam = new AssignIClassTeam(
    schedulingRepo,
    buildIClassClient(),
    iclassTeamRepo,
    featureFlagRepo,
    taskActivityRecorder,
  );

  // iclass-ops-config (Ola A): auto-assigner + UpdateTask with optional collaborator.
  // AutoAssignIClassTeamOnTaskUpdate implements IClassAutoAssigner (AD-2).
  const autoAssignIClassTeam = new AutoAssignIClassTeamOnTaskUpdate(
    schedulingRepo,
    buildIClassClient(),
    iclassTeamRepo,
    featureFlagRepo,
    rbacUserRepo,
    taskActivityRecorder,
  );
  // Instantiate updateTask HERE (after autoAssigner is ready) with the collaborator.
  // UpdateTask receives it as the 8th optional arg (AD-2: DIP + best-effort).
  updateTask = new UpdateTask(
    schedulingRepo,
    { findById: (id: string) => prismaClientLookup('Client', id) },
    { findById: (id: string) => prismaClientLookup('Contract', id) },
    { findById: (id: string) => prismaClientLookup('Partner', id) },
    userLookupForScheduling,
    // #40 — project slot uses the kind-aware lookup (existence + isNetworkProject),
    // so the symmetric project↔kind guard runs on update too.
    { findById: (id: string) => prismaProjectKindLookup(id) },
    taskActivityRecorder,
    autoAssignIClassTeam, // AD-2: optional best-effort IClass auto-assigner
  );

  // #130 — assign-at-register: sendTaskToIClass declared here (after autoAssignIClassTeam)
  // so autoAssignIClassTeam can be passed as the 7th optional arg.
  const sendTaskToIClass = new SendTaskToIClass(
    schedulingRepo,
    featureFlagRepo,
    buildIClassClient(),
    iclassDispatchAttemptRepo,
    taskActivityRecorder,
    networkSiteRepoForCreateTask,
    autoAssignIClassTeam, // #130: best-effort assign at register time
  );
  const moveTaskToStage = new MoveTaskToStage(schedulingRepo, stageRepo, sendTaskToIClass, taskActivityRecorder);
  const bulkMoveTasksToStage = new BulkMoveTasksToStage(moveTaskToStage);
  // #130: resend also wires autoAssignIClassTeam so re-dispatch assigns the cuadrilla too.
  const resendTaskToIClassWithNode = new ResendTaskToIClassWithNode(
    schedulingRepo,
    featureFlagRepo,
    buildIClassClient(),
    iclassDispatchAttemptRepo,
    stageRepo,
    autoAssignIClassTeam, // #130: best-effort assign at register time
  );

  // iclass-ops-config (Ola A): Technician↔Team mapping use cases + router
  const setTechnicianTeamMapping = new SetTechnicianTeamMapping(rbacUserRepo, iclassTeamRepo);
  const listTechnicianTeamMappings = new ListTechnicianTeamMappings(rbacUserRepo);

  // ── task-photos — adjuntos (fotos) de tarea ───────────────────────────────
  // Montado en /api/scheduling. El orden vs. el scheduling router principal NO es
  // estructuralmente necesario: los paths son disjuntos por nº de segmentos
  // (/attachments/:id/file=3, /:taskId/attachments=2, catch-all GET /:id=1), así que no
  // hay shadowing real. Se mantiene este orden por claridad/convención.
  // MinioFileStorage se construye con config.minio (opt-in): si MINIO_* falta el
  // BE arranca igual y la conexión a MinIO solo falla al USARSE (lazy en el cliente).
  const taskAttachmentRepo = new PrismaTaskAttachmentRepository();
  const taskPhotoStorage = new MinioFileStorage({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    bucket: config.minio.bucket,
  });
  const taskImageProcessor = new JimpImageProcessor();
  // deleteTask: limpieza EAGER de los binarios (original + thumbnail) en el storage
  // ANTES de borrar la tarea — el cascade de Postgres borra las filas de adjuntos pero
  // deja huérfanos los objetos de MinIO. Best-effort: un fallo de MinIO no aborta el borrado.
  deleteTask = new DeleteTask(schedulingRepo, taskAttachmentRepo, taskPhotoStorage);
  // EntityLookup de tarea: existencia vía el getTask ya instanciado (línea ~894).
  const taskLookupForAttachments = {
    findById: async (id: string): Promise<{ id: string } | null> => {
      const t = await getTask.execute(id);
      return t ? { id: t.id } : null;
    },
  };
  app.use('/api/scheduling', createTaskAttachmentsRouter(
    {
      attachPhotosToTask: new AttachPhotosToTask(taskAttachmentRepo, taskPhotoStorage, taskLookupForAttachments, taskImageProcessor),
      listTaskAttachments: new ListTaskAttachments(taskAttachmentRepo),
      getTaskAttachmentFile: new GetTaskAttachmentFile(taskAttachmentRepo, taskPhotoStorage),
      deleteTaskAttachment: new DeleteTaskAttachment(taskAttachmentRepo, taskPhotoStorage),
    },
    {
      authProvider: authAdapter,
      sessionRepo,
      requireRead: requirePerm('scheduling', 'read'),
      requireWrite: requirePerm('scheduling', 'write'),
    },
  ));

  // portal-ticket-messaging (v2.B) — mensajería (respuesta PÚBLICA del staff),
  // lado admin. Reusa `taskPhotoStorage` (patrón compartido — mismo bucket,
  // distinto prefijo de key, ver newsMedia arriba) y `ticketCommentRepo`
  // (mismo singleton que el CRUD de notas internas, línea ~1678). Montado en
  // /api/tickets, paths disjuntos de ticketComments/tickets por nº de
  // segmentos — ver el docblock de ticketMessages.routes.ts.
  app.use('/api/tickets', createTicketMessagesRouter(
    {
      sendStaffTicketReply: new SendStaffTicketReply(ticketCommentRepo, ticketAdapter, taskPhotoStorage),
      getTicketUnreadCount: new GetTicketUnreadCount(ticketAdapter, ticketCommentRepo),
      getTicketMessageAttachmentFile: new GetTicketMessageAttachmentFile(ticketCommentRepo, taskPhotoStorage),
    },
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      read: requirePerm('tickets', 'read'),
      write: requirePerm('tickets', 'write'),
    },
  ));

  // N3 (network-task-broadcast) — "Send to WS": motor N1 reusado para difundir una
  // tarea de RED al canal NOC. Los adapters son stateless (leen la config singleton
  // del DB al momento de enviar), así que una instancia dedicada acá es equivalente
  // a la del bloque N1 de más abajo (/api/messaging/noc-broadcast).
  const n3NocBroadcastConfigRepo = new PrismaNocBroadcastConfigRepository();
  const broadcastTaskToNoc = new BroadcastTaskToNoc(
    schedulingRepo,
    new BroadcastToNoc(
      n3NocBroadcastConfigRepo,
      new EvolutionApiHttpGateway({ configRepo: n3NocBroadcastConfigRepo }),
    ),
    // noc-broadcast-traceability — mismo recorder que usan AssignIClassTeam/AddTaskComment;
    // emite el evento 'noc_broadcast_sent' en el feed de Actividad (best-effort).
    taskActivityRecorder,
  );

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, authAdapter, sessionRepo, stageRepo, {
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
  }, getTaskActivity, requirePerm('inventory', 'write'), retireContractEquipment, setTaskGeneralStatus, requirePerm('scheduling', 'write'), archiveTask, requirePerm('scheduling', 'hard_delete'), {
    closeIClassServiceOrder,
    assignIClassTeam,
    requirePerm,
  }, broadcastTaskToNoc));
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

  app.use('/api/projects', createProjectsRouter(listProjectsUC, getProjectUC, createProjectUC, updateProjectUC, deleteProjectUC, authAdapter, sessionRepo, assignIClassSoType, requirePerm('inventory', 'manage'), requirePerm('scheduling', 'manage')));
  // GR installation-order ingest admin — config/status/needs-review (projectRepo + schedulingRepo already built above).
  const grIngestConfigRepo = new PrismaGestionRealIngestConfigRepository();
  app.use('/api/gestion-real-ingest', createGestionRealIngestRouter(
    authAdapter,
    sessionRepo,
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
      sessionRepo,
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
    authAdapter,
    sessionRepo,
    requirePerm,
    listIpNetworks, createIpNetwork, deleteIpNetwork,
    listIpPools, createIpPool, listPppoeAssignmentsForIpRoute,
    deleteIpPool, listIpv6Networks, createIpv6Network,
  ));
  // FIX-5: /api/network-sites was unauthenticated — all CRUD was open including the
  // uispSiteId connector field. Adding createAuthMiddleware (auth-only, no granular guard yet —
  // that is the known deferred permission pass).
  app.use('/api/network-sites', createAuthMiddleware(authAdapter, sessionRepo), createNetworkSiteRouter(
    listNetworkSites, getNetworkSite, createNetworkSite, updateNetworkSite, deleteNetworkSite,
    listNetworkSitesWithUisp, assignIClassNodeToNetworkSite,
  ));
  // contract-node-ap-auto-assign (Fase B, PICK-3) — catálogo de APs asignables (picker manual).
  // Gate network.read; auth aplicada al montar (patrón /api/network-sites, arriba).
  const accessPointRepoForPicker = new PrismaAccessPointRepository();
  const listAssignableAccessPoints = new ListAssignableAccessPoints(accessPointRepoForPicker);
  app.use('/api/access-points', createAuthMiddleware(authAdapter, sessionRepo), createAccessPointsRouter(
    listAssignableAccessPoints, requirePerm,
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
  app.use('/api/radius', createRadiusRouter(authAdapter, sessionRepo, requirePerm, listRadiusSessions, disconnectSession, listRadiusEvents, listNe8000Audit, listRadiusAuthFailures, listRadiusSessionCures, cureStuckSession));
  app.use('/api', createNasRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    listNasServers, getNasServer, createNasServer, updateNasServer, deleteNasServer,
    getRadiusConfig, updateRadiusConfig,
    findFreeIp,
  ));
  // customer-portal-api fix wave C2 — /api/settings era el UNICO mount admin sin
  // auth, y PUT /api/settings/client-portal es el plano de control del
  // kill-switch del portal (un anonimo podia revertirlo o apagar el portal).
  // Ningun consumidor legitimo no-autenticado encontrado (los route-tests montan
  // el router directo, sin pasar por aca) — se protege el router ENTERO con el
  // mismo patron stateful de los demas mounts admin.
  app.use(
    '/api/settings',
    createAuthMiddleware(authAdapter, sessionRepo),
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

  // portal-push-notifications — avisos de servicio (admin, `push.send`).
  // `pushSender`: `FcmPushSender` si `FIREBASE_SERVICE_ACCOUNT_JSON` está
  // seteada Y es un JSON de service account válido; `NoopPushSender` en
  // cualquier otro caso (incluida una env MAL configurada) — el boot NUNCA
  // debe caer por una credencial de Firebase rota (mismo criterio "opt-in, no
  // fail-fast" que `assistant`/`chatwoot`/`twilio` en config.ts).
  const pushSender: PushSender = (() => {
    if (!config.firebase.serviceAccountJson) return new NoopPushSender();
    try {
      return new FcmPushSender({ serviceAccountJson: config.firebase.serviceAccountJson });
    } catch (err) {
      console.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON inválido — cae a NoopPushSender (dry-run)', err);
      return new NoopPushSender();
    }
  })();
  // Instancia propia (stateless, mismo `prisma` singleton que
  // `portalPushTokenRepo` de la Fase 7 más abajo) — evita reordenar el wiring
  // del portal solo para compartir un repo sin config/estado que compartir.
  const pushServiceAlertTokenRepo = new PrismaPortalPushTokenRepository();
  // portal-notification-inbox — instancias propias (stateless, mismo `prisma`
  // singleton que `portalNotificationRepo`/`portalAccountRepo` del wiring del
  // portal más abajo) — evita reordenar el wiring solo para compartirlas.
  const portalNotificationRepo = new PrismaPortalNotificationRepository();
  const pushServiceAlertAccountRepo = new PrismaPortalAccountRepository();
  const sendPushServiceAlert = new SendPushServiceAlert(
    pushServiceAlertTokenRepo,
    pushSender,
    customerAdapter,
    portalNotificationRepo,
    pushServiceAlertAccountRepo,
  );
  const previewPushServiceAlert = new PreviewPushServiceAlert(pushServiceAlertTokenRepo, customerAdapter);

  app.use('/api/notifications', createNotificationsRouter(
    listNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification,
    authAdapter, sessionRepo, requirePerm, sendPushServiceAlert, previewPushServiceAlert,
  ));
  // internal-news — /api/news carries auth + requirePerm on EVERY route (design §6.1),
  // a deliberate contrast with the unguarded /api/notifications mount above.
  app.use('/api/news', createNewsRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    listNewsPosts,
    getNewsPost,
    createNewsPost,
    updateNewsPost,
    archiveNewsPost,
    markNewsRead,
    getNewsUnreadCount,
    listNewsCategories,
    createNewsCategory,
    updateNewsCategory,
    deleteNewsCategory,
  ));

  // N2 — media (adjuntos) + difundir al NOC de las Noticias. Router SEPARADO montado también
  // en /api/news; los paths son disjuntos del router principal por método + nº de segmentos
  // (ver comentario en newsMedia.routes.ts), así que el orden de montaje no importa. Reusa el
  // MISMO storage MinIO que task-photos (bucket compartido, prefijo lógico news/{postId}/) y
  // el motor N1 BroadcastToNoc (config leída del repo al momento de enviar).
  {
    const newsBroadcastConfigRepo = new PrismaNocBroadcastConfigRepository();
    const newsBroadcastGateway = new EvolutionApiHttpGateway({ configRepo: newsBroadcastConfigRepo });
    app.use('/api/news', createNewsMediaRouter(
      {
        attachFilesToNews: new AttachFilesToNews(newsAttachmentRepo, taskPhotoStorage, newsPostRepo),
        attachLinkToNews: new AttachLinkToNews(newsAttachmentRepo, newsPostRepo),
        getNewsAttachmentFile: new GetNewsAttachmentFile(newsAttachmentRepo, taskPhotoStorage),
        deleteNewsAttachment: new DeleteNewsAttachment(newsAttachmentRepo, taskPhotoStorage),
        broadcastNewsToNoc: new BroadcastNewsToNoc(
          newsPostRepo,
          new BroadcastToNoc(newsBroadcastConfigRepo, newsBroadcastGateway),
        ),
      },
      {
        authProvider: authAdapter,
        sessionRepo,
        requireRead: requirePerm('news', 'read'),
        requireManage: requirePerm('news', 'manage'),
      },
    ));
  }

  // IClass admin — SO type catalog sync + list (admin-only).
  app.use('/api/admin/iclass', createIClassAdminRouter(syncIClassSoTypes, listIClassSoTypes, authAdapter, sessionRepo, syncIClassNodes, listIClassNodeCatalog));

  // IClass closure loop — result-code catalog + configurable result→stage mapping + status + backfill.
  // NOTE: iclassResultCodeRepo was declared earlier (before the scheduling router) so
  // CloseIClassServiceOrder (Ola A) can use it. Reused here for the closure loop.
  const closedServiceOrderRepo = new PrismaClosedServiceOrderRepository();
  const closureIngest = new IngestClosedServiceOrders(
    buildIClassClient(),
    closedServiceOrderRepo,
    iclassResultCodeRepo,
    schedulingRepo,
    new PrismaSyncStateRepository(),
    // #41 — pass the activity recorder so a closure into a `hecho` stage emits the
    // System `status_changed` alongside generalStatus='closed' (REQ-GS-ICLASS-CLOSEDBY-FLOW-1).
    // iclass-status-sync — inject statusCatalog for auto-discovery on each ingest tick.
    { ...buildClosureSideEffects(), recorder: taskActivityRecorder, statusCatalog: iclassStatusCatalogRepo },
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
    sessionRepo,
  ));

  // iclass-status-sync — status catalog: GET /statuses, POST /statuses/sync, PATCH /statuses/:statusCode
  // Sub-resource routes are mounted BEFORE any catch-all to avoid route shadowing.
  app.use('/api/admin/iclass', createIClassStatusesRouter(
    new SyncIClassStatuses(buildIClassClient(), iclassStatusCatalogRepo),
    new ListIClassStatusCatalog(iclassStatusCatalogRepo),
    new UpdateIClassStatusCatalog(iclassStatusCatalogRepo),
    authAdapter,
    sessionRepo,
    requirePerm('iclass', 'read'),
    requirePerm('iclass', 'manage'),
  ));

  // iclass-os-actions (Ola B) — team catalog: GET /teams, POST /teams/sync
  app.use('/api/admin/iclass', createIClassTeamsRouter(
    new SyncIClassTeams(buildIClassClient(), iclassTeamRepo),
    new ListIClassTeams(iclassTeamRepo),
    authAdapter,
    sessionRepo,
    requirePerm('iclass', 'read'),
    requirePerm('iclass', 'manage'),
  ));

  // iclass-gps-audit — ubicación de cuadrillas + auditoría de presencia en sitio.
  // DOS permisos SEPARADOS: location_read (mapa en vivo, despacho) vs location_audit
  // (auditoría histórica, supervisión). El primero NO habilita el segundo.
  // Sólo se monta con credenciales de IClass configuradas: sin fuente de rastro la
  // feature no tiene de dónde leer, y montar rutas que siempre fallan confunde más
  // que ayudar.
  const teamLocationSource = buildTeamLocationSource();
  if (teamLocationSource) {
    const teamLocationRepo = new PrismaTeamLocationRepository();
    app.use('/api/technicians', createTechnicianLocationRouter({
      getTeamsLiveStatus: new GetTeamsLiveStatus({ repo: teamLocationRepo, source: teamLocationSource }),
      getTeamDailyJourney: new GetTeamDailyJourney({ repo: teamLocationRepo }),
      auditServiceOrderPresence: new AuditServiceOrderPresence({
        iclass: buildIClassClient(),
        repo: teamLocationRepo,
      }),
      listSuspiciousClosures: new ListSuspiciousClosures({ iclass: buildIClassClient() }),
      requireLocationRead: requirePerm('technicians', 'location_read'),
      requireLocationAudit: requirePerm('technicians', 'location_audit'),
      authProvider: authAdapter,
      // sessionRepo es OBLIGATORIO acá: sin él `createAuthMiddleware` cae al chequeo
      // legacy de JWT y la REVOCACIÓN DE SESIÓN no tiene efecto sobre estas rutas —
      // un ex-empleado seguiría viendo el GPS de todas las cuadrillas hasta 8 h.
      sessionRepo,
    }));
  }

  // iclass-ops-config (Ola A) — technician↔team mapping: GET /technician-teams, PATCH /technician-teams/:userId
  app.use('/api/admin/iclass', createIClassTechnicianTeamsRouter(
    listTechnicianTeamMappings,
    setTechnicianTeamMapping,
    authAdapter,
    sessionRepo,
    requirePerm('iclass', 'read'),
    requirePerm('iclass', 'manage'),
  ));

  // Mis clientes (Fase 2b) — agente↔vendedor (GR) mapping. Cross-agent admin surface.
  // GET /vendedor-mappings, PATCH /vendedor-mappings/:userId, GET /vendedores
  // Gated on recapture.assign (admin marker): el agente tiene manage, así que esta
  // superficie cross-agent NO puede gatearse en read/manage.
  app.use('/api/admin/gr', createGrVendedorMappingsRouter(
    new ListVendedorMappings(rbacUserRepo),
    new SetVendedorMapping(rbacUserRepo),
    new ListDistinctVendedores(contractRepo),
    authAdapter,
    sessionRepo,
    requirePerm('recapture', 'assign'),
  ));

  // iclass-ops-config (Ola C) — dispatch preview: GET /dispatch-preview (read-only)
  // Needs projectRepo — declared after the IClass wiring so we use a lazy reference.
  // projectRepo is used in Ola C only; it is declared earlier in the function.
  app.use('/api/admin/iclass', createIClassDispatchPreviewRouter(
    new GetIClassDispatchPreview(projectRepo),
    authAdapter,
    sessionRepo,
    requirePerm('iclass', 'read'),
  ));

  // Feature flags — runtime toggles persisted in DB.
  // GETs remain auth-only (reading flag state is harmless).
  // PATCH is guarded by admin.flags — only super_admin (*) can flip flags until
  // the operator assigns this permission to a role via the roles UI.
  // featureFlagRepo is created earlier (wired into SendTaskToIClass).
  app.use('/api/admin/feature-flags', createFeatureFlagsRouter(
    authAdapter,
    sessionRepo,
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
  const unlockRbacUserUC  = new UnlockRbacUser(rbacUserRepo);
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
      unlockUser: unlockRbacUserUC,
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
  // gigared-tv-cic-reuse — decide si un CIC del pool que carga la identidad de OTRO cliente
  // nuestro puede reutilizarse (cliente existe + tvCancelledAt seteado + sin fila de TV activa,
  // las 3 en UNA query). Sin esto inyectado, RegisterGigaredAccount degrada al filtro B1
  // original y NINGÚN cic reciclado se reutiliza: el alta queda rota con el CI en verde.
  // Pinneado por gigared-composition.cicReuse.test.ts.
  const gigaredCicReuseEligibility = new PrismaTvCicReuseEligibilityRepository();
  // #81 — TV reactivation seq repo (Client.tvActivationSeq). RegisterGigaredAccount lo incrementa
  // SOLO en re-alta para mintear un internal_id + mail frescos (nunca quemados). Mirror-only.
  const gigaredTvActivation = new PrismaClientTvActivationRepository();
  // #10/#11 — async TV-cancel status repo (Client.tvCancelStatus/tvCancelResult/tvCancelStartedAt).
  const gigaredTvCancelStatus = new PrismaClientTvCancelStatusRepository();
  // #5 BE — TV activation event repo (append-only log of alta/baja/reactivacion).
  const gigaredTvActivationEventRepo = new PrismaTvActivationEventRepository();
  const gigaredCancelTv = new CancelTv(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup, gigaredTvCancellation);
  // #5 BE — pass eventRepo to runner so it records 'baja' on success (best-effort).
  const gigaredCancelTvRunner = new CancelTvJobRunner(gigaredCancelTv, gigaredTvCancelStatus, gigaredTvActivationEventRepo);
  app.use('/api/gigared', createAuthMiddleware(authAdapter, sessionRepo), createGigaredRouter({
    getConfig:          new GetGigaredConfig(gigaredConfigRepo, featureFlagRepo),
    updateConfig:       new UpdateGigaredConfig(gigaredConfigRepo, featureFlagRepo),
    getSummary:         new GetGigaredSummary(gigaredClient),
    // gigared-tv-identity-hardening (D4/B7) — local-first owner resolution: resolves a
    // transferred account's clientId from the local managed ContractService row instead of
    // the partner's append-only alias (Centeno/Vacherand). Both deps optional; wiring them
    // here activates local-first for the operators' list.
    listAccounts:       new ListGigaredAccounts(gigaredClient, contractServiceRepo, serviceCatalogRepo),
    getCustomerAccount: new GetGigaredCustomerAccount(gigaredClient, gigaredCustomerLookup, gigaredTvCancellation),
    linkCustomerToCic:  new LinkCustomerToCic(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation),
    // #5 BE — pass eventRepo so register records 'alta'/'reactivacion' best-effort.
    // gigared-tv-cic-reuse — los 3 últimos son POSICIONALES: pick (undefined = Math.random en
    // prod), elegibilidad de reutilización de CICs y auditoría del cic reusado. El orden está
    // pinneado por gigared-composition.cicReuse.test.ts.
    registerAccount:    new RegisterGigaredAccount(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation, gigaredTvActivation, gigaredTvActivationEventRepo, undefined, gigaredCicReuseEligibility, auditEventRepo),
    // #131 PARTE B -- pass gigaredTvActivationEventRepo so AddTvService can record 'reactivacion' on row reuse.
    addTvService:       new AddTvService(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup, gigaredTvActivationEventRepo),
    removeTvService:    new RemoveTvService(gigaredClient, contractServiceRepo, serviceCatalogRepo, gigaredContractLookup, gigaredCustomerLookup),
    setOttStatus:       new SetOttStatus(gigaredClient, gigaredCustomerLookup),
    cancelTv:           gigaredCancelTv,
    changeTvPassword:   new ChangeTvPassword(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo),
    // #65 fix wave H3 — superficie dedicada para las credenciales (guard tv.register).
    getTvCredentials:   new GetTvCredentials(gigaredCustomerLookup, new PrismaTvCredentialsReader()),
    // service-transfer — transferencia de TV entre clientes (EPIC Titularidad F1). Mismas deps
    // compartidas del bloque + el singleton del historial (contractServiceEventRepo, ~1332) para
    // los eventos transfer-out/in en ambos contratos + (D7/B7) gigaredTvActivationEventRepo
    // (~2494, MISMO singleton que Register/Cancel) para el evento 'transferencia' en el
    // Historial TV global.
    transferTv:         new TransferTvToCustomer(gigaredClient, gigaredCustomerLookup, gigaredContractLookup, contractServiceRepo, serviceCatalogRepo, gigaredTvCancellation, contractServiceEventRepo, gigaredTvActivationEventRepo),
    requireRead:        requirePerm('tv', 'read'),
    // #50 — granular TV permissions (replace generic tv.write).
    requireLink:        requirePerm('tv', 'link'),
    requireRegister:    requirePerm('tv', 'register'),
    requirePacks:       requirePerm('tv', 'packs'),
    requireOtt:         requirePerm('tv', 'ott'),
    requireCancel:      requirePerm('tv', 'cancel'),
    requireTransfer:    requirePerm('tv', 'transfer'),
    requireManage:      requirePerm('tv', 'manage'),
    gigaredReady:       createGigaredReadyMiddleware(gigaredConfigRepo, featureFlagRepo),
    gigaredProbeReady:  createGigaredReadyMiddleware(gigaredConfigRepo, featureFlagRepo, { requireFlag: false }),
    // #10/#11 — async TV-cancel deps
    cancelTvRunner:     gigaredCancelTvRunner,
    cancelStatus:       gigaredTvCancelStatus,
    customerLookup:     gigaredCustomerLookup,
    contractLookup:     gigaredContractLookup,
    // #5 BE — TV activation history query use case
    listActivationHistory: new ListTvActivationHistory(gigaredTvActivationEventRepo),
  }));

  // ─── PPPoE management (#pppoe-service Fase B) + enforcement/cortes (Fase C) ───
  // El singleton `orchestrator` se crea más arriba (lo comparte el IP allocator / FindFreeIp).
  {
    const pppoeRepo   = new PrismaPppoeServiceRepository();
    const nasRepoForPppoe = new PrismaNasRepository();
    const routerGw    = new RouterOsGateway();
    const cutBatchRepo = new PrismaServiceCutBatchRepository();
    // Fase C — enforcement detrás del EnforcementGateway, RUTEADO per-NAS por `nas.type`:
    //   'radius_orchestrator' → RADIUS (orchestrator + CoA);  resto → MK-directo (/ppp secret + kick).
    // Hoy el ~97% de la red corta por MK-directo (cutover RADIUS ~nil); un NAS pasa a RADIUS
    // marcándose 'radius_orchestrator', sin big-bang. El orchestrator es opt-in (config.orchestrator):
    // si no está configurado, los NAS radius_orchestrator fallan al cortar con 502 claro, el resto sigue.
    const mkEnforcement = new RouterOsEnforcementAdapter(routerGw, config.router.reducedProfile);
    const radiusEnforcement = new OrchestratorEnforcementAdapter(orchestrator, config.router.reducedProfile);
    const enforcementGw = new PerNasEnforcementGateway(mkEnforcement, radiusEnforcement);
    // pppoe-corte-individual: RecordPppoeEnforceEvent logs reduced/blocked/restored events (best-effort).
    // Reuses the same PrismaServiceCatalogRepository and PrismaContractServiceEventRepository
    // already instantiated for ensureInternet (constructed below in the pppoe-contract-integrity block).
    // We construct it after ensureInternet to share the same repos — but enforce needs it first.
    // Solution: construct record-event inline here with dedicated repo instances (same Prisma model).
    const recordEnforceEvent = new RecordPppoeEnforceEvent(
      new PrismaServiceCatalogRepository(),
      new PrismaContractServiceEventRepository(),
    );
    const enforcePppoe = new EnforcePppoeService(pppoeRepo, enforcementGw, nasRepoForPppoe, recordEnforceEvent);
    const previewEnforcement = new PreviewEnforcement(pppoeRepo);
    const bulkEnforcement = new RunBulkEnforcement(pppoeRepo, enforcePppoe, cutBatchRepo, {
      throttleMs: config.router.bulkThrottleMs,
      routerConcurrency: config.router.bulkConcurrency,
    });
    const serviceCutRunner = new ServiceCutRunner(bulkEnforcement, cutBatchRepo, new PgAdvisoryLock());
    // pppoe-contract-integrity: helper de reconcile de la línea INTERNET (best-effort).
    // pppoe-baja-motivo: PrismaContractServiceEventRepository wired so baja/desasociar record the reason.
    const ensureInternet = new EnsureInternetContractService(
      new PrismaContractServiceRepository(),
      new PrismaServiceCatalogRepository(),
      new PrismaContractServiceEventRepository(),
    );
    // pppoe-full-management: CreatePppoeService extraído a variable para reusarlo como
    // delegate de CreatePppoeStandalone (C2d: camino con contractId = Guard #4 + activación + evento).
    // pppoe-preprovision (S1.4): findFreeIp (singleton del IP allocator) — sin él, la creación
    // con NAS radius sin pool-mode y sin IP degrada al estado cojo (framedIp null). Wiring
    // OBLIGATORIO (composition test q).
    const createPppoeSvc = new CreatePppoeService(pppoeRepo, routerGw, nasRepoForPppoe, orchestrator, ensureInternet, new PrismaServiceCatalogRepository(), new PrismaContractServiceEventRepository(), findFreeIp);
    // pppoe-move-nas W1: move radius-aware — reasigna IP del pool CGNAT del destino (findFreeIp,
    // singleton de arriba) + changeFramedIp + kick best-effort + registro DOBLE (PppoeNasMoveEvent
    // + evento 'modified' del historial del contrato). Subsume al legacy: NAS no-radius delega en
    // MovePppoeServiceToRouter (instancia compartida con la ruta back-compat).
    const legacyMovePppoe = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepoForPppoe);
    const nasMoveEventRepo = new PrismaPppoeNasMoveEventRepository();
    const movePppoeToNas = new MovePppoeToNas(
      pppoeRepo,
      nasRepoForPppoe,
      orchestrator,
      findFreeIp,
      legacyMovePppoe,
      nasMoveEventRepo,
      new PrismaServiceCatalogRepository(),
      new PrismaContractServiceEventRepository(),
      // fix wave 1 (ajuste 6): clasifica la IP actual contra los pools cargados (IpPool.ipKind) —
      // guard de IP PÚBLICA: 409 PPPOE_MOVE_PUBLIC_IP sin `force: true`.
      ipNetworkRepo,
    );
    // pppoe-terminate-callerid: baja HARD (deleteUser RADIUS) — extraído a variable porque
    // service-transfer (W2) COMPONE esta MISMA instancia dentro de TransferPppoe (recreate:
    // crear con createPppoeSvc PRIMERO, borrar el viejo con terminatePppoeSvc DESPUÉS).
    const terminatePppoeSvc = new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepoForPppoe, ensureInternet);
    // service-transfer (W2): POST /pppoe/:id/transfer — as-is (setContractId puro) | recreate
    // (compone createPppoeSvc + terminatePppoeSvc, las instancias singleton del bloque).
    // Lookup de contrato con clientId + nombre del cliente para el snapshot de los eventos.
    const transferPppoe = new TransferPppoe(
      pppoeRepo,
      { findById: (id: string) => prismaContractClientNameLookup(id) },
      createPppoeSvc,
      terminatePppoeSvc,
      ensureInternet,
      new PrismaServiceCatalogRepository(),
      new PrismaContractServiceEventRepository(),
    );
    app.use('/api', createPppoeRouter(
      authAdapter,
      sessionRepo,
      requirePerm,
      new ListPppoeByContract(pppoeRepo),
      createPppoeSvc,
      // pppoe-move-ip-kind-aware: `findFreeIp` inyectado para AUTO-ASIGNAR la IP cuando el
      // operador cambia la clase sin dar IP nueva. Sin este argumento la feature queda MUERTA en
      // prod aunque los tests pasen (los tests inyectan su propio wiring) — lección W6 del EPIC #38.
      new UpdatePppoeService(pppoeRepo, routerGw, nasRepoForPppoe, orchestrator, new PrismaServiceCatalogRepository(), new PrismaContractServiceEventRepository(), findFreeIp),
      legacyMovePppoe,
      new DeactivatePppoeService(pppoeRepo, routerGw, nasRepoForPppoe, orchestrator, ensureInternet),
      enforcePppoe,
      previewEnforcement,
      serviceCutRunner,
      cutBatchRepo,
      // Adopción del inventario — comparte el singleton `orchestrator` (listUsers vía GET /users).
      // exclusionPatterns filtra usernames placeholder (accesosurN) del ingest y del listado.
      new IngestPppoeFromNas(pppoeRepo, nasRepoForPppoe, orchestrator, config.pppoe.ingestExcludePatterns),
      new AssociatePppoeToContract(pppoeRepo, ensureInternet, new PrismaServiceCatalogRepository(), new PrismaContractServiceEventRepository()),
      new GetPppoeCredentials(pppoeRepo),
      new ListUnassignedPppoe(pppoeRepo, config.pppoe.ingestExcludePatterns),
      new DeassociatePppoeFromContract(pppoeRepo, ensureInternet),
      // pppoe-terminate-callerid: baja HARD (deleteUser RADIUS) + caller-id desde sesión activa.
      // service-transfer (W2): instancia compartida con TransferPppoe (ver arriba).
      terminatePppoeSvc,
      new GetPppoeCallerId(pppoeRepo, orchestrator),
      // internet-history — vista GLOBAL de servicios de internet (espejo de la página de TV).
      // pppoe-full-management: se pasa nasRepoForPppoe para enriquecer nasName/nasType en el DTO.
      new ListAllPppoeServices(pppoeRepo, new PrismaContractServiceEventRepository(), new PrismaServiceCatalogRepository(), nasRepoForPppoe),
      // internet-history-plan-direction — PrismaPlanRepository para derivar upgrade/downgrade por kbps.
      new ListInternetServiceHistory(new PrismaContractServiceEventRepository(), new PrismaServiceCatalogRepository(), new PrismaPlanRepository()),
      new ListInternetActivationOperators(new PrismaContractServiceEventRepository(), new PrismaServiceCatalogRepository()),
      // pppoe-full-management: creación standalone (contrato opcional) + rename seguro.
      // C2b: routerGw para NAS mikrotik_api · C2d: createPppoeSvc delegate para el camino con contractId.
      // pppoe-preprovision (S1.4): findFreeIp — mismo allocator server-side que CreatePppoeService.
      new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepoForPppoe, routerGw, createPppoeSvc, findFreeIp),
      // fix-wave-2 (CRITICAL): nasRepoForPppoe para el guard de tipo de NAS + radiusEnforcement
      // (OrchestratorEnforcementAdapter directo, NO el PerNasEnforcementGateway) para re-aplicar
      // corte/reducción. El rename es un flujo SOLO-RADIUS; el guard valida que el NAS sea
      // radius_orchestrator antes de tocar el plano de control. Con enforcementGw (el gateway
      // per-NAS compuesto), pasar {} as NasServer ruteaba a RouterOsEnforcementAdapter → 500.
      new RenamePppoeUsername(pppoeRepo, orchestrator, nasRepoForPppoe, radiusEnforcement),
      // pppoe-move-nas W1: POST /pppoe/:id/move usa el move radius-aware; sin esto la ruta
      // caería al legacy pre-HA (IP rota en el nodo nuevo) — wiring OBLIGATORIO (lección W6).
      movePppoeToNas,
      // pppoe-move-nas W1: GET /pppoe/nas-move-events (tab "Movimientos NAS" de la auditoría).
      new ListPppoeNasMoveEvents(nasMoveEventRepo, nasRepoForPppoe),
      // pppoe-search-bulk-plan: bulk plan change — POST /api/pppoe/bulk/change-plan.
      // ChangePppoePlanService compartido entre UpdatePppoeService y BulkChangePppoePlan.
      new BulkChangePppoePlan(
        pppoeRepo,
        new PrismaPlanRepository(),
        nasRepoForPppoe,
        new ChangePppoePlanService(
          pppoeRepo,
          routerGw,
          nasRepoForPppoe,
          orchestrator,
          new PrismaServiceCatalogRepository(),
          new PrismaContractServiceEventRepository(),
        ),
      ),
      // pppoe-bulk-select-filter (v2): GET /api/pppoe/ids — ids del filtro activo para la
      // selección masiva del bulk. Sin wired la ruta no se monta (feature muerta, lección W6).
      new ListAllPppoeServiceIds(pppoeRepo),
      // service-transfer (W2): POST /api/pppoe/:id/transfer (gate pppoe.transfer). Sin wired
      // la ruta no se monta y la feature queda muerta (lección W6 — composition test).
      transferPppoe,
    ));

    // ─── smartolt-provision (K2) — aprovisionamiento de ONUs fibra Huawei ─────
    // Vive DENTRO del bloque PPPoE a propósito: comparte pppoeRepo + createPppoeSvc
    // (la pre-provisión K1 es LA MISMA instancia de lógica que usa el ingest).
    // Opt-in: sin SMARTOLT_BASE_URL/SMARTOLT_API_TOKEN las rutas devuelven 503
    // SMARTOLT_NOT_CONFIGURED; el ON/OFF runtime va por el flag 'fiber-auto-provision'
    // (seed OFF, chequeado POR REQUEST). SIN cron — todo botón-driven.
    {
      const smartoltConfigured =
        config.smartolt.baseUrl !== '' && config.smartolt.token !== '';
      const smartoltGateway = new SmartOltHttpGateway({
        baseUrl: config.smartolt.baseUrl,
        token: config.smartolt.token,
        timeoutMs: config.smartolt.timeoutMs,
        stepPauseMs: config.smartolt.stepPauseMs,
      });
      const smartOltOltConfigRepo = new PrismaSmartOltOltConfigRepository();
      // GR client best-effort para el username PPPoE histórico (mismo rol que en
      // bootstrapGestionRealIngest): sin credenciales GR falla AL USARSE y
      // PregenInstallPppoe cae al username generado — jamás bloquea.
      const grClientForFiber = new GestionRealClient({
        baseUrl: config.gestionReal.baseUrl,
        cuit: config.gestionReal.cuit,
        secret: config.gestionReal.secret,
      });
      const pregenForFiber = new PregenInstallPppoe(pppoeRepo, createPppoeSvc, grClientForFiber);
      const provisionFiberOnu = new ProvisionFiberOnu(
        smartoltGateway,
        smartOltOltConfigRepo,
        { findById: (id: string) => prismaFiberContractLookup(id) },
        pppoeRepo,
        pregenForFiber,
        new PrismaGestionRealIngestConfigRepository(),
        prismaFiberInstallTaskWriter,
      );
      app.use('/api/fiber', createFiberRouter(
        authAdapter,
        sessionRepo,
        requirePerm,
        featureFlagRepo,
        smartoltConfigured,
        new ListUnconfiguredOnus(smartoltGateway, smartOltOltConfigRepo),
        provisionFiberOnu,
        new ListSmartOltOlts(smartOltOltConfigRepo),
        new UpdateSmartOltOlt(smartOltOltConfigRepo),
      ));
    }
  }

  // ─── add-by-pppoe — inspección SSH de antena airOS ────────────────────────
  // Monta GET /api/contracts/:contractId/inspect-pppoe-devices (inventory.write).
  // best-effort: si la antena está offline o las credenciales fallan, retorna 200 + warnings.
  // El singleton `orchestrator` ya está instanciado arriba (shared con PPPoE).
  {
    const airOsGateway = new Ssh2AirOsGateway({
      user: config.airos.user,
      passwords: config.airos.passwords,
    });
    const pppoeRepoForInspect = new PrismaPppoeServiceRepository();
    app.use('/api', createInspectPppoeDevicesRouter(
      new InspectPppoeDevices(pppoeRepoForInspect, orchestrator, airOsGateway),
      authAdapter,
      sessionRepo,
      requirePerm,
    ));
  }

  // ─── #80 Recaptación ───────────────────────────────────────────────────────
  const recaptureRepo = new PrismaRecaptureRepository();
  // recapture-assignable-roles: assignee-pool enforcement (BE half of the double
  // guard). Resolves a user's role CODES so AssignRecaptureLead(sBulk) can reject
  // targets that are role-less or technical. Satisfies UserRoleLookup by mapping
  // RbacUserRepository.listRolesForUser → codes.
  const roleLookupForRecapture = {
    listRoleCodes: async (id: string): Promise<string[]> => {
      const roles = await rbacUserRepo.listRolesForUser(id);
      return roles.map((r) => r.code);
    },
  };
  const hasRecaptureAssign = async (userId: string): Promise<boolean> => {
    if (!userId) return false; // fail-closed: Prisma trata undefined como "sin filtro" y devolveria perms de todos
    const roles = await rbacUserRepo.listRolesForUser(userId);
    if (roles.some((r) => r.code === 'super_admin')) return true;
    const perms = await rbacUserRepo.listPermissionsForUser(userId);
    return perms.some((p) => p.moduleCode === 'recapture' && p.action === 'assign');
  };
  app.use('/api/recapture', createRecaptureRouter(
    new ListRecaptureLeads(recaptureRepo, contractRepo, customerAdapter),
    new GetRecaptureLead(recaptureRepo, customerAdapter, contractRepo),
    new UpdateRecaptureLeadStatus(recaptureRepo),
    new AddRecaptureContact(recaptureRepo),
    new IngestChurnedClients(recaptureRepo, customerAdapter, contractRepo),
    new ImportCsvLeads(recaptureRepo),
    new AssignRecaptureLead(recaptureRepo, userLookupForScheduling, roleLookupForRecapture),
    new AssignRecaptureLeadsBulk(recaptureRepo, userLookupForScheduling, roleLookupForRecapture),
    hasRecaptureAssign,
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      read:   requirePerm('recapture', 'read'),
      manage: requirePerm('recapture', 'manage'),
      assign: requirePerm('recapture', 'assign'),
    },
  ));

  // ─── Acciones (actions-worklist W2) — worklist de titularidad + bajas recientes ─
  {
    const ownershipCaseRepo = new PrismaOwnershipCaseRepository();
    // Reader compartido: findRecentBajas para el listado + getContract como
    // ContractOwnershipLookup estructural del set-target (H1b, design §5).
    const actionsPairingReader = new PrismaContractPairingReader();
    // Nombres de cliente para el DTO (source/target/candidates) — patrón F1.
    const actionsClientNameLookup = { findById: (id: string) => prismaClientLookup('Client', id) };
    app.use('/api/actions', createActionsRouter(
      new ListOwnershipCases(
        ownershipCaseRepo,
        new PrismaClientTvCancellationRepository(),
        new PrismaContractServiceRepository(),
        new PrismaServiceCatalogRepository(),
        new PrismaPppoeServiceRepository(),
        new PrismaContractInventoryRepository(),
        actionsClientNameLookup,
        // userLookupForScheduling resuelve el NOMBRE del reviewer manual (RbacUser).
        userLookupForScheduling,
      ),
      new UpdateOwnershipCase(ownershipCaseRepo, actionsPairingReader),
      new ListRecentBajas(
        actionsPairingReader,
        new PrismaRetirementOrderReader(),
        new PrismaContractInventoryRepository(),
        actionsClientNameLookup,
      ),
      createAuthMiddleware(authAdapter, sessionRepo),
      {
        read:   requirePerm('actions', 'read'),
        manage: requirePerm('actions', 'manage'),
      },
    ));
  }

  // ─── NOC Alerts Hub (noc-alerts-hub, Fase A) — dark launch, ver design.md ──────
  // Heavy wiring (repo/use-cases/publisher no-op) vive en composeAlertsModule()
  // (evita inflar este God Object — design.md "File Changes" ⚠).
  app.use('/api/alerts', composeAlertsModule({ authAdapter, sessionRepo, requirePerm, auditEventRepo }));

  // ─── ai-assistant-multiagent — CONFIGURACIÓN del asistente IA conversacional ────
  // Sólo la config (perfiles/intenciones/catálogos). El MOTOR se engancha aparte en
  // ReceiveChatwootWebhook (Batch 6) y arranca apagado por el flag `ai-assistant-enabled`:
  // así la configuración puede estar viva y editándose con el bot completamente mudo.
  app.use('/api/assistant', composeAssistantModule({ authAdapter, sessionRepo, requirePerm }));

  // ─── messaging-inbox (F1) — Chatwoot webhook ingest + inbox reads/send ───────
  {
    const conversationRepo = new PrismaConversationRepository();
    // conversation-labels (Ola 5) — catálogo de etiquetas (calco de ticketAreaRepo).
    const conversationLabelRepo = new PrismaConversationLabelRepository();
    const chatMessageRepo = new PrismaChatMessageRepository();
    const webhookDeliveryRepo = new PrismaWebhookDeliveryRepository();
    // conversation-events (Ola 2) — historial append-only de transiciones (cimiento de los reports).
    const conversationEventRepo = new PrismaConversationEventRepository();
    // note-mentions (Ola 6b) — @menciones en notas internas (registro + vista "Menciones").
    const conversationMentionRepo = new PrismaConversationMentionRepository();
    // Opt-in config (design §9): if CHATWOOT_* is unset the gateway still builds, but
    // any call fails with ChatwootUnavailableError (503) — boot NEVER fails for this.
    const chatwootGateway = new HttpChatwootGateway({
      baseUrl: config.chatwoot.baseUrl,
      accountId: config.chatwoot.accountId,
      inboxId: config.chatwoot.inboxId,
      apiToken: config.chatwoot.apiToken,
    });
    // messaging-inbox-v2-media (Tanda 1) — recibir media entrante. Reusa la MISMA
    // instancia `taskPhotoStorage` (MinIO) de task-photos (bucket compartido, prefijo
    // 'messaging/' aísla lógicamente — Decisión 1 del proposal). El trigger dispara
    // fire-and-forget tras el 200 del webhook/fetch-on-open; ChatMediaDownloadScheduler
    // (bootstrapChatMediaDownload, main.ts) es la red de reintento.
    const chatAttachmentRepo = new PrismaChatMessageAttachmentRepository();
    const downloadChatMessageAttachment = new DownloadChatMessageAttachment(
      chatAttachmentRepo,
      chatMessageRepo,
      chatwootGateway,
      taskPhotoStorage,
    );
    const chatMediaDownloadTrigger = new FireAndForgetChatMediaDownloadTrigger(downloadChatMessageAttachment);
    const getChatAttachmentFile = new GetChatAttachmentFile(chatAttachmentRepo, taskPhotoStorage);
    const getClientContextByPhone = new GetClientContextByPhone(customerAdapter);
    // messaging-inbox-v2 (F1.5, B5) — `pppoeRepo` (PPPoE management block, line ~2242)
    // is already out of scope here (its enclosing `{ }` closed above), same gotcha
    // documented for `pppoeRepoForInspect`. A fresh, scope-local instance follows
    // that exact pattern instead of hoisting the earlier one.
    const pppoeRepoForInboxContext = new PrismaPppoeServiceRepository();
    const getInboxClientContext = new GetInboxClientContext(
      conversationRepo,
      getClientContextByPhone,
      customerAdapter,
      getContracts,
      getInvoices,
      getLogs,
      listTickets,
      ticketAdapter,
      listTasks,
      new ListPppoeByContract(pppoeRepoForInboxContext),
      balanceRefresh,
      // fix-be #1 — sin esto, GetInboxClientContext usaba el default hardcoded
      // (DEFAULT_BALANCE_STALE_TTL_MINUTES=60) en vez del TTL configurado, que ya
      // es el mismo que consumen PrismaCustomerRepository/RefreshClientBalanceIfStale.
      { ttlMinutes: config.gestionReal.balanceStaleTtlMinutes },
    );

    // inbox-template-send (D7) — gateway Twilio PROPIO de este bloque (mismo
    // config.twilio.*), self-contained, precedente del bloque templates-CRUD
    // (línea ~2659): evita interleave con el bloque bulk en merges paralelos.
    const sendTemplateGateway = new TwilioContentGateway({
      accountSid: config.twilio.accountSid,
      authToken: config.twilio.authToken,
      messagingServiceSid: config.twilio.messagingServiceSid,
    });
    // chatwoot-hub-sendpath (D1/D10, B6) — flag repo scope-local a ESTE bloque (molde
    // de los bootstraps de scheduling): NO reusa el `featureFlagRepo` de IClass
    // dispatch (línea ~1191, otro flag) ni comparte instancia con el bloque bulk
    // (`featureFlagRepoForBulk`, más abajo) — precedente anti-interleave de
    // inbox-template-send. SIEMPRE se cablea JUNTO con `chatwootGateway` (línea
    // ~2825, MISMA instancia que ya consumen GetConversation/SendMessage) en
    // SendTemplateMessage — flag ON sin gateway sería comportamiento indefinido
    // (riesgo pineado por el composition-root test de abajo).
    const featureFlagRepo = new PrismaFeatureFlagRepository();

    // ─── ai-assistant-multiagent (T6.3) — MOTOR del asistente IA ────────────────
    // Se construye ANTES del router porque se inyecta como 8º arg de
    // `ReceiveChatwootWebhook`. Arranca MUDO: el flag `ai-assistant-enabled` viene en
    // false desde la migración y cada perfil nace apagado.
    // ⚠️ Sin esta línea, el motor existiría pero NADIE lo llamaría — exactamente el bug W6
    // del EPIC #38 (rutas cableadas, hook nunca inyectado, CI verde, feature muerta en prod).
    // Pineado por `assistant-composition.test.ts`.
    const assistantEngine = composeAssistantEngine({
      conversationRepo,
      customerRepo: customerAdapter,
      chatwootGateway,
      sendMessage: new SendMessage(conversationRepo, chatMessageRepo, chatwootGateway, chatAttachmentRepo, chatMediaDownloadTrigger, conversationMentionRepo, userLookupForScheduling),
      setConversationArea: new SetConversationArea(conversationRepo, ticketAreaRepo, conversationEventRepo),
      setConversationStatus: new SetConversationStatus(conversationRepo, chatwootGateway, conversationEventRepo),
      listTasks,
      threadReader: new ChatMessageThreadReader(chatMessageRepo),
      clientResolver: new CustomerAssistantClientResolver(customerAdapter, customerAdapter),
    });

    app.use('/api/messaging', createMessagingRouter(
      // messaging-bulk (F2, Batch 6, OPT-2) — 6º arg `customerAdapter` (opcional):
      // ya implementa `CampaignSegmentSource & OptOutRegistry` (misma instancia
      // que el resto del BE) — habilita la detección BAJA/STOP inbound. Sin esto
      // el opt-out inbound queda MUERTO en prod (lección W6).
      // conversation-events (Ola 2) — 7º arg `conversationEventRepo`: registra 'created'
      // (actor null) y resolved/reopened Chatwoot-driven, best-effort.
      // ai-assistant-multiagent (RUN-2) — 8º arg `assistantEngine`: dispara el bot en rama
      // AISLADA tras espejar el mensaje. Mudo hasta que se prenda el flag.
      new ReceiveChatwootWebhook(conversationRepo, chatMessageRepo, webhookDeliveryRepo, chatAttachmentRepo, chatMediaDownloadTrigger, customerAdapter, conversationEventRepo, assistantEngine),
      new ListConversations(conversationRepo),
      new GetConversation(conversationRepo, chatMessageRepo, chatwootGateway, getClientContextByPhone, chatAttachmentRepo, chatMediaDownloadTrigger),
      new ListChatMessages(conversationRepo, chatMessageRepo, chatAttachmentRepo),
      // messaging-inbox-v2-media (Tanda 2 · BE4, fix-be #1 re-diseño) — `chatAttachmentRepo`
      // (línea ~2501) y `chatMediaDownloadTrigger` (línea ~2508) YA existen — mismas
      // instancias que el camino de RECEPCIÓN de Tanda 1, sin infra nueva. `SendMessage`
      // ya NO recibe `taskPhotoStorage` directo (nunca escribe un buffer local a MinIO
      // — deja la fila `pending` y dispara el trigger, igual que webhook/fetch-on-open).
      // note-mentions (Ola 6b) — 6º/7º args: registra @menciones de la nota interna
      // (BEST-EFFORT). `userLookupForScheduling` valida que el userId del token EXISTA
      // (RbacUser) antes de registrar — mismas instancias reusadas, sin infra nueva.
      new SendMessage(conversationRepo, chatMessageRepo, chatwootGateway, chatAttachmentRepo, chatMediaDownloadTrigger, conversationMentionRepo, userLookupForScheduling),
      // messaging-inbox-productivity (F1.5 fase C, STATUS-1) — resolver/reabrir/marcar
      // pendiente. Mismas instancias de conversationRepo/chatwootGateway, sin infra nueva.
      // conversation-events (Ola 2) — 3er arg: registra resolved/reopened + resolvedAt/firstResolvedAt.
      new SetConversationStatus(conversationRepo, chatwootGateway, conversationEventRepo),
      getInboxClientContext,
      getChatAttachmentFile,
      createChatwootSignatureMiddleware(),
      createAuthMiddleware(authAdapter, sessionRepo),
      {
        read: requirePerm('messaging', 'read'),
        send: requirePerm('messaging', 'send'),
      },
      // fix-be #2 [ALTO] — rate-limiter dedicado al envío con adjuntos (DoS: sin
      // esto, memoryStorage permitía hasta 1GB en RAM por request sin ningún techo
      // sobre cuántos requests puede sostener un mismo agente).
      createMessagingSendRateLimiter(),
      // F1.5-C2 (asignación) — LOCAL-only: assigneeId/areaId nunca se sincronizan a
      // Chatwoot. `userLookupForScheduling` (línea ~978) y `roleLookupForRecapture`
      // (línea ~2418) son reusados tal cual (mismas instancias que scheduling/
      // recapture) — sin duplicar wiring. `ticketAreaRepo`/`listTicketAreas` (línea
      // ~1081) también son las MISMAS instancias que /api/tickets/areas.
      // conversation-events (Ola 2) — 3er arg: registra assigned/unassigned / area_changed.
      new AssignConversation(conversationRepo, userLookupForScheduling, conversationEventRepo),
      new SetConversationArea(conversationRepo, ticketAreaRepo, conversationEventRepo),
      new ListAssignableUsers(rbacUserRepo, roleLookupForRecapture),
      listTicketAreas,
      // inbox-template-send (HTTP-1/HTTP-2) — appended (design §Colisiones: nunca
      // insertar en medio de la lista compartida con inbox-resolve).
      new SendTemplateMessage(conversationRepo, sendTemplateGateway, chatMessageRepo, chatwootGateway, featureFlagRepo),
      new ListMessagingTemplates(sendTemplateGateway),
      // inbox-views (Ola 1) — contadores por vista (GET /conversations/counts),
      // misma instancia conversationRepo (el count comparte el builder del where
      // con el listado — una sola fuente de verdad). Appended (regla §Colisiones).
      new GetInboxViewCounts(conversationRepo),
      // messaging-inbox-notes (edit/delete) — editar/soft-delete una nota interna
      // (misma instancia chatMessageRepo que el resto del bloque). `attachMessagingManage`
      // resuelve `req.messagingCanManage` (supervisor = messaging:manage) contra el mismo
      // rbacUserRepo que usa requirePerm. Appended (regla §Colisiones).
      new EditInternalNote(chatMessageRepo),
      new DeleteInternalNote(chatMessageRepo),
      attachMessagingManage(rbacUserRepo),
      // conversation-labels (Ola 5) — set del set de labels de una conversación
      // (LOCAL-only, gate messaging:send). Appended (regla §Colisiones). Misma
      // instancia conversationRepo + el catálogo conversationLabelRepo.
      new SetConversationLabels(conversationRepo, conversationLabelRepo),
      // previous-conversations (Ola 6a) — lista de conversaciones previas del
      // contacto para el panel de contexto (GET /conversations/:id/previous, gate
      // messaging:read). Misma instancia conversationRepo (reusa la clave E164
      // canónica del contador convo-count). Appended (regla §Colisiones).
      new ListPreviousConversations(conversationRepo),
      // note-mentions (Ola 6b) — marca leídas las @menciones del user actual en una
      // conversación (POST /conversations/:id/mentions/read, gate messaging:read). Appended
      // (regla §Colisiones). Mismas instancias conversationRepo + conversationMentionRepo.
      new MarkConversationMentionsRead(conversationRepo, conversationMentionRepo),
      // conversation-snooze (Ola 6c) — posponer (gate messaging:send). Appended
      // (regla §Colisiones). Mismas instancias conversationRepo/chatwootGateway; 3er arg
      // conversationEventRepo registra el evento 'snoozed' (best-effort, Ola 2).
      new SnoozeConversation(conversationRepo, chatwootGateway, conversationEventRepo),
    ));

    // conversation-labels (Ola 5) — CRUD del catálogo /api/messaging/labels (router
    // dedicado, molde ticketAreas.routes.ts). GET → messaging:read; POST/PUT/DELETE →
    // messaging:manage. Path propio, no colisiona con el router principal /api/messaging
    // (que no tiene ruta /labels; /conversations/:id/labels vive en otro subpath).
    app.use('/api/messaging/labels', createMessagingLabelsRouter(
      authAdapter,
      sessionRepo,
      requirePerm,
      new ListLabels(conversationLabelRepo),
      new CreateLabel(conversationLabelRepo),
      new UpdateLabel(conversationLabelRepo),
      new DeleteLabel(conversationLabelRepo),
    ));

    // ─── conversation-events (Ola 2) — reports de agregación (cimiento del dashboard Ola 3) ─
    // Router SEPARADO montado en `/api/messaging/reports` DESPUÉS del principal (que no
    // matchea `/reports/*` → cae acá, mismo patrón que `/bulk`). Gateado por `messaging:read`.
    app.use('/api/messaging/reports', createMessagingReportsRouter(
      new GetReportsOverview(conversationRepo, conversationEventRepo, new GetInboxViewCounts(conversationRepo)),
      new GetTrafficReport(chatMessageRepo),
      new GetResolutionsReport(conversationEventRepo),
      createAuthMiddleware(authAdapter, sessionRepo),
      { read: requirePerm('messaging', 'read') },
    ));
  }

  // ─── messaging-bulk (F2) — envío masivo por template WhatsApp (Twilio directo) ─
  // Prefijo REAL `/api/messaging/bulk` (spec manda, tasks.md contradicción #1 —
  // el prefijo `/api/messaging/campaigns` de design §7 NO se usa).
  {
    const templatePort = new TwilioContentGateway({
      accountSid: config.twilio.accountSid,
      authToken: config.twilio.authToken,
      messagingServiceSid: config.twilio.messagingServiceSid,
    });
    const campaignRepo = new PrismaCampaignRepository();
    const rateLimiter = new TokenBucketRateLimiter({ ratePerSec: config.messagingBulk.ratePerSec });
    // messaging-bulk-inbox (F1) — el projector compone los repos F1 (Conversation/
    // ChatMessage, instancias scope-local, mismo patrón que pppoeRepoForInboxContext)
    // + campaignRepo, para que el bulk deje rastro en el inbox. Sin esto la proyección
    // queda MUERTA en prod (lección W6): SendCampaign lo recibe como 5º arg.
    const campaignInboxProjector = new PrismaCampaignInboxProjector(
      new PrismaConversationRepository(),
      new PrismaChatMessageRepository(),
      campaignRepo,
    );
    // chatwoot-hub-sendpath (D1/D2.b, B6) — gateway Chatwoot self-contained del
    // bloque bulk (mismo precedente que el gateway Twilio propio de la línea
    // ~2987): evita interleave con el bloque messaging en merges paralelos. Flag
    // repo también scope-local — SIEMPRE cableado JUNTO con
    // `chatwootGatewayForBulk` (nunca uno sin el otro, mismo riesgo que el bloque
    // messaging).
    const chatwootGatewayForBulk = new HttpChatwootGateway({
      baseUrl: config.chatwoot.baseUrl,
      accountId: config.chatwoot.accountId,
      inboxId: config.chatwoot.inboxId,
      apiToken: config.chatwoot.apiToken,
    });
    const featureFlagRepoForBulk = new PrismaFeatureFlagRepository();
    // bulk-task-recipients (D2, D6, B6) — adapters Prisma del 5to dominio de
    // destinatarios ("Tarea"), scope-local al bloque bulk (mismo precedente
    // que `chatwootGatewayForBulk`/`featureFlagRepoForBulk`): instancia PROPIA,
    // NO comparte variable con el bloque de config nuevo de abajo (anti-interleave
    // en merges paralelos). El repo/source son stateless — cualquiera de las 2
    // instancias es funcionalmente equivalente.
    const taskRecipientSource = new PrismaTaskRecipientSource();
    const taskStageConfigRepo = new PrismaTaskStageRecipientConfigRepository();
    // bulk-task-stage-transition — config del estado resultante global (snapshot al create)
    // + el port de transición que reusa el `moveTaskToStage` (línea ~1963) ya wireado con
    // recorder (rastro `stage_changed` en el feed) y el sendTaskToIClass (aunque el guard
    // anti-send_to_iclass del port lo bloquea como destino).
    const taskStageTransitionConfigRepoForBulk = new PrismaTaskStageTransitionConfigRepository();
    const taskTransition = new TransitionTaskAfterSend(schedulingRepo, stageRepo, moveTaskToStage);
    // customerAdapter (línea ~872) YA implementa CampaignSegmentSource +
    // CampaignRecipientLookup (Batch 6) — misma instancia, sin duplicar wiring.
    // `backoffOpts` (6º arg) explícito `undefined`; `taskTransition` es el 9º arg (TRANS-1).
    const sendCampaign = new SendCampaign(campaignRepo, customerAdapter, templatePort, rateLimiter, campaignInboxProjector, undefined, chatwootGatewayForBulk, featureFlagRepoForBulk, taskTransition);
    const campaignRunner = new CampaignRunner(sendCampaign, campaignRepo, new PgAdvisoryLock());

    // bulk-granular-perms — resuelve las acciones `messaging` del usuario (o
    // ['*'] si super_admin) desde el MISMO rbacUserRepo que usa requirePerm.
    // Molde `hasRecaptureAssign`. Fail-closed: sin userId → set vacío (bloquea).
    const resolveBulkActions = async (userId: string): Promise<string[]> => {
      if (!userId) return [];
      const roles = await rbacUserRepo.listRolesForUser(userId);
      if (roles.some((r) => r.code === 'super_admin')) return ['*'];
      const perms = await rbacUserRepo.listPermissionsForUser(userId);
      // F3 (defense-in-depth) — el sentinel '*' SOLO debe venir de la rama
      // super_admin de arriba; un action literal '*' (VarChar sin constraint) en
      // la DB NO debe conceder bypass total a un no-super-admin.
      return perms
        .filter((p) => p.moduleCode === 'messaging')
        .map((p) => p.action)
        // cast a string: `PermissionAction` (union tipado) nunca incluye '*', pero la
        // columna es VarChar sin constraint → en runtime un action '*' SÍ es posible.
        .filter((a) => (a as string) !== BULK_SUPER_ADMIN_SENTINEL);
    };

    app.use('/api/messaging/bulk', createMessagingBulkRouter(
      new ListMessagingTemplates(templatePort),
      // manual-recipients (MAN-5) — customerAdapter también implementa
      // ManualRecipientSource (misma instancia): el preview cuenta la unión
      // segmento ∪ lista manual cuando el composer la pasa.
      // bulk-task-recipients (D3/D5, B6) — 2 args OPCIONALES más AL FINAL
      // (taskRecipientSource/taskStageConfigRepo, 5to dominio "Tarea").
      new PreviewCampaignSegment(customerAdapter, customerAdapter, taskRecipientSource, taskStageConfigRepo, taskStageTransitionConfigRepoForBulk),
      // v1.1 (preview modal paginado) + bulk-csv-recipients (DET-1, cierra deuda
      // F4) — reusa customerAdapter (misma instancia que PreviewCampaignSegment,
      // ya implementa CampaignSegmentSource + ManualRecipientSource), sin infra nueva.
      // bulk-task-recipients (D3/D5, B6) — mismos 2 args opcionales al final.
      new ListSegmentRecipients(customerAdapter, customerAdapter, taskRecipientSource, taskStageConfigRepo),
      // 4 args — templatePort (CAMP-2, valida templateRef aprobado) +
      // manual-recipients (MAN-1): customerAdapter como ManualRecipientSource
      // (misma instancia) resuelve la lista manual combinable con el segmento.
      // bulk-task-recipients (D3/D5, B6) — mismos 2 args opcionales al final.
      new CreateCampaign(campaignRepo, customerAdapter, templatePort, customerAdapter, taskRecipientSource, taskStageConfigRepo, taskStageTransitionConfigRepoForBulk),
      campaignRunner,
      new GetCampaign(campaignRepo),
      new ListCampaigns(campaignRepo),
      createAuthMiddleware(authAdapter, sessionRepo),
      {
        bulk: requirePerm('messaging', 'bulk'),
        templates: requirePerm('messaging', 'templates'),
        // campaign-chatwoot-label (D5.c, CLBL-7) — tier supervisor, reusa el
        // MISMO permiso que ya gobierna canned-responses/config/catálogo local
        // de ConversationLabel (cero seed nuevo).
        manage: requirePerm('messaging', 'manage'),
      },
      // bulk-granular-perms — re-chequeo en el envío (lee el snapshot de la campaña)
      // + resolver de acciones del usuario (APPENDED, no rompe el gate perms.bulk).
      new AuthorizeCampaignSend(campaignRepo),
      resolveBulkActions,
      // campaign-chatwoot-label (D5.d, lección W6) — APPENDED al final de la
      // firma: ambos use cases construidos con `chatwootGatewayForBulk`, la
      // MISMA instancia que recibe `SendCampaign` como 7º arg (:3029) — el pin
      // crítico. Sin este pin el labeling del send-path y el catálogo listado
      // acá pegarían a cuentas Chatwoot distintas sin error visible.
      new ListChatwootLabels(chatwootGatewayForBulk),
      new CreateChatwootLabel(chatwootGatewayForBulk),
    ));
  }

  // ─── Change 3 (templates CRUD) — VER/CREAR/SUBMIT/BORRAR templates WhatsApp ──
  // Bloque self-contained (NO reusa las vars del bloque bulk de arriba, para no
  // interleaves con C2 en el merge): re-instancia el gateway Twilio (mismo config,
  // implementa TemplateAdminPort) + el repo de campañas (guard de borrado: no
  // borrar un template en uso por una campaña activa). RBAC doble capa:
  // read=messaging.templates, write=messaging.bulk (sin acción nueva).
  {
    const templateAdminPort = new TwilioContentGateway({
      accountSid: config.twilio.accountSid,
      authToken: config.twilio.authToken,
      messagingServiceSid: config.twilio.messagingServiceSid,
    });
    const templatesCampaignRepo = new PrismaCampaignRepository();
    app.use('/api/messaging/templates', createMessagingTemplatesRouter(
      new CreateTemplate(templateAdminPort),
      new ListMessagingTemplates(templateAdminPort),
      new GetTemplate(templateAdminPort),
      new SubmitTemplateForApproval(templateAdminPort),
      new DeleteTemplate(templateAdminPort, templatesCampaignRepo),
      createAuthMiddleware(authAdapter, sessionRepo),
      {
        bulk: requirePerm('messaging', 'bulk'),
        templates: requirePerm('messaging', 'templates'),
      },
    ));
  }

  // ─── Ola 4 (inbox-Chatwoot) — respuestas rápidas / macros (canned responses) ─
  // CRUD del catálogo de atajos de texto del composer. Montado en un prefijo MÁS
  // específico que `/api/messaging` (registrado DESPUÉS: un GET a este path entra
  // primero al router de messaging, no matchea ninguna ruta y cae acá — mismo
  // fall-through que ya usan /templates y /bulk). El envío NO se toca: el FE inserta
  // el `content` en el textarea y usa el POST /messages normal. RBAC doble capa:
  // GET (lista/picker) = messaging:read (cualquier agente USA las respuestas);
  // POST/PUT/DELETE (gestión) = messaging:manage (SOLO supervisores CREAN/editan —
  // el MISMO permiso "supervisor" que ya gobierna las notas internas, sin acción nueva).
  {
    const cannedResponseRepo = new PrismaCannedResponseRepository();
    app.use('/api/messaging/canned-responses', createCannedResponsesRouter(
      new ListCannedResponses(cannedResponseRepo),
      new CreateCannedResponse(cannedResponseRepo),
      new UpdateCannedResponse(cannedResponseRepo),
      new DeleteCannedResponse(cannedResponseRepo),
      createAuthMiddleware(authAdapter, sessionRepo),
      {
        read: requirePerm('messaging', 'read'),
        manage: requirePerm('messaging', 'manage'),
      },
    ));
  }

  // ─── N1 (noc-broadcast) — fundación de la difusión NOC vía Evolution API ─────
  // Config singleton + endpoint de prueba (N2/N3 reusan el motor BroadcastToNoc,
  // no este router). Montado en un prefijo MÁS específico que `/api/messaging`
  // (registrado DESPUÉS: un request cae primero al router de messaging, no matchea
  // ninguna ruta y llega acá — mismo fall-through que /canned-responses). El gateway
  // lee la config del repo AL MOMENTO de enviar (editable en runtime vía PUT /config).
  // RBAC: GET /config = messaging:read; PUT /config + POST /test = messaging:manage.
  {
    const nocBroadcastConfigRepo = new PrismaNocBroadcastConfigRepository();
    const nocBroadcastGateway = new EvolutionApiHttpGateway({ configRepo: nocBroadcastConfigRepo });
    app.use('/api/messaging/noc-broadcast', createNocBroadcastRouter(
      authAdapter,
      sessionRepo,
      {
        read: requirePerm('messaging', 'read'),
        manage: requirePerm('messaging', 'manage'),
      },
      new GetNocBroadcastConfig(nocBroadcastConfigRepo),
      new UpdateNocBroadcastConfig(nocBroadcastConfigRepo),
      new SendNocBroadcastTest(nocBroadcastGateway),
    ));
  }

  // ─── bulk-task-recipients (D6, B6) — config-CRUD del 5to dominio "Tarea" ────
  // Router self-contained (molde exacto del bloque N1 de arriba, /noc-broadcast):
  // montado en un prefijo MÁS específico que `/api/messaging` (registrado
  // DESPUÉS: un request cae primero al router de messaging, no matchea ninguna
  // ruta y llega acá — mismo fall-through que /noc-broadcast/canned-responses).
  // Instancia PROPIA del repo (NO reusa `taskStageConfigRepo` del bloque bulk de
  // arriba, mismo criterio anti-interleave que ese bloque documenta) — el repo
  // es stateless (D2), cualquiera de las 2 instancias es funcionalmente
  // equivalente. RBAC: GET = messaging:read (card de Ajustes Y tab del
  // composer); PUT = messaging:manage (solo supervisores editan el mapeo).
  {
    const taskStageConfigRepoForRoute = new PrismaTaskStageRecipientConfigRepository();
    // bulk-task-stage-transition (B1.8) — config singleton del estado resultante global;
    // el Set valida existencia + prohíbe send_to_iclass reusando el `stageRepo` de scheduling.
    const taskStageTransitionConfigRepo = new PrismaTaskStageTransitionConfigRepository();
    app.use('/api/messaging/config/task-stages', createTaskStageConfigRouter(
      authAdapter,
      sessionRepo,
      {
        read: requirePerm('messaging', 'read'),
        manage: requirePerm('messaging', 'manage'),
      },
      new GetTaskStageRecipientConfig(taskStageConfigRepoForRoute),
      new UpdateTaskStageRecipientConfig(taskStageConfigRepoForRoute),
      new GetTaskStageTransitionConfig(taskStageTransitionConfigRepo),
      new SetTaskStageTransitionConfig(taskStageTransitionConfigRepo, stageRepo),
    ));
  }

  // ─── Mis clientes (Fase 3) — cartera del agente + vista super admin ─────────
  const portfolioReadRepo = new PrismaPortfolioReadRepository();
  app.use('/api/portfolio', createPortfolioRouter(
    new GetMyPortfolio(rbacUserRepo, portfolioReadRepo, ticketAdapter),
    new GetPortfolioByVendedor(portfolioReadRepo, ticketAdapter),
    new GetAllPortfolios(portfolioReadRepo, ticketAdapter),
    createAuthMiddleware(authAdapter, sessionRepo),
    {
      read:   requirePerm('recapture', 'read'),
      assign: requirePerm('recapture', 'assign'),
    },
  ));

  // Plan catalog (plan-catalog) — usa el mismo singleton `orchestrator` para sincronizar radgroupreply.
  {
    const planRepo = new PrismaPlanRepository();
    app.use('/api', createPlanRouter(
      authAdapter,
      sessionRepo,
      requirePerm,
      new ListPlans(planRepo),
      new CreatePlan(planRepo, orchestrator),
      new UpdatePlan(planRepo, orchestrator),
      new DeletePlan(planRepo, orchestrator),
    ));
  }

  // ── Zonas visuales (customer-zones-map) ─────────────────────────────────────
  {
    const zoneRepo = new PrismaZoneRepository();
    app.use('/api', createZonesRouter(
      authAdapter,
      sessionRepo,
      requirePerm,
      new ListZones(zoneRepo),
      new CreateZone(zoneRepo),
      new GetZone(zoneRepo),
      new UpdateZone(zoneRepo),
      new DeleteZone(zoneRepo),
    ));
  }

  // External API v1 — API-key auth, read-only (listClients + getDetail + listContracts reused from above)
  // external-create-ticket — read GETs (#150/#152) + the first WRITE (POST /tickets).
  // The write reuses the internal `createTicket` (FK+ownership), `rbacUserRepo` (resolves
  // the system "api" reporter by login) and `ticketAreaRepo` (area-by-name), plus a
  // dedicated rate limiter (the API key can now WRITE — public write needs a ceiling).
  //
  // external-news — the 2nd external WRITE (POST /news). Reuses `createNewsPost` +
  // `newsCategoryRepo` (category-by-name) + `rbacUserRepo` (system "api" author). The
  // N2 block's AttachLinkToNews/BroadcastNewsToNoc instances are block-scoped, so a fresh
  // pair is built here (same wiring: PrismaNocBroadcastConfigRepository + EvolutionApiHttpGateway).
  const externalNewsBroadcastConfigRepo = new PrismaNocBroadcastConfigRepository();
  const externalNewsBroadcastGateway = new EvolutionApiHttpGateway({ configRepo: externalNewsBroadcastConfigRepo });
  const createExternalNews = new CreateExternalNews(
    newsCategoryRepo,
    createNewsPost,
    new AttachLinkToNews(newsAttachmentRepo, newsPostRepo),
    new BroadcastNewsToNoc(
      newsPostRepo,
      new BroadcastToNoc(externalNewsBroadcastConfigRepo, externalNewsBroadcastGateway),
    ),
    // external-news-files — binary uploads reuse the MinIO storage (news/{postId}/ prefix).
    new AttachFilesToNews(newsAttachmentRepo, taskPhotoStorage, newsPostRepo),
    // Compensation port — hard-delete the post if the attach phase fails (all-or-nothing 5xx).
    newsPostRepo,
  );
  app.use('/api/external/v1', createApiKeyMiddleware(), createExternalV1Router(listClients, getDetail, listContracts, {
    createTicket,
    rbacUserRepo,
    ticketAreaRepo,
    rateLimiter: createExternalWriteRateLimiter(),
  }, {
    createExternalNews,
    rbacUserRepo,
    rateLimiter: createExternalWriteRateLimiter(),
  }));

  // finance-growth Fase 1 — /api/finance/growth/* (design.md Wiring). The
  // ROUTE's own dependencies (invoice-type catalog + sync state readers) are
  // REAL Prisma repos, built here regardless of whether the scheduler itself
  // is running — `getPacingStatus` reads the LIVE scheduler snapshot when
  // wired, or an honest "idle" default when GR is off/misconfigured.
  const financeInvoiceTypesRepo = new PrismaFinanceInvoiceTypeClassificationRepository();
  const financeSyncStateRepo = new PrismaSyncStateRepository();
  // fix-wave-1 F8 — ForceFinanceDeltaRun acquires the SAME lock key the
  // scheduler's tick() holds (`finance-receipts-ingest`) before touching
  // SyncState. fix-wave-2 R2 replaced the original read-modify-write with a
  // TARGETED single-column update (`clearLastRunAt`) — the lock is no longer
  // load-bearing there (the write is safe in either order), which is why
  // fix-wave-3 R10 made it proceed unlocked, instead of throwing, when the
  // lock stays busy for the whole retry budget.
  const financeForceRunLock = new PgAdvisoryLock();
  // finance-growth Fase 2 — settables CRUD. Fresh Prisma repos (molde
  // `PrismaPlanRepository`, instantiated per-mount-site elsewhere too — these
  // adapters are stateless). `ContractTechnologyRepository`/`PlanRepository`
  // drive the LEFT JOIN default-zero behavior (design.md "Get..." use cases).
  const financeTechnologyCostRepo = new PrismaFinanceTechnologyCostRepository();
  const financePlanPriceRepo = new PrismaFinancePlanPriceRepository();
  const financeTargetsConfigRepo = new PrismaFinanceTargetsConfigRepository();
  const financeInflationIndexRepo = new PrismaFinanceInflationIndexRepository();
  // fix-wave-1 D — shared instances so `Get*` and `Update*` consult the SAME
  // catalog repo (stateless adapters, but one instance keeps the composition
  // window's intent obvious): `Update*` now 404s a technologyName/planCode
  // absent from the catalog BEFORE upserting (see `FinanceTechnologyNotFoundError`).
  const financeTechnologyCatalogRepo = new PrismaContractTechnologyRepository();
  const financePlanCatalogRepo = new PrismaPlanRepository();
  // finance-growth Fase 3 rework (J1) — BackfillFinanceMonthlySnapshots wired
  // with REAL Prisma repos (composition-root test pins this, molde the rest
  // of this file). Reuses financeInvoiceTypesRepo/financePlanPriceRepo
  // (already declared above, stateless) rather than duplicating instances.
  const backfillSnapshots = new BackfillFinanceMonthlySnapshots(
    new BuildFinanceMonthlySnapshot(
      new PrismaContractServiceEventRepository(),
      new PrismaServiceCatalogRepository(),
      financePlanCatalogRepo,
      new PrismaPppoeServiceRepository(),
      new PrismaClientMirrorReadRepository(),
      new PrismaFinanceReceiptItemRepository(),
      new PrismaFinanceReceiptApplicationRepository(),
      financeInvoiceTypesRepo,
      financePlanPriceRepo,
      new PrismaFinanceMonthlySnapshotRepository(),
    ),
    new BuildFinanceCohortSnapshot(new PrismaContractServiceEventRepository(), new PrismaServiceCatalogRepository(), new PrismaFinanceCohortSnapshotRepository()),
  );
  // finance-growth Fase 4 — read API. Fresh Prisma repos per use case (molde
  // the rest of this composition root — these adapters are stateless); reuses
  // the ALREADY-declared financeTargetsConfigRepo/financePlanPriceRepo/
  // financeTechnologyCostRepo/financeTechnologyCatalogRepo instances above
  // (Fase 2) rather than duplicating them.
  const financeSnapshotRepo = new PrismaFinanceMonthlySnapshotRepository();
  const financeCohortRepo = new PrismaFinanceCohortSnapshotRepository();
  const financeContractRepo = new PrismaContractRepository();
  const financeServiceCatalogRepo = new PrismaServiceCatalogRepository();
  const getOverview = new GetFinanceOverview(financeSnapshotRepo, financeInflationIndexRepo, financeTargetsConfigRepo);
  const getCohorts = new GetFinanceCohorts(financeCohortRepo);
  const computeCac = new ComputeCacAndPayback(
    financeTechnologyCostRepo,
    financeTechnologyCatalogRepo,
    financeTargetsConfigRepo,
    new PrismaContractServiceEventRepository(),
    financeServiceCatalogRepo,
    financeContractRepo,
    new PrismaPppoeServiceRepository(),
    financePlanPriceRepo,
    new PrismaFinanceReceiptItemRepository(),
    new PrismaClientMirrorReadRepository(),
  );
  const rankEarlyChurnByVendor = new RankEarlyChurnByVendor(
    new PrismaContractServiceEventRepository(),
    financeServiceCatalogRepo,
    financeContractRepo,
    financeTargetsConfigRepo,
  );
  const rankNetGrowthByNode = new RankNetGrowthByNode(new PrismaContractServiceEventRepository(), financeServiceCatalogRepo, financeContractRepo);
  const rankCancellationReasons = new RankCancellationReasonsByLostRevenue(
    new PrismaContractServiceEventRepository(),
    financeServiceCatalogRepo,
    financeContractRepo,
    new PrismaPppoeServiceRepository(),
    financePlanPriceRepo,
  );
  app.use('/api/finance/growth', createFinanceGrowthRouter({
    auth: createAuthMiddleware(authAdapter, sessionRepo),
    requirePerm,
    listInvoiceTypes: new ListFinanceInvoiceTypes(financeInvoiceTypesRepo),
    reclassifyInvoiceType: new ReclassifyFinanceInvoiceType(financeInvoiceTypesRepo),
    getSyncStatus: new GetFinanceSyncStatus(financeSyncStateRepo),
    forceDeltaRun: new ForceFinanceDeltaRun(financeSyncStateRepo, financeForceRunLock),
    // fix-wave-2 R6 — reuses the SAME `financeForceRunLock` instance as
    // `ForceFinanceDeltaRun` (safe: PgAdvisoryLock's re-entrancy caveat only
    // matters WITHIN one connection; this still correctly contends against
    // the scheduler's OWN separate `PgAdvisoryLock` connection in
    // `bootstrapFinanceReceiptsIngest.ts`).
    rearmBackfill: new RearmFinanceReceiptsBackfill(financeSyncStateRepo, financeForceRunLock),
    // fix-wave-2 R3 — `isEnabled()`, NOT `!= null` (see FinanceGrowthRouterDeps docblock).
    isSchedulerRunning: () => financeReceiptIngestScheduler?.isEnabled() ?? false,
    getPacingStatus: () => financeReceiptIngestScheduler?.status ?? FINANCE_RECEIPT_INGEST_IDLE_STATUS,
    getTechnologyCosts: new GetFinanceTechnologyCosts(financeTechnologyCostRepo, financeTechnologyCatalogRepo),
    updateTechnologyCost: new UpdateFinanceTechnologyCost(financeTechnologyCostRepo, financeTechnologyCatalogRepo),
    getPlanPrices: new GetFinancePlanPrices(financePlanPriceRepo, financePlanCatalogRepo),
    updatePlanPrice: new UpdateFinancePlanPrice(financePlanPriceRepo, financePlanCatalogRepo),
    getTargets: new GetFinanceTargets(financeTargetsConfigRepo),
    updateTargets: new UpdateFinanceTargets(financeTargetsConfigRepo),
    listInflationIndex: new ListFinanceInflationIndex(financeInflationIndexRepo),
    updateInflationIndex: new UpdateFinanceInflationIndex(financeInflationIndexRepo),
    backfillSnapshots,
    getOverview,
    getCohorts,
    computeCac,
    rankEarlyChurnByVendor,
    rankNetGrowthByNode,
    rankCancellationReasons,
  }));

  // customer-portal-api Fase 7 (task 7.1) — wiring completo del portal de
  // clientes. Reusa customerAdapter/ticketAdapter/schedulingRepo/ticketAreaRepo/
  // settingsRepo/authAdapter/passwordHasher/requirePerm ya declarados arriba
  // (mismos adapters que usa el resto del sistema para esas tablas — no se
  // duplica una instancia Prisma paralela).
  const portalAccountRepo = new PrismaPortalAccountRepository();
  const portalSessionRepo = new PrismaPortalSessionRepository();
  const clientPortalLookup = new PrismaClientPortalLookup();
  const portalTokenService = new JwtPortalTokenService();

  const portalLogin = new PortalLogin(portalAccountRepo, portalSessionRepo, passwordHasher, portalTokenService);
  const refreshPortalSession = new RefreshPortalSession(portalAccountRepo, portalSessionRepo, portalTokenService);
  // portal-push-notifications — `portalPushTokenRepo` se declara ACÁ (antes de
  // `logoutPortal`) porque `LogoutPortal` lo necesita para revocar el token de
  // push del dispositivo que cierra sesión (ver el docblock del use case).
  const portalPushTokenRepo = new PrismaPortalPushTokenRepository();
  const portalPushPreferenceRepo = new PrismaPortalPushPreferenceRepository();
  const logoutPortal = new LogoutPortal(portalSessionRepo, portalPushTokenRepo);
  // M1 (fix wave): con el session repo — el cambio de password revoca TODAS
  // las sesiones de la cuenta (el refresh robado muere con la password vieja).
  const changePortalPassword = new ChangePortalPassword(portalAccountRepo, passwordHasher, portalSessionRepo);
  const getPortalMe = new GetPortalMe(customerAdapter);
  const listPortalInvoices = new ListPortalInvoices(customerAdapter);
  const listPortalPlans = new ListPortalPlans(customerAdapter);
  const listPortalTasks = new ListPortalTasks(schedulingRepo);
  // v2.B (portal-ticket-messaging) — reusa el MISMO `ticketCommentRepo` singleton
  // que ya wirea el CRUD admin de comentarios (línea ~1678), no una instancia
  // Prisma paralela.
  const listPortalTickets = new ListPortalTickets(ticketAdapter, ticketCommentRepo);
  // v2.A (portal-ticket-contract) — customerAdapter resuelve el contrato
  // (pertenencia + label legible), mismo adapter que el resto del portal.
  const getPortalTicket = new GetPortalTicket(ticketAdapter, customerAdapter, ticketCommentRepo);
  // design.md "Tickets del portal: defaults por catalogo" — el nombre del area
  // es CONFIGURABLE (config.portal.ticketAreaName, PORTAL_TICKET_AREA_NAME env,
  // opt-in), nunca el literal hardcodeado del use case.
  const createPortalTicket = new CreatePortalTicket(ticketAdapter, ticketAreaRepo, customerAdapter, config.portal.ticketAreaName);
  // portal-ticket-topic — mismo `ticketAreaRepo` singleton que ya wirea el
  // CRUD admin de áreas (línea ~1395) y `createPortalTicket` arriba.
  const listPortalTicketTopics = new ListPortalTicketTopics(ticketAreaRepo);
  // M5 (fix wave): el evento de auditoría del borrado se PERSISTE en AuditEvent
  // (durable, GET /api/admin/audit-events) además del log estructurado — el
  // default del use case era solo console.log (moría con la rotación de logs).
  const deleteMyPortalAccount = new DeleteMyPortalAccount(
    portalAccountRepo, portalSessionRepo, passwordHasher,
    createPortalAccountDeletionAuditRecorder(auditEventRepo),
  );
  // v2.B (portal-ticket-messaging) — reusa `ticketCommentRepo` (singleton, línea
  // ~1678) y `taskPhotoStorage` (MinIO compartido, ver task-photos/newsMedia arriba).
  const listPortalTicketMessages = new ListPortalTicketMessages(ticketAdapter, ticketCommentRepo);
  const sendPortalTicketMessage = new SendPortalTicketMessage(ticketAdapter, ticketCommentRepo, taskPhotoStorage);
  const getPortalTicketMessageAttachmentFile = new GetPortalTicketMessageAttachmentFile(ticketAdapter, ticketCommentRepo, taskPhotoStorage);

  // portal-promos — reusa customerAdapter (implementa `SegmentMembershipChecker`
  // vía `clientMatchesSegment`, ver PrismaCustomerRepository), ticketAdapter y
  // ticketAreaRepo (mismos singletons que el resto del portal, arriba).
  const portalPromoRepo = new PrismaPortalPromoRepository();
  const portalPromoResponseRepo = new PrismaPortalPromoResponseRepository();
  const listPortalPromos = new ListPortalPromos(portalPromoRepo, portalPromoResponseRepo, customerAdapter);
  const getPortalPromo = new GetPortalPromo(portalPromoRepo, portalPromoResponseRepo, customerAdapter);
  const interestInPortalPromo = new InterestInPortalPromo(
    portalPromoRepo,
    portalPromoResponseRepo,
    customerAdapter,
    ticketAdapter,
    ticketAreaRepo,
    customerAdapter,
    config.portal.ticketAreaName,
  );
  const dismissPortalPromo = new DismissPortalPromo(portalPromoRepo, portalPromoResponseRepo, customerAdapter);

  // portal-benefits — reusa los mismos singletons de arriba (portalPromoRepo,
  // portalPromoResponseRepo, customerAdapter como SegmentMembershipChecker Y
  // como CustomerRepository, ticketAdapter) — cero instancias Prisma paralelas.
  const listPortalBenefits = new ListPortalBenefits(
    portalPromoRepo,
    portalPromoResponseRepo,
    customerAdapter,
    customerAdapter,
    ticketAdapter,
  );

  // portal-push-notifications — registro de dispositivos + preferencias
  // (client-facing). `portalPushTokenRepo`/`portalPushPreferenceRepo` ya se
  // declararon arriba (junto a `logoutPortal`, que los necesita antes).
  const registerPortalPushToken = new RegisterPortalPushToken(portalPushTokenRepo);
  const unregisterPortalPushToken = new UnregisterPortalPushToken(portalPushTokenRepo);
  const getPortalPushPreferences = new GetPortalPushPreferences(portalPushPreferenceRepo);
  const updatePortalPushPreferences = new UpdatePortalPushPreferences(portalPushPreferenceRepo);

  // portal-notification-inbox — el buzón, `portalNotificationRepo` ya se
  // declaró arriba (junto a `sendPushServiceAlert`, que lo necesita antes).
  const listPortalNotifications = new ListPortalNotifications(portalNotificationRepo);
  const getPortalNotificationsUnreadCount = new GetPortalNotificationsUnreadCount(portalNotificationRepo);
  const markPortalNotificationsRead = new MarkPortalNotificationsRead(portalNotificationRepo);
  const markAllPortalNotificationsRead = new MarkAllPortalNotificationsRead(portalNotificationRepo);

  const portalAuthMw = createPortalAuthMiddleware(portalTokenService, portalAccountRepo);
  const portalKillSwitchMw = createPortalKillSwitchMiddleware(settingsRepo);
  // W6: se instancian los 4 rate limiters EXPLICITAMENTE (aunque el router los
  // defaultea si se omiten) — el wiring queda pineado por el composition-root
  // test, nunca dependiente de un default silencioso.
  const portalLoginRateLimiter = createPortalLoginRateLimiter();
  // H3b (fix wave): techo por IP sola además del (IP+dni) — corta el barrido
  // de enumeración de DNIs que estrenaba un bucket nuevo por request.
  const portalLoginIpRateLimiter = createPortalLoginIpRateLimiter();
  const portalGeneralRateLimiter = createPortalGeneralRateLimiter();
  const portalTicketCreateRateLimiter = createPortalTicketCreateRateLimiter();
  const portalTicketMessageSendRateLimiter = createPortalTicketMessageSendRateLimiter();

  // wifi-self-service (F0) — instancia PROPIA de SmartOltHttpGateway (mismo
  // config.smartolt que el bloque fiber-provisioning más arriba, pero una
  // instancia separada a propósito: ese `smartoltGateway` queda block-scoped
  // dentro de `{ ... }` del wiring de PPPoE, y fiber-provisioning nunca llama
  // getOnuWifiStatus — no hay beneficio en compartir su cache in-memory).
  // Opt-in / NO fail-fast: sin SMARTOLT_BASE_URL/SMARTOLT_API_TOKEN, los use
  // cases fallan AL USARSE con SMARTOLT_NOT_CONFIGURED (503 admin) /
  // `reason:'not_configured'` (200 portal) — el resto de la app arranca igual.
  const smartoltWifiGateway = new SmartOltHttpGateway({
    baseUrl: config.smartolt.baseUrl,
    token: config.smartolt.token,
    timeoutMs: config.smartolt.timeoutMs,
    stepPauseMs: config.smartolt.stepPauseMs,
  });
  const resolveWifiEligibility = new ResolveWifiEligibility(customerAdapter, contractInventoryRepo, smartoltWifiGateway);
  const getPortalWifiStatus = new GetPortalWifiStatus(resolveWifiEligibility, smartoltWifiGateway);
  const updatePortalWifiBand = new UpdatePortalWifiBand(resolveWifiEligibility, smartoltWifiGateway);
  const listPortalWifiDevices = new ListPortalWifiDevices(resolveWifiEligibility, smartoltWifiGateway);

  // portal-equipment-reboot — reusa la MISMA `smartoltWifiGateway` (mismo cache
  // 60s de `getOnuWifiStatus` que "Mi WiFi") para el resolver de elegibilidad,
  // pero un `ResolveEquipmentRebootEligibility` PROPIO (elegibilidad más
  // amplia — ver el docblock del use case). El `reboot(sn)` en sí es
  // `OltProvisioningGateway` (K2), no `WifiManagementPort` — la MISMA
  // instancia de `SmartOltHttpGateway` implementa ambos ports.
  const resolveEquipmentRebootEligibility = new ResolveEquipmentRebootEligibility(
    customerAdapter,
    contractInventoryRepo,
    smartoltWifiGateway,
  );
  const getPortalEquipmentStatus = new GetPortalEquipmentStatus(resolveEquipmentRebootEligibility);
  const rebootPortalEquipment = new RebootPortalEquipment(resolveEquipmentRebootEligibility, smartoltWifiGateway);

  app.use('/api/portal', createPortalRouter({
    portalLogin,
    refreshPortalSession,
    logoutPortal,
    changePortalPassword,
    portalAuthMiddleware: portalAuthMw,
    killSwitch: portalKillSwitchMw,
    loginRateLimiter: portalLoginRateLimiter,
    loginIpRateLimiter: portalLoginIpRateLimiter,
    generalRateLimiter: portalGeneralRateLimiter,
    getPortalMe,
    listPortalInvoices,
    listPortalPlans,
    listPortalTasks,
    listPortalTickets,
    getPortalTicket,
    createPortalTicket,
    listPortalTicketTopics,
    deleteMyPortalAccount,
    ticketCreateRateLimiter: portalTicketCreateRateLimiter,
    listPortalTicketMessages,
    sendPortalTicketMessage,
    getPortalTicketMessageAttachmentFile,
    ticketMessageSendRateLimiter: portalTicketMessageSendRateLimiter,
    listPortalPromos,
    getPortalPromo,
    interestInPortalPromo,
    dismissPortalPromo,
    listPortalBenefits,
    registerPortalPushToken,
    unregisterPortalPushToken,
    getPortalPushPreferences,
    updatePortalPushPreferences,
    listPortalNotifications,
    getPortalNotificationsUnreadCount,
    markPortalNotificationsRead,
    markAllPortalNotificationsRead,
    getPortalWifiStatus,
    updatePortalWifiBand,
    listPortalWifiDevices,
    getPortalEquipmentStatus,
    rebootPortalEquipment,
  }));

  // wifi-self-service (F0) — admin `/api/wifi` (wifi.read/wifi.manage). Por
  // SERIAL, no por contrato — staff opera ONUs aunque no estén asociadas
  // todavía (proposal.md F0). Reusa la MISMA instancia de smartoltWifiGateway
  // de arriba (cache compartida entre portal y admin para la misma sn).
  const getAdminOnuWifiStatus = new GetAdminOnuWifiStatus(smartoltWifiGateway);
  const setAdminWifiBand = new SetAdminWifiBand(smartoltWifiGateway);
  const enableOnuTr069 = new EnableOnuTr069(smartoltWifiGateway);
  app.use('/api/wifi', createWifiRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    getAdminOnuWifiStatus,
    setAdminWifiBand,
    enableOnuTr069,
  ));

  // portal-promos — admin CRUD (`promos.read`/`promos.manage`).
  const listPortalPromosAdmin = new ListPortalPromosAdmin(portalPromoRepo);
  const getPortalPromoAdmin = new GetPortalPromoAdmin(portalPromoRepo);
  const createPortalPromo = new CreatePortalPromo(portalPromoRepo);
  const updatePortalPromo = new UpdatePortalPromo(portalPromoRepo);
  const previewPromoAudience = new PreviewPromoAudience(customerAdapter, portalAccountRepo);
  app.use('/api/promos', createPromosRouter(
    authAdapter,
    sessionRepo,
    requirePerm,
    listPortalPromosAdmin,
    getPortalPromoAdmin,
    createPortalPromo,
    updatePortalPromo,
    previewPromoAudience,
  ));

  // CRUD admin de cuentas del portal — staff auth (rechaza aud=portal) +
  // portal.manage (guard granular, spec "TODAS las rutas del CRUD DEBEN exigir
  // portal.manage — 'solo autenticado' NO alcanza"). design.md riesgo #3: sin
  // page en Prominense FE todavia, el CRUD se opera por API hasta que exista.
  const createPortalAccountUC = new CreatePortalAccount(portalAccountRepo, clientPortalLookup, passwordHasher);
  const regeneratePortalPassword = new RegeneratePortalPassword(portalAccountRepo, portalSessionRepo, passwordHasher);
  const setPortalAccountStatus = new SetPortalAccountStatus(portalAccountRepo, portalSessionRepo);
  const deletePortalAccountAdmin = new DeletePortalAccountAdmin(portalAccountRepo, portalSessionRepo);
  const listPortalAccounts = new ListPortalAccounts(portalAccountRepo, clientPortalLookup);

  app.use('/api/admin/portal-accounts', createPortalAccountsAdminRouter({
    createPortalAccount: createPortalAccountUC,
    regeneratePortalPassword,
    setPortalAccountStatus,
    deletePortalAccountAdmin,
    listPortalAccounts,
    authProvider: authAdapter,
    // H1 (fix wave) — stateful staff auth: sin el sessionRepo una sesión
    // revocada seguía operando el CRUD hasta que expirara el JWT.
    sessionRepo,
    requirePortalManage: requirePerm('portal', 'manage'),
  }));

  // 404
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Global error handler (shared with route tests — single source of truth).
  app.use(errorHandler);

  return app;
}
