CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"amount" integer NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"player_reason" text,
	"decision_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"provider_refund_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_purchase_uq" ON "refunds" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "refunds_user_idx" ON "refunds" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refunds_provider_refund_idx" ON "refunds" USING btree ("provider_refund_id");