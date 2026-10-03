CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"challenge_id" text NOT NULL,
	"period" text NOT NULL,
	"period_key" text NOT NULL,
	"slot" integer NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"rerolled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"title" text NOT NULL,
	"metric" text NOT NULL,
	"target" integer NOT NULL,
	"reward_xp" integer NOT NULL,
	"reward_gumballs" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cosmetics_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slot" text NOT NULL,
	"rarity" text NOT NULL,
	"source" text NOT NULL,
	"price_currency" text,
	"price_amount" integer,
	"active" boolean DEFAULT true NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"props" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percent" integer DEFAULT 100 NOT NULL,
	"payload" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_id" uuid NOT NULL,
	"friend_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_user_id_friend_id_pk" PRIMARY KEY("user_id","friend_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cosmetic_id" text NOT NULL,
	"source" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loadouts" (
	"user_id" uuid NOT NULL,
	"slot_index" integer NOT NULL,
	"name" text NOT NULL,
	"items" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loadouts_user_id_slot_index_pk" PRIMARY KEY("user_id","slot_index")
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" text NOT NULL,
	"participant_key" text NOT NULL,
	"user_id" uuid,
	"is_bot" boolean NOT NULL,
	"name" text NOT NULL,
	"team" integer,
	"placement" integer NOT NULL,
	"crowned" boolean NOT NULL,
	"rounds_survived" integer NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"gumballs" integer DEFAULT 0 NOT NULL,
	"crown_shards" integer DEFAULT 0 NOT NULL,
	"rp_delta" integer,
	CONSTRAINT "match_participants_match_id_participant_key_pk" PRIMARY KEY("match_id","participant_key")
);
--> statement-breakpoint
CREATE TABLE "match_rounds" (
	"match_id" text NOT NULL,
	"round_index" integer NOT NULL,
	"round_id" text NOT NULL,
	"round_type" text NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "match_rounds_match_id_round_index_pk" PRIMARY KEY("match_id","round_index")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"playlist_id" text NOT NULL,
	"season_id" text NOT NULL,
	"region" text NOT NULL,
	"player_count" integer NOT NULL,
	"bot_count" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rewards" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_round_stats" (
	"user_id" uuid NOT NULL,
	"round_id" text NOT NULL,
	"played" integer DEFAULT 0 NOT NULL,
	"qualified" integer DEFAULT 0 NOT NULL,
	"best_time_ms" integer,
	CONSTRAINT "player_round_stats_user_id_round_id_pk" PRIMARY KEY("user_id","round_id")
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"shows_played" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"finals" integer DEFAULT 0 NOT NULL,
	"rounds_played" integer DEFAULT 0 NOT NULL,
	"rounds_qualified" integer DEFAULT 0 NOT NULL,
	"current_win_streak" integer DEFAULT 0 NOT NULL,
	"best_win_streak" integer DEFAULT 0 NOT NULL,
	"last_show_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"tag" text NOT NULL,
	"name_changed_at" timestamp with time zone,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"crowns" integer DEFAULT 0 NOT NULL,
	"crown_shards" integer DEFAULT 0 NOT NULL,
	"gumballs" integer DEFAULT 0 NOT NULL,
	"gems" integer DEFAULT 0 NOT NULL,
	"active_loadout" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"currency" text NOT NULL,
	"price" integer NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_ref" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rank_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"season_id" text NOT NULL,
	"queue" text NOT NULL,
	"match_id" text NOT NULL,
	"placement" integer NOT NULL,
	"mu_before" double precision NOT NULL,
	"mu_after" double precision NOT NULL,
	"sigma_before" double precision NOT NULL,
	"sigma_after" double precision NOT NULL,
	"rp_before" integer NOT NULL,
	"rp_after" integer NOT NULL,
	"tier" text NOT NULL,
	"division" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"user_id" uuid NOT NULL,
	"season_id" text NOT NULL,
	"queue" text NOT NULL,
	"mu" double precision NOT NULL,
	"sigma" double precision NOT NULL,
	"rp" integer DEFAULT 0 NOT NULL,
	"tier" text NOT NULL,
	"division" integer NOT NULL,
	"placements_left" integer NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_id_season_id_queue_pk" PRIMARY KEY("user_id","season_id","queue")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"match_id" text,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_results" (
	"match_id" text NOT NULL,
	"round_index" integer NOT NULL,
	"participant_key" text NOT NULL,
	"qualified" boolean NOT NULL,
	"position" integer,
	"score" integer,
	"time_ms" integer,
	CONSTRAINT "round_results_match_id_round_index_participant_key_pk" PRIMARY KEY("match_id","round_index","participant_key")
);
--> statement-breakpoint
CREATE TABLE "season_pass_progress" (
	"user_id" uuid NOT NULL,
	"season_id" text NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"premium" boolean DEFAULT false NOT NULL,
	"claimed_free" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_premium" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_pass_progress_user_id_season_id_pk" PRIMARY KEY("user_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "store_rotations" (
	"day" text PRIMARY KEY NOT NULL,
	"featured" jsonb NOT NULL,
	"daily" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_guest" boolean DEFAULT true NOT NULL,
	"email" text,
	"region" text DEFAULT 'na' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_progress" ADD CONSTRAINT "challenge_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "currencies_ledger" ADD CONSTRAINT "currencies_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loadouts" ADD CONSTRAINT "loadouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_rounds" ADD CONSTRAINT "match_rounds_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_round_stats" ADD CONSTRAINT "player_round_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_history" ADD CONSTRAINT "rank_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_pass_progress" ADD CONSTRAINT "season_pass_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uq" ON "auth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bans_user_idx" ON "bans" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_progress_slot_uq" ON "challenge_progress" USING btree ("user_id","period","period_key","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_idempotency_uq" ON "currencies_ledger" USING btree ("user_id","currency","reason","ref");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "currencies_ledger" USING btree ("user_id","currency");--> statement-breakpoint
CREATE INDEX "events_name_idx" ON "events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "friendships_friend_idx" ON "friendships" USING btree ("friend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_user_item_uq" ON "inventory_items" USING btree ("user_id","cosmetic_id");--> statement-breakpoint
CREATE INDEX "match_participants_user_idx" ON "match_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "matches_season_idx" ON "matches" USING btree ("season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_name_tag_uq" ON "profiles" USING btree (lower("display_name"),"tag");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_user_key_uq" ON "purchases" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_provider_ref_uq" ON "purchases" USING btree ("provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_history_match_user_uq" ON "rank_history" USING btree ("match_id","user_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");