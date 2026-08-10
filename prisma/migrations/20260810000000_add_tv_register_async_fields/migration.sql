-- AlterTable — aditiva y nullable (gigared-alta-asincrona W1.1: estado del job de ALTA de TV async)
-- tvRegisterStatus:    nullable text  ('pending' | 'running' | 'done' | 'failed')
-- tvRegisterResult:    nullable jsonb (result de RegisterGigaredAccount en done; {error} en failed)
-- tvRegisterStartedAt: nullable timestamp — se escribe al ENCOLAR (pending) y se re-sella al pasar
--                      a 'running'. Es el ancla del watchdog que expira los jobs huérfanos.
-- Estado mirror-only; el sync de GR NUNCA escribe estas columnas.
ALTER TABLE "Client" ADD COLUMN "tvRegisterResult" JSONB,
ADD COLUMN "tvRegisterStartedAt" TIMESTAMP(3),
ADD COLUMN "tvRegisterStatus" TEXT;
