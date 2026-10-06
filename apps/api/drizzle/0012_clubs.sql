CREATE TABLE "club_contributions" (
	"club_id" uuid NOT NULL,
	"week" text NOT NULL,
	"user_id" uuid NOT NULL,
	"shows" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"crowns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_contributions_club_id_week_user_id_pk" PRIMARY KEY("club_id","week","user_id")
);
--> statement-breakpoint
CREATE TABLE "club_goal_progress" (
	"club_id" uuid NOT NULL,
	"week" text NOT NULL,
	"goal_id" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "club_goal_progress_club_id_week_goal_id_pk" PRIMARY KEY("club_id","week","goal_id")
);
--> statement-breakpoint
CREATE TABLE "club_invites" (
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_invites_club_id_user_id_kind_pk" PRIMARY KEY("club_id","user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "club_kicks" (
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL,
	CONSTRAINT "club_kicks_club_id_user_id_pk" PRIMARY KEY("club_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "club_members" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"club_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"masked" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"club_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"snapshot" jsonb NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_reward_claims" (
	"user_id" uuid NOT NULL,
	"week" text NOT NULL,
	"goal_id" text NOT NULL,
	"club_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	CONSTRAINT "club_reward_claims_user_id_week_goal_id_pk" PRIMARY KEY("user_id","week","goal_id")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"emblem" jsonb NOT NULL,
	"join_mode" text DEFAULT 'open' NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disbanded_at" timestamp with time zone,
	"disband_reason" text
);
--> statement-breakpoint
ALTER TABLE "club_contributions" ADD CONSTRAINT "club_contributions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_contributions" ADD CONSTRAINT "club_contributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_goal_progress" ADD CONSTRAINT "club_goal_progress_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_kicks" ADD CONSTRAINT "club_kicks_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_kicks" ADD CONSTRAINT "club_kicks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_messages" ADD CONSTRAINT "club_messages_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_messages" ADD CONSTRAINT "club_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reports" ADD CONSTRAINT "club_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reports" ADD CONSTRAINT "club_reports_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reward_claims" ADD CONSTRAINT "club_reward_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_invites_user_idx" ON "club_invites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "club_members_club_idx" ON "club_members" USING btree ("club_id","joined_at");--> statement-breakpoint
CREATE INDEX "club_messages_club_idx" ON "club_messages" USING btree ("club_id","id");--> statement-breakpoint
CREATE INDEX "club_messages_created_idx" ON "club_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "club_reports_status_idx" ON "club_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "club_reports_club_idx" ON "club_reports" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_name_live_uq" ON "clubs" USING btree (lower("name")) WHERE "clubs"."disbanded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_tag_live_uq" ON "clubs" USING btree (lower("tag")) WHERE "clubs"."disbanded_at" is null;--> statement-breakpoint
CREATE INDEX "clubs_activity_idx" ON "clubs" USING btree ("last_activity_at");