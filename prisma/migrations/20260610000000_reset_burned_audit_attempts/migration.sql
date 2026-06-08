-- Remediación (#35 Parte 1): re-armar el rescate del #34 (map-reduce ante degeneración).
-- Las OS que degeneraban (qwen2.5vl:7b devolvía <|im_start|> en vez de JSON) agotaron sus
-- 3 auditAttempts ANTES de deployar el #34, así que listPendingSideEffects las excluye
-- (filtra auditAttempts < maxAuditAttempts=3) y el reprocess ya no las agarra.
--
-- Resetear auditAttempts=0 en esas OS rendidas las vuelve a incluir → el próximo reprocess
-- las re-audita con el map-reduce del #34 (1x1 + síntesis), sin perder las fotos.
--
-- Idempotente: re-correrla resetea las que sigan en auditDone=false AND auditAttempts>=3.
-- No toca las que ya se auditaron OK (auditDone=true). Data-only, sin cambio de schema.
UPDATE "IClassServiceOrder" SET "auditAttempts" = 0
WHERE "auditDone" = false AND "auditAttempts" >= 3;
