CREATE TABLE "achievement_stats" (
	"user_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_stats_user_id_metric_pk" PRIMARY KEY("user_id","metric")
);
--> statement-breakpoint
CREATE TABLE "login_streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"best" integer DEFAULT 0 NOT NULL,
	"last_claim_day" text,
	"claims" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_achievements" (
	"user_id" uuid NOT NULL,
	"achievement_id" text NOT NULL,
	"unlocked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_achievements_user_id_achievement_id_pk" PRIMARY KEY("user_id","achievement_id")
);
--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "reward_gems" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "reward_cosmetic" text;--> statement-breakpoint
ALTER TABLE "achievement_stats" ADD CONSTRAINT "achievement_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_streaks" ADD CONSTRAINT "login_streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- achievement-backfill
-- Achievement totals for shows played before achievements existed, from the
-- stored match history (custom lobbies never count, as in ingest). Metrics the
-- history does not record (grabs, emotes, parties) start at 0. Idempotent:
-- re-running it never lowers or double counts a value.
INSERT INTO "achievement_stats" ("user_id", "metric", "value")
SELECT s.user_id, s.metric, s.value FROM (
	SELECT mp.user_id, x.metric, count(*)::integer AS value
	FROM "match_participants" mp
	JOIN "matches" m ON m.id = mp.match_id AND m.queue <> 'custom'
	CROSS JOIN LATERAL (VALUES
		('showsPlayed', true),
		('crowns', mp.crowned),
		('runnerUps', mp.placement = 2 AND NOT mp.crowned)
	) AS x(metric, hit)
	WHERE mp.user_id IS NOT NULL AND x.hit
	GROUP BY mp.user_id, x.metric
	UNION ALL
	SELECT mp.user_id, x.metric, count(*)::integer AS value
	FROM "round_results" rr
	JOIN "match_rounds" mr ON mr.match_id = rr.match_id AND mr.round_index = rr.round_index
	JOIN "match_participants" mp ON mp.match_id = rr.match_id AND mp.participant_key = rr.participant_key
	JOIN "matches" m ON m.id = rr.match_id AND m.queue <> 'custom'
	CROSS JOIN LATERAL (VALUES
		('roundsQualified', rr.qualified),
		('racesQualified', rr.qualified AND mr.round_type = 'race'),
		('survivalsQualified', rr.qualified AND mr.round_type = 'survival'),
		('teamRoundsWon', rr.qualified AND mr.round_type = 'team'),
		('huntRoundsQualified', rr.qualified AND mr.round_type = 'hunt'),
		('logicRoundsQualified', rr.qualified AND mr.round_type = 'logic')
	) AS x(metric, hit)
	WHERE mp.user_id IS NOT NULL AND x.hit
	GROUP BY mp.user_id, x.metric
	UNION ALL
	SELECT f.user_id, 'finalsReached', count(*)::integer
	FROM (
		SELECT DISTINCT mp.user_id, mp.match_id
		FROM "round_results" rr
		JOIN "match_rounds" mr ON mr.match_id = rr.match_id AND mr.round_index = rr.round_index AND mr.round_type = 'final'
		JOIN "match_participants" mp ON mp.match_id = rr.match_id AND mp.participant_key = rr.participant_key
		JOIN "matches" m ON m.id = rr.match_id AND m.queue <> 'custom'
		WHERE mp.user_id IS NOT NULL
	) f
	GROUP BY f.user_id
	UNION ALL
	SELECT ps.user_id, 'bestWinStreak', ps.best_win_streak
	FROM "player_stats" ps
	WHERE ps.best_win_streak > 0
) s
JOIN "users" u ON u.id = s.user_id
ON CONFLICT ("user_id", "metric") DO UPDATE SET "value" = GREATEST("achievement_stats"."value", EXCLUDED."value");