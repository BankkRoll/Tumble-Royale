CREATE TABLE "status_incident_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"impact" text NOT NULL,
	"status" text NOT NULL,
	"components" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "status_uptime" (
	"component" text NOT NULL,
	"day" text NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"operational" integer DEFAULT 0 NOT NULL,
	"degraded" integer DEFAULT 0 NOT NULL,
	"partial" integer DEFAULT 0 NOT NULL,
	"major" integer DEFAULT 0 NOT NULL,
	"maintenance" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_uptime_component_day_pk" PRIMARY KEY("component","day")
);
--> statement-breakpoint
ALTER TABLE "status_incident_updates" ADD CONSTRAINT "status_incident_updates_incident_id_status_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."status_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_incident_updates_incident_idx" ON "status_incident_updates" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "status_incidents_started_idx" ON "status_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "status_incidents_resolved_idx" ON "status_incidents" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "status_uptime_day_idx" ON "status_uptime" USING btree ("day");