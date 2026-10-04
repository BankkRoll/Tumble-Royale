CREATE TABLE "event_challenge_progress" (
	"user_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"challenge_id" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "event_challenge_progress_user_id_event_id_challenge_id_pk" PRIMARY KEY("user_id","event_id","challenge_id")
);
--> statement-breakpoint
CREATE TABLE "event_match_credits" (
	"user_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"match_id" text NOT NULL,
	"points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_match_credits_user_id_event_id_match_id_pk" PRIMARY KEY("user_id","event_id","match_id")
);
--> statement-breakpoint
CREATE TABLE "event_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_progress" (
	"user_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"shows" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_progress_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "event_tier_claims" (
	"user_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"tier" integer NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	CONSTRAINT "event_tier_claims_user_id_event_id_tier_pk" PRIMARY KEY("user_id","event_id","tier")
);
--> statement-breakpoint
ALTER TABLE "event_challenge_progress" ADD CONSTRAINT "event_challenge_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_match_credits" ADD CONSTRAINT "event_match_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_progress" ADD CONSTRAINT "event_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tier_claims" ADD CONSTRAINT "event_tier_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;