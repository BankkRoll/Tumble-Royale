ALTER TABLE "profiles" ADD COLUMN "tutorial_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "gems" integer;--> statement-breakpoint
-- The tutorial reward used to be marked only by an analytics event, which the
-- retention job deletes; carry every existing grant over before that happens.
UPDATE "profiles" AS p SET "tutorial_granted_at" = g."at"
FROM (
  SELECT "user_id", min("created_at") AS "at" FROM "events"
  WHERE "name" = 'grant:tutorial_complete' AND "user_id" IS NOT NULL
  GROUP BY "user_id"
) AS g
WHERE p."user_id" = g."user_id" AND p."tutorial_granted_at" IS NULL;
