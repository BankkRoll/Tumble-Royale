/**
 * The editor's view of the account API: the game's `ApiClient` (same origin,
 * so the player's stored session signs the requests) narrowed to sharing.
 */
import type { ApiClient } from '../game/api.ts';
import type { EditorApi } from './store.ts';

/**
 * Adapts an `ApiClient` for the editor store.
 *
 * @param client - Account API client.
 * @example
 * createEditorStore({ drafts, api: editorApi(new ApiClient(ENDPOINTS.api)) });
 */
export function editorApi(client: ApiClient): EditorApi {
  let guest: Promise<boolean | null> | null = null;
  return {
    signedIn: () => client.signedIn,
    isGuest: () => {
      guest ??= client.me().then(
        (me) => me.isGuest,
        () => {
          guest = null;
          return null;
        },
      );
      return guest;
    },
    fetchRound: (code) => client.customRound(code),
    publish: async (round, description) => (await client.publishCustomRound(round, description)).round,
    update: async (code, round, description) =>
      (await client.updateCustomRound(code, round, description)).round,
    mine: async () => (await client.myCustomRounds()).rounds,
    setPublished: async (code, published) => (await client.setCustomRoundPublished(code, published)).round,
    remove: (code) => client.deleteCustomRound(code),
    report: async (code, reason, details) => void (await client.reportCustomRound(code, reason, details)),
  };
}
