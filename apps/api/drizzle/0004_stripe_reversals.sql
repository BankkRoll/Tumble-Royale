CREATE TABLE "payment_reversals" (
	"payment_intent" text PRIMARY KEY NOT NULL,
	"charge_id" text,
	"amount_cents" integer,
	"amount_refunded_cents" integer DEFAULT 0 NOT NULL,
	"dispute_id" text,
	"dispute_status" text,
	"gems_reversed" integer DEFAULT 0 NOT NULL,
	"adjustments" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "gem_debt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "payment_intent" text;--> statement-breakpoint
CREATE INDEX "payment_reversals_charge_idx" ON "payment_reversals" USING btree ("charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_payment_intent_uq" ON "purchases" USING btree ("payment_intent");