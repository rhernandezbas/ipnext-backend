-- AlterTable — aditiva y nullable (gigared-alta-asincrona W1.1: estado del job de ALTA de TV async)
-- tvRegisterStatus:      nullable text  ('pending' | 'running' | 'done' | 'failed')
-- tvRegisterResult:      nullable jsonb (result de RegisterGigaredAccount en done; {error} en failed)
-- tvRegisterStartedAt:   nullable timestamp — cuándo se ENCOLÓ el alta. INMUTABLE mientras el job
--                        vive: es lo que el operador ve en el polling.
-- tvRegisterHeartbeatAt: nullable timestamp — última SEÑAL DE VIDA del runner. Es el ancla del
--                        watchdog y el fence token de la reserva. Sin él, el watchdog no distingue
--                        "el proceso murió" de "el job está tardando" (un alta hace 17 llamadas al
--                        partner: 510 s de piso contra un TTL de 900 s) y le roba el turno a un job
--                        VIVO ⇒ segundo register ⇒ cliente quemado.
-- Estado mirror-only; el sync de GR NUNCA escribe estas columnas.
--
-- El prefijo NO es una fecha: en este repo los directorios de migración son una secuencia
-- monotónica sintética y la última existente es 20261110000000. Un prefijo con la fecha real
-- (20260810…) retrocedería ~40 migraciones y se aplicaría fuera de orden en una DB limpia.
ALTER TABLE "Client" ADD COLUMN "tvRegisterResult" JSONB,
ADD COLUMN "tvRegisterStartedAt" TIMESTAMP(3),
ADD COLUMN "tvRegisterHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "tvRegisterStatus" TEXT;
