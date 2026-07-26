/**
 * Log levels, normalized.
 *
 * Every ecosystem spells severity differently (ERROR/error/err/E/50/SEVERE…).
 * Internally a level is a small integer; UNKNOWN rows still render, they just
 * don't join level facets.
 */

export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
export type LevelName = (typeof LEVELS)[number];

export const enum Level {
  Error = 0,
  Warn = 1,
  Info = 2,
  Debug = 3,
  Trace = 4,
  Unknown = 5,
}

const TEXT: Record<string, Level> = {
  // canonical
  error: Level.Error,
  warn: Level.Warn,
  warning: Level.Warn,
  info: Level.Info,
  debug: Level.Debug,
  trace: Level.Trace,
  // common variants
  err: Level.Error,
  fatal: Level.Error,
  crit: Level.Error,
  critical: Level.Error,
  severe: Level.Error, // java.util.logging
  emerg: Level.Error, // syslog
  alert: Level.Error, // syslog
  panic: Level.Error, // go
  notice: Level.Info, // syslog
  fine: Level.Debug, // java.util.logging
  finer: Level.Trace,
  finest: Level.Trace,
  verbose: Level.Trace,
  // single letters (android logcat, some frameworks)
  e: Level.Error,
  w: Level.Warn,
  i: Level.Info,
  d: Level.Debug,
  v: Level.Trace,
};

/** pino/bunyan numeric levels. */
const NUMERIC: Array<[number, Level]> = [
  [50, Level.Error], // 50 error, 60 fatal
  [40, Level.Warn],
  [30, Level.Info],
  [20, Level.Debug],
  [10, Level.Trace],
];

export function levelFromText(raw: string): Level {
  const key = raw.trim().toLowerCase();
  return TEXT[key] ?? Level.Unknown;
}

export function levelFromNumber(n: number): Level {
  if (n >= 50) return Level.Error;
  for (const [floor, level] of NUMERIC) {
    if (n >= floor) return level;
  }
  return Level.Unknown;
}

export function levelName(level: Level): string {
  switch (level) {
    case Level.Error:
      return "ERROR";
    case Level.Warn:
      return "WARN";
    case Level.Info:
      return "INFO";
    case Level.Debug:
      return "DEBUG";
    case Level.Trace:
      return "TRACE";
    case Level.Unknown:
      return "—";
  }
}
