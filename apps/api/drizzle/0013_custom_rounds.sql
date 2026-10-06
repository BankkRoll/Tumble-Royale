CREATE TABLE "custom_round_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"round_type" text NOT NULL,
	"definition" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"takedown_reason" text,
	"taken_down_by" text,
	"taken_down_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_round_reports" ADD CONSTRAINT "custom_round_reports_round_id_custom_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."custom_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_round_reports" ADD CONSTRAINT "custom_round_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_rounds" ADD CONSTRAINT "custom_rounds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_round_reports_once_uq" ON "custom_round_reports" USING btree ("round_id","reporter_id");--> statement-breakpoint
CREATE INDEX "custom_round_reports_status_idx" ON "custom_round_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_rounds_code_uq" ON "custom_rounds" USING btree ("code");--> statement-breakpoint
CREATE INDEX "custom_rounds_owner_idx" ON "custom_rounds" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_rounds_status_idx" ON "custom_rounds" USING btree ("status","created_at");