-- Contract.name — manual-only identifier (#43). GR sync NEVER writes this column.
ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "name" TEXT;
