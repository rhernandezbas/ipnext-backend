-- AlterTable — additive only (#10/#11: async TV-cancel status fields on Client)
-- tvCancelStatus:    nullable text  ('pending' | 'running' | 'done' | 'failed')
-- tvCancelResult:    nullable jsonb (CancelTvResult on done; {error} on failed)
-- tvCancelStartedAt: nullable timestamp (set when runner transitions to 'running')
-- Mirror-only state; GR sync NEVER writes these columns.
ALTER TABLE "Client" ADD COLUMN "tvCancelResult" JSONB,
ADD COLUMN "tvCancelStartedAt" TIMESTAMP(3),
ADD COLUMN "tvCancelStatus" TEXT;
