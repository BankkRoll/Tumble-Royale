/**
 * The dependency bag handed to every route module. Built once in `app.ts`;
 * tests build it with in-memory PGlite, the memory KV and a fixed clock.
 */
import type { Mailer } from './auth/mailer.ts';
import type { Catalog, CatalogCosmetic } from './catalog.ts';
import type { ApiConfig } from './config.ts';
import type { Db } from './db/client.ts';
import type { PaymentProvider } from './economy/payments.ts';
import type { KV } from './kv/index.ts';
import type { Notifier } from './realtime/notifier.ts';

/** Shared services for route handlers. */
export interface AppContext {
  config: ApiConfig;
  db: Db;
  kv: KV;
  catalog: Catalog;
  /** Cosmetics by id. */
  cosmetics: ReadonlyMap<string, CatalogCosmetic>;
  /** Wall clock. Injected so store rotation, cooldowns and token expiry are testable. */
  now: () => Date;
  mailer: Mailer;
  payments: PaymentProvider;
  /** HTTP client for OAuth providers (stubbed in tests). */
  fetch: typeof fetch;
  notifier: Notifier;
}
