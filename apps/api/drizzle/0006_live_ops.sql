CREATE TABLE "playlist_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
