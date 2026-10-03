/**
 * drizzle-kit configuration. `pnpm exec drizzle-kit generate` writes SQL
 * migrations into ./drizzle, which the API applies on boot.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
