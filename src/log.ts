/**
 * Host logger.
 *
 * Two output modes:
 *
 *   LOG_FORMAT=text (default) — human-readable
 *     [HH:MM:SS.ms] LEVEL msg key="value" key2=42
 *     ANSI color is auto-enabled when both stdout and stderr are TTYs.
 *     Set NO_COLOR=1 (POSIX standard) to force off; FORCE_COLOR=1 to force on.
 *     This matters because the host is normally run with stdout/stderr
 *     redirected to a file via shell (`nohup pnpm dev > logs/...log`) —
 *     in that case isTTY is false and color is auto-disabled, so the log
 *     file stays clean and emailable / greppable without ANSI escapes.
 *
 *   LOG_FORMAT=json — newline-delimited JSON (one record per line)
 *     {"ts":"2026-05-15T...","level":"info","msg":"...","key":"value",
 *      "err":{"type":...,"message":...,"stack":...}}
 *     Suitable for jq, fluent-bit, Loki, etc.
 *
 * Level is gated by LOG_LEVEL (debug|info|warn|error|fatal); default info.
 */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

const useColor: boolean = (() => {
  // POSIX https://no-color.org/ — any non-empty value disables color.
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (
    process.env.FORCE_COLOR != null &&
    process.env.FORCE_COLOR !== '' &&
    process.env.FORCE_COLOR !== '0'
  )
    return true;
  // Default: only when both stdout and stderr are real terminals. When the
  // host is launched with `nohup ... > file 2>&1 &`, both isTTY are false
  // and we drop color automatically — admins reading log files won't see
  // \x1b[31m escape sequences anymore.
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
})();

const fmt: 'text' | 'json' = process.env.LOG_FORMAT === 'json' ? 'json' : 'text';

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function structuredErr(err: unknown): unknown {
  if (err instanceof Error) {
    return { type: err.constructor.name, message: err.message, stack: err.stack };
  }
  return err;
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const key = useColor ? `${KEY_COLOR}${k}${RESET}` : k;
    parts.push(`${key}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;

  if (fmt === 'json') {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        record[k] = k === 'err' ? structuredErr(v) : v;
      }
    }
    stream.write(JSON.stringify(record) + '\n');
    return;
  }

  const tag = useColor
    ? `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`
    : level.toUpperCase();
  const m = useColor ? `${MSG_COLOR}${msg}${RESET}` : msg;
  stream.write(`[${ts()}] ${tag} ${m}${data ? formatData(data) : ''}\n`);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
