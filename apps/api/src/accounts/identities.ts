/**
 * `DELETE /me/identities/:provider`: unlinks a sign-in method from the
 * signed-in account, refusing to remove the last one that works off-device.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { authIdentities, users } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { conflict, notFound, parse } from '../http/errors.ts';

/**
 * Sign-in methods that work on any device. The `device` identity only signs
 * back in on the browser holding its secret, so it never counts as a fallback.
 */
export const PORTABLE_PROVIDERS = ['discord', 'google', 'github', 'twitch', 'apple', 'email'] as const;

const ProviderParam = z.object({ provider: z.enum(PORTABLE_PROVIDERS) });

/**
 * Registers the identity management routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerIdentityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.delete('/me/identities/:provider', async (req) => {
    const auth = await requireUser(ctx, req);
    const { provider } = parse(ProviderParam, req.params);
    return ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select({ provider: authIdentities.provider, subject: authIdentities.subject })
        .from(authIdentities)
        .where(
          and(
            eq(authIdentities.userId, auth.userId),
            inArray(authIdentities.provider, [...PORTABLE_PROVIDERS]),
          ),
        )
        .for('update');
      if (!rows.some((r) => r.provider === provider)) throw notFound('Linked account');
      const remaining = rows.filter((r) => r.provider !== provider);
      if (remaining.length === 0) {
        throw conflict(
          'last_login_method',
          'Link another sign-in method first, or this Tumbler could not be signed into again',
        );
      }
      await tx
        .delete(authIdentities)
        .where(and(eq(authIdentities.userId, auth.userId), eq(authIdentities.provider, provider)));
      // `users.email` lets a later sign-in with the same address find this
      // account; keep it only while an email identity still vouches for it,
      // otherwise unlinking would not actually stop that address signing in.
      let email = remaining.find((r) => r.provider === 'email')?.subject ?? null;
      if (email) {
        // users.email is unique: another account may have taken the address
        // since, and writing it here would fail the whole unlink.
        const [holder] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
        if (holder && holder.id !== auth.userId) email = null;
      }
      await tx.update(users).set({ email }).where(eq(users.id, auth.userId));
      return { linkedProviders: [...new Set(remaining.map((r) => r.provider))] };
    });
  });
}
