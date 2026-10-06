CREATE TABLE "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid,
	"recipient_id" uuid,
	"idempotency_key" text NOT NULL,
	"offer_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"currency" text NOT NULL,
	"price" integer NOT NULL,
	"message" text,
	"message_masked" text,
	"status" text NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"auto_accepted" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"user_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_items_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "wishlist_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"visibility" text DEFAULT 'friends' NOT NULL,
	"alerts" boolean DEFAULT true NOT NULL,
	"last_alert_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_settings" ADD CONSTRAINT "wishlist_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gifts_sender_key_uq" ON "gifts" USING btree ("sender_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gifts_recipient_idx" ON "gifts" USING btree ("recipient_id","status","created_at");--> statement-breakpoint
CREATE INDEX "gifts_sender_idx" ON "gifts" USING btree ("sender_id","created_at");--> statement-breakpoint
CREATE INDEX "gifts_pending_expiry_idx" ON "gifts" USING btree ("status","expires_at");