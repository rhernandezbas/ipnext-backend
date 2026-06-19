-- Migration: 20260801000100_plan_seed
-- Seed: 21 planes canonicos de IPNEXT.

INSERT INTO "Plan" ("id", "code", "name", "category", "downloadKbps", "uploadKbps", "status", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'IP-Air-30-10',        'Air 30/10',               'Air',   30000,   10000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-30-30',        'Air 30/30',               'Air',   30000,   30000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-40-15',        'Air 40/15',               'Air',   40000,   15000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-40-40',        'Air 40/40',               'Air',   40000,   40000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-50-15',        'Air 50/15',               'Air',   50000,   15000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-50-50',        'Air 50/50',               'Air',   50000,   50000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-80-30',        'Air 80/30',               'Air',   80000,   30000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-80-80',        'Air 80/80',               'Air',   80000,   80000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-100-30',       'Air 100/30',              'Air',   100000,  30000,  'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Air-100-100',      'Air 100/100',             'Air',   100000,  100000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-One-300-100',      'One 300/100',             'Alta',  300000,  100000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-One-S-300-300',    'One S 300/300',           'Alta',  300000,  300000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Plus-500-150',     'Plus 500/150',            'Alta',  500000,  150000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Plus-S-500-500',   'Plus S 500/500',          'Alta',  500000,  500000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Max-600-200',      'Max 600/200',             'Alta',  600000,  200000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Max-S-600-600',    'Max S 600/600',           'Alta',  600000,  600000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Pro-800-250',      'Pro 800/250',             'Alta',  800000,  250000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-Pro-S-800-800',    'Pro S 800/800',           'Alta',  800000,  800000, 'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-ProMax-S-1000-1000', 'Pro Max S 1000/1000',   'Alta',  1000000, 1000000,'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-REDUCCION',        'Reduccion (deudores)',     'Corte', 256,     256,    'enabled', NOW(), NOW()),
  (gen_random_uuid(), 'IP-BAJA',             'Baja',                    'Corte', 1,       1,      'enabled', NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;
