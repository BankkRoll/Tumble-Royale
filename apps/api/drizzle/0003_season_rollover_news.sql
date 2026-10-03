CREATE TABLE "news_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_rollovers" (
	"season_id" text PRIMARY KEY NOT NULL,
	"previous_season_id" text,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "season_pass_progress" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "season_pass_progress" ADD COLUMN "auto_granted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "news_published_idx" ON "news_posts" USING btree ("published_at");