-- Invites sent by officers whose accounts were deleted still name them; the
-- new foreign key would refuse those rows.
UPDATE "club_invites" SET "invited_by" = NULL
WHERE "invited_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."id" = "club_invites"."invited_by");--> statement-breakpoint
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_match_credits_match_idx" ON "event_match_credits" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "matches_ended_idx" ON "matches" USING btree ("ended_at");
