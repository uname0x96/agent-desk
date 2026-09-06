-- AD-10: platform_settings is a single row, id = 1, inserted by the migration,
-- so Emergency Stop and the mode can be flipped without a restart and without a
-- bootstrap step outside migrations.
--
-- Amounts are tUSD base units (TUSD_DECIMALS = 6, AD-13):
--   default_daily_fee_budget = 1 tUSD  = 1000000
--   verification_cap_daily   = 5 tUSD  = 5000000
-- order_ceiling_usdt is a decimal USDT order size, not base units (AD-11).
--
-- ON CONFLICT keeps the statement a no-op on any replay: drizzle-kit already
-- skips applied migrations, and this makes the row itself idempotent too.
INSERT INTO "platform_settings" (
	"id",
	"mode",
	"emergency_stop",
	"order_ceiling_usdt",
	"default_daily_fee_budget",
	"verification_cap_daily",
	"platform_account_id",
	"worker_seen_at"
) VALUES (
	1,
	'production',
	false,
	'1000',
	'1000000',
	'5000000',
	NULL,
	NULL
) ON CONFLICT ("id") DO NOTHING;
