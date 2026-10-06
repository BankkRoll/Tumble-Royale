/**
 * `/auth/*` routes: guest device sign-in, refresh rotation, logout, OAuth
 * (Discord, Google), email magic links and the one-time login-code exchange.
 * Every sign-in re-applies bans retained from a deleted account that shared an
 * identity, email address or device secret (`moderation/ban-evasion.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createAccount,
  findIdentity,
  linkIdentity,
  RegionSchema,
  type IdentityProvider,
} from '../accounts/accounts.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { invalidateBanCache, optionalUser, requireUser } from '../http/auth.ts';
import { reapplyRetainedBans, type StableIdentifier } from '../moderation/ban-evasion.ts';
import { disconnectSessionFamily } from '../realtime/disconnect.ts';
import { ApiError, parse } from '../http/errors.ts';
import { AUTH_RATE, limitGuestSignups } from '../http/rate-limit.ts';
import { completeOAuth, startOAuth, type OAuthProviderId } from './oauth.ts';
import {
  revokeByRefreshToken,
  revokeBySessionId,
  rotateSession,
  startSession,
  type TokenPair,
} from './sessions.ts';
import { randomToken, sha256 } from './tokens.ts';
import { eq } from 'drizzle-orm';

const LOGIN_CODE_TTL_MS = 60_000;
const MAGIC_LINK_TTL_MS = 15 * 60_000;

const GuestBody = z.object({
  deviceToken: z.string().min(20).max(200).optional(),
  displayName: z.string().max(32).optional(),
  /** Only used when a new guest is created; existing accounts keep their region. */
  region: RegionSchema.optional(),
});
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const LogoutBody = z.object({ refreshToken: z.string().min(20).max(200).optional() }).optional();
const ProviderParam = z.object({ provider: z.enum(['discord', 'google']) });
const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});
const CodeBody = z.object({ code: z.string().min(16).max(128) });
const EmailStartBody = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
});
const EmailVerifyBody = z.object({ token: z.string().min(20).max(200) });

/**
 * What a completed OAuth / magic-link sign-in did, so the client can say so
 * honestly and ask before replacing the Tumbler on the device:
 * - `linked`: the identity now belongs to the signed-in account;
 * - `alreadyLinked`: it already did;
 * - `switched`: the signed-in account asked to link it, but another account
 *   owns it, so the tokens are for that other account (sign-in on a new device);
 * - `signedIn`: no account was signed in and an existing one owns it;
 * - `created`: no account owned it, so a new one was made.
 */
export type AuthOutcome = 'linked' | 'alreadyLinked' | 'switched' | 'signedIn' | 'created';

/** Body of `/auth/exchange` and `/auth/email/verify`: the session plus what happened. */
export type AuthResult = TokenPair & { outcome: AuthOutcome; provider: 'discord' | 'google' | 'email' };

/** Signs in (or creates/links) the account behind an external identity. */
async function resolveIdentity(
  tx: DbOrTx,
  ctx: AppContext,
  id: {
    provider: IdentityProvider;
    subject: string;
    email: string | null;
    name: string | null;
    linkUserId: string | null;
  },
): Promise<{ userId: string; outcome: AuthOutcome }> {
  const owner = await findIdentity(tx, id.provider, id.subject);
  if (id.linkUserId) {
    // The player proved they control the identity, so handing them the account
    // that owns it is safe; the client confirms before abandoning the current one.
    if (owner && owner !== id.linkUserId) return { userId: owner, outcome: 'switched' };
    if (owner) return { userId: owner, outcome: 'alreadyLinked' };
    await linkIdentity(tx, id.linkUserId, id.provider, id.subject, id.email);
    return { userId: id.linkUserId, outcome: 'linked' };
  }
  if (owner) return { userId: owner, outcome: 'signedIn' };
  if (id.email) {
    const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, id.email));
    if (byEmail) {
      await linkIdentity(tx, byEmail.id, id.provider, id.subject, id.email);
      return { userId: byEmail.id, outcome: 'signedIn' };
    }
  }
  const account = await createAccount(tx, ctx.catalog, {
    isGuest: false,
    email: id.email,
    ...(id.name ? { displayName: id.name.replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 16) } : {}),
    identity: { provider: id.provider, subject: id.subject },
  });
  return { userId: account.userId, outcome: 'created' };
}

