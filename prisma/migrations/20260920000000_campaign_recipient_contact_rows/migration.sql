-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "contactName" TEXT,
ALTER COLUMN "clientId" DROP NOT NULL;
