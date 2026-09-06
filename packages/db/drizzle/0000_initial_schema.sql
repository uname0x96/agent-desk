CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_operator" boolean DEFAULT false NOT NULL,
	"telegram_chat_id" text,
	"daily_fee_budget" text,
	"budget_window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_daily_fee_budget_base_units" CHECK ("accounts"."daily_fee_budget" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"listing_id" text NOT NULL,
	"node_index" integer NOT NULL,
	"node_type" text NOT NULL,
	"status" text NOT NULL,
	"locked_price" text NOT NULL,
	"locked_pay_to" text NOT NULL,
	"locked_asset" text NOT NULL,
	"locked_network" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"payment_required" jsonb,
	"payment_payload" jsonb,
	"payment_tx_hash" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"reference_price" text,
	"reference_at" timestamp with time zone,
	"failure_reason" text,
	"skip_reason" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "calls_kind_enum" CHECK ("calls"."kind" in ('run', 'verification')),
	CONSTRAINT "calls_status_enum" CHECK ("calls"."status" in ('pending', 'price_mismatch', 'payment_failed', 'paid_awaiting_result', 'succeeded', 'failed_after_payment', 'skipped')),
	CONSTRAINT "calls_node_type_enum" CHECK ("calls"."node_type" in ('data', 'research', 'risk', 'execution', 'notify')),
	CONSTRAINT "calls_skip_reason_enum" CHECK ("calls"."skip_reason" in ('not_reached', 'hold', 'reject')),
	CONSTRAINT "calls_locked_price_base_units" CHECK ("calls"."locked_price" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "calls_locked_pay_to_lower_case" CHECK ("calls"."locked_pay_to" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "calls_locked_asset_lower_case" CHECK ("calls"."locked_asset" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "calls_payment_tx_hash_lower_case" CHECK ("calls"."payment_tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "calls_reference_price_decimal" CHECK ("calls"."reference_price" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
	CONSTRAINT "calls_run_id_matches_kind" CHECK (("calls"."kind" = 'run') = ("calls"."run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "chain_tx" (
	"intent_key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_tx_status_enum" CHECK ("chain_tx"."status" in ('pending', 'confirmed', 'reverted', 'failed')),
	CONSTRAINT "chain_tx_tx_hash_lower_case" CHECK ("chain_tx"."tx_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_account_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"endpoint" text NOT NULL,
	"declared_price" text NOT NULL,
	"declared_stake" text NOT NULL,
	"payout_wallet" text NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"skip_verification" boolean DEFAULT false NOT NULL,
	"price" text,
	"stake" text,
	"reputation_bps" integer,
	"paused_by_creator" boolean DEFAULT false NOT NULL,
	"paused_by_stake" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"registry_listing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_type_enum" CHECK ("listings"."type" in ('data', 'research', 'risk', 'execution', 'notify')),
	CONSTRAINT "listings_status_enum" CHECK ("listings"."status" in ('verifying', 'failed', 'active', 'paused')),
	CONSTRAINT "listings_declared_price_base_units" CHECK ("listings"."declared_price" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "listings_declared_stake_base_units" CHECK ("listings"."declared_stake" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "listings_price_base_units" CHECK ("listings"."price" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "listings_stake_base_units" CHECK ("listings"."stake" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "listings_payout_wallet_lower_case" CHECK ("listings"."payout_wallet" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'production' NOT NULL,
	"emergency_stop" boolean DEFAULT false NOT NULL,
	"order_ceiling_usdt" text DEFAULT '1000' NOT NULL,
	"default_daily_fee_budget" text NOT NULL,
	"verification_cap_daily" text NOT NULL,
	"platform_account_id" text,
	"worker_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_single_row" CHECK ("platform_settings"."id" = 1),
	CONSTRAINT "platform_settings_mode_enum" CHECK ("platform_settings"."mode" in ('production', 'demo')),
	CONSTRAINT "platform_settings_order_ceiling_decimal" CHECK ("platform_settings"."order_ceiling_usdt" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
	CONSTRAINT "platform_settings_default_budget_base_units" CHECK ("platform_settings"."default_daily_fee_budget" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "platform_settings_verification_cap_base_units" CHECK ("platform_settings"."verification_cap_daily" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"account_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"status" text NOT NULL,
	"price_lock" jsonb NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "runs_status_enum" CHECK ("runs"."status" in ('running', 'completed', 'completed, no order', 'timed out') or "runs"."status" like 'failed at %')
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"result" text NOT NULL,
	"not_scored_reason" text,
	"mode" text NOT NULL,
	"rule_label" text NOT NULL,
	"start_price" text,
	"end_price" text,
	"change_24h_pct" double precision,
	"p_fill" text,
	"window_min" text,
	"window_max" text,
	"price_source" text DEFAULT 'binance-public-market-data' NOT NULL,
	"scored_at" timestamp with time zone NOT NULL,
	"slash_amount" text,
	"slash_tx_hash" text,
	"refund_to" text,
	"reputation_tx_hash" text,
	CONSTRAINT "settlements_result_enum" CHECK ("settlements"."result" in ('passed', 'failed', 'not_scored')),
	CONSTRAINT "settlements_not_scored_reason_enum" CHECK ("settlements"."not_scored_reason" in ('reject_decision', 'no_fill', 'no_reference_price')),
	CONSTRAINT "settlements_mode_enum" CHECK ("settlements"."mode" in ('production', 'demo')),
	CONSTRAINT "settlements_slash_amount_base_units" CHECK ("settlements"."slash_amount" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "settlements_slash_tx_hash_lower_case" CHECK ("settlements"."slash_tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "settlements_reputation_tx_hash_lower_case" CHECK ("settlements"."reputation_tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "settlements_refund_to_lower_case" CHECK ("settlements"."refund_to" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "settlements_not_scored_reason_present" CHECK (("settlements"."result" = 'not_scored') = ("settlements"."not_scored_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"address" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_address_lower_case" CHECK ("wallets"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "workflow_nodes" (
	"workflow_id" text NOT NULL,
	"node_index" integer NOT NULL,
	"node_type" text NOT NULL,
	"listing_id" text NOT NULL,
	CONSTRAINT "workflow_nodes_pkey" PRIMARY KEY("workflow_id","node_index"),
	CONSTRAINT "workflow_nodes_node_type_enum" CHECK ("workflow_nodes"."node_type" in ('data', 'research', 'risk', 'execution', 'notify')),
	CONSTRAINT "workflow_nodes_node_index_non_negative" CHECK ("workflow_nodes"."node_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"order_cap_usdt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_order_cap_usdt_decimal" CHECK ("workflows"."order_cap_usdt" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$')
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_creator_account_id_accounts_id_fk" FOREIGN KEY ("creator_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_platform_account_id_accounts_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_nodes" ADD CONSTRAINT "workflow_nodes_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_nodes" ADD CONSTRAINT "workflow_nodes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "calls_run_id_node_index_idx" ON "calls" USING btree ("run_id","node_index");--> statement-breakpoint
CREATE INDEX "calls_listing_id_idx" ON "calls" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "calls_kind_status_idx" ON "calls" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "chain_tx_status_idx" ON "chain_tx" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chain_tx_created_at_idx" ON "chain_tx" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chain_tx_intent_key_pattern_idx" ON "chain_tx" USING btree ("intent_key" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "listings_status_type_idx" ON "listings" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "listings_creator_account_id_idx" ON "listings" USING btree ("creator_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_workflow" ON "runs" USING btree ("workflow_id") WHERE "runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "runs_account_id_created_at_idx" ON "runs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_started_at_idx" ON "runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_call_id_key" ON "settlements" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "settlements_listing_id_scored_at_idx" ON "settlements" USING btree ("listing_id","scored_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_address_key" ON "wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX "wallets_account_id_idx" ON "wallets" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "workflow_nodes_listing_id_idx" ON "workflow_nodes" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "workflows_account_id_idx" ON "workflows" USING btree ("account_id");