/**
 * Resolves an OAuth or email identity to an account, re-applies any ban that
 * outlived a deleted account with the same identity or address, then starts
 * a session. The account change commits before the session is minted, so a
 * re-applied `all` ban sticks even though this sign-in is then refused.
 *
 * @throws {ApiError} 403 `banned` while the resolved account is suspended.
 */
async function signInWithIdentity(
  ctx: AppContext,
  id: Parameters<typeof resolveIdentity>[2],
  userAgent: string | undefined,
): Promise<TokenPair & { outcome: AuthOutcome }> {
  const { userId, outcome, reapplied } = await ctx.db.transaction(async (tx) => {
    const resolved = await resolveIdentity(tx, ctx, id);
    const presented: StableIdentifier[] = [{ kind: 'identity', provider: id.provider, subject: id.subject }];
    if (id.email) presented.push({ kind: 'email', email: id.email });
    return { ...resolved, reapplied: await reapplyRetainedBans(tx, ctx, resolved.userId, presented) };
  });
  if (reapplied > 0) await invalidateBanCache(ctx, userId);
  const pair = await ctx.db.transaction((tx) =>
    startSession(tx, ctx.config.jwtSecret, userId, ctx.now(), userAgent),
  );
  return { ...pair, outcome };
}

/**
 * Registers `/auth/*`.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const secret = ctx.config.jwtSecret;

  app.post('/auth/guest', { config: AUTH_RATE }, async (req) => {
    const body = parse(GuestBody, req.body ?? {});
    const ua = req.headers['user-agent'];
    const offered = body.deviceToken;
    const account = await ctx.db.transaction(async (tx) => {
      if (offered) {
        const userId = await findIdentity(tx, 'device', sha256(offered));
        if (userId) {
          const reapplied = await reapplyRetainedBans(tx, ctx, userId);
          return { userId, deviceToken: offered, created: false, reapplied };
        }
      }
      // Device tokens are server-issued, so an unknown one means local data
      // from a wiped server (or a deleted account); start a fresh guest rather
      // than failing the launch.
      await limitGuestSignups(ctx, req.ip);
      let deviceToken = randomToken();
      const created = await createAccount(tx, ctx.catalog, {
        isGuest: true,
        ...(body.region ? { region: body.region } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
        identity: { provider: 'device', subject: sha256(deviceToken) },
      });
      const presented: StableIdentifier[] = offered
        ? [{ kind: 'identity', provider: 'device', subject: sha256(offered) }]
        : [];
      const reapplied = await reapplyRetainedBans(tx, ctx, created.userId, presented);
      if (reapplied > 0 && offered) {
        // SECURITY: the offered secret belonged to a deleted, banned account.
        // Binding it to the new account makes every retry land on this same
        // suspended account instead of minting a fresh one each launch.
        await linkIdentity(tx, created.userId, 'device', sha256(offered));
        deviceToken = offered;
      }
      return { userId: created.userId, deviceToken, created: true, reapplied };
    });
    if (account.reapplied > 0) await invalidateBanCache(ctx, account.userId);
    const pair = await ctx.db.transaction((tx) => startSession(tx, secret, account.userId, ctx.now(), ua));
    return { ...pair, deviceToken: account.deviceToken, created: account.created };
  });

  app.post('/auth/refresh', { config: AUTH_RATE }, async (req) => {
    const { refreshToken } = parse(RefreshBody, req.body);
    return rotateSession(ctx.db, secret, refreshToken, ctx.now(), req.headers['user-agent']);
  });

  app.post('/auth/logout', async (req, reply) => {
    const body = parse(LogoutBody, req.body);
    if (body?.refreshToken) {
      await revokeByRefreshToken(ctx.db, body.refreshToken, ctx.now());
      await disconnectSessionFamily(ctx.db, ctx.kv, { refreshToken: body.refreshToken });
    } else {
      const auth = await requireUser(ctx, req);
      await revokeBySessionId(ctx.db, auth.sessionId, ctx.now());
      await disconnectSessionFamily(ctx.db, ctx.kv, { sessionId: auth.sessionId });
    }
    return reply.code(204).send();
  });

  app.get('/auth/providers', async () => ({
    discord: Boolean(ctx.config.discord),
    google: Boolean(ctx.config.google),
    email: ctx.mailer.id !== 'disabled',
    guest: true,
  }));

  app.get('/auth/:provider/start', { config: AUTH_RATE }, async (req, reply) => {
    const { provider } = parse(ProviderParam, req.params);
    return reply.redirect(await startOAuth(ctx.config, ctx.kv, provider, null));
  });

  // POST lets a signed-in guest start an upgrade: browsers cannot attach an
  // Authorization header to a top-level navigation, so the URL is returned instead.
  app.post('/auth/:provider/start', { config: AUTH_RATE }, async (req) => {
    const { provider } = parse(ProviderParam, req.params);
    const auth = await optionalUser(ctx, req);
    return { url: await startOAuth(ctx.config, ctx.kv, provider, auth?.userId ?? null) };
  });

  app.get('/auth/:provider/callback', async (req, reply) => {
    const { provider } = parse(ProviderParam, req.params);
    const q = parse(CallbackQuery, req.query);
    const back = `${ctx.config.publicWebUrl}/auth/complete?provider=${provider}`;
    const fail = (code: string) => reply.redirect(`${back}&error=${encodeURIComponent(code)}`);
    if (q.error || !q.code || !q.state) return fail(q.error ?? 'missing_code');
    try {
      const identity = await completeOAuth(
        ctx.config,
        ctx.kv,
        ctx.fetch,
        provider as OAuthProviderId,
        q.code,
        q.state,
      );
      const result = {
        ...(await signInWithIdentity(ctx, identity, req.headers['user-agent'])),
        provider,
      };
      const code = randomToken(24);
      await ctx.kv.set(`login:${code}`, JSON.stringify(result), LOGIN_CODE_TTL_MS);
      return reply.redirect(`${back}&code=${code}`);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.code);
      throw err;
    }
  });

  // Tokens never travel in a redirect URL; the client trades this one-time code for them.
  app.post('/auth/exchange', { config: AUTH_RATE }, async (req) => {
    const { code } = parse(CodeBody, req.body);
    const raw = await ctx.kv.getDel(`login:${code}`);
    if (!raw) throw new ApiError(400, 'invalid_code', 'Login code expired or already used');
    return JSON.parse(raw) as AuthResult;
  });

  app.post('/auth/email/start', { config: AUTH_RATE }, async (req, reply) => {
    const { email } = parse(EmailStartBody, req.body);
    if (ctx.mailer.id === 'disabled') {
      throw new ApiError(
        503,
        'provider_disabled',
        'Email sign-in is not configured on this server (set SMTP_URL)',
      );
    }
    const auth = await optionalUser(ctx, req);
    const sends = await ctx.kv.incr(`email-rate:${email}`, 60 * 60_000);
    if (sends > 5) throw new ApiError(429, 'too_many_emails', 'Too many sign-in emails; try again later');
    const token = randomToken();
    await ctx.kv.set(
      `magic:${sha256(token)}`,
      JSON.stringify({ email, linkUserId: auth?.userId ?? null }),
      MAGIC_LINK_TTL_MS,
    );
    const link = `${ctx.config.publicWebUrl}/auth/email?token=${token}`;
    try {
      await ctx.mailer.send({
        to: email,
        subject: 'Your Tumble Royale sign-in link',
        text: `Tap to sign in to Tumble Royale:\n\n${link}\n\nThis link expires in 15 minutes. If you did not ask for it, ignore this email.`,
      });
    } catch (err) {
      req.log.error({ err }, 'sign-in email failed');
      await ctx.kv.del(`magic:${sha256(token)}`);
      throw new ApiError(502, 'email_failed', "We couldn't send the email right now; try again in a minute");
    }
    return reply.code(202).send({ sent: true });
  });

  app.post('/auth/email/verify', { config: AUTH_RATE }, async (req) => {
    const { token } = parse(EmailVerifyBody, req.body);
    const raw = await ctx.kv.getDel(`magic:${sha256(token)}`);
    if (!raw) throw new ApiError(400, 'invalid_token', 'Sign-in link expired or already used');
    const { email, linkUserId } = JSON.parse(raw) as { email: string; linkUserId: string | null };
    const signedIn = await signInWithIdentity(
      ctx,
      { provider: 'email', subject: email, email, name: null, linkUserId },
      req.headers['user-agent'],
    );
    return { ...signedIn, provider: 'email' } satisfies AuthResult;
  });
}
