/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Account API base URL for this deployment. */
  readonly VITE_API_URL?: string;
  /** Matchmaker base URL for this deployment. */
  readonly VITE_MATCHMAKER_URL?: string;
  /** Game server WebSocket URL (`wss://…/ws`) for this deployment. */
  readonly VITE_GAME_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
