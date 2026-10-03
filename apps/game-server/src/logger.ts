/**
 * Structured (pino, JSON lines) logging for the game server.
 *
 * Rooms, the outbox and the matchmaker link log through a plain
 * `(msg: string) => void` so they stay free of a logging dependency;
 * {@link lineLogger} adapts that to pino, lifting the match id out of the
 * text into a `matchId` field (the same id the API logs as
 * `reqId: match-<id>` for that show's results) and picking a level from the
 * wording.
 */
import pino, { type Logger } from 'pino';

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  level?: string;
  serverId?: string;
  region?: string;
  /** Destination stream (tests). */
  stream?: pino.DestinationStream;
}

/**
 * Creates the process logger.
 *
 * @example
 * const logger = createLogger({ level: 'info', serverId: 'gs-1', region: 'eu' });
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: {
        service: 'game-server',
        ...(opts.serverId ? { serverId: opts.serverId } : {}),
        ...(opts.region ? { region: opts.region } : {}),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // Synchronous stdout (pino's default): an async buffer would lose the last lines on process.exit.
    opts.stream ?? pino.destination(1),
  );
}

const MATCH_ID = /\b(m_[A-Za-z0-9]{6,64})\b/;
const ROOM_ID = /\[rooms\] (?:created |removed )?(r\d+)\b/;
const ERROR_WORDS = /\bcrashed\b|\bdead\/|\bcannot read\b/;
const WARN_WORDS = /\bfailed\b|\brejected\b|\brefusing\b|\bunreachable\b|\banswered [45]\d\d\b/;

/**
 * Adapts pino to the `(msg) => void` log hook the room code uses.
 *
 * @param logger - Target logger.
 * @returns A line logger.
 */
export function lineLogger(logger: Logger): (msg: string) => void {
  return (msg) => {
    const fields: Record<string, string> = {};
    const match = MATCH_ID.exec(msg);
    if (match) fields.matchId = match[1]!;
    const room = ROOM_ID.exec(msg);
    if (room) fields.roomId = room[1]!;
    if (ERROR_WORDS.test(msg)) logger.error(fields, msg);
    else if (WARN_WORDS.test(msg)) logger.warn(fields, msg);
    else logger.info(fields, msg);
  };
}
