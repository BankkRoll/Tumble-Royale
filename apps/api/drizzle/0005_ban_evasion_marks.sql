CREATE TABLE "ban_evasion_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ban_id" uuid NOT NULL,
	"identifier_hash" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bans" ADD COLUMN "evasion_of" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ban_evasion_marks_ban_identifier_uq" ON "ban_evasion_marks" USING btree ("ban_id","identifier_hash");--> statement-breakpoint
CREATE INDEX "ban_evasion_marks_identifier_idx" ON "ban_evasion_marks" USING btree ("identifier_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bans_user_evasion_uq" ON "bans" USING btree ("user_id","evasion_of");