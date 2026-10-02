/**
 * @tumble/content — data only: round definitions, show playlists, cosmetics
 * catalog, themes and tuning. Every value is validated by a zod schema.
 *
 * The round schema itself lives in `@tumble/shared` so `@tumble/sim` can consume
 * round data without depending on this package.
 */
export {
  RoundDefinitionSchema,
  defineRound,
  type RoundDefinition,
  type RoundDefinitionInput,
} from '@tumble/shared';
