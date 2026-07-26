/**
 * A strptime subset — the convention every log tool already speaks
 * (lnav, Fluentd, Vector, GoAccess). Compiles a format string like
 * "%Y-%m-%d %H:%M:%S,%L" into a matcher that yields epoch milliseconds.
 *
 * Supported: %Y %y %m %b %B %d %e %H %I %M %S %L %f %p %z %Z %s %Q %%
 * (%s = epoch seconds, %Q = epoch milliseconds — the two epoch escapes
 * strptime never standardized; lnav and d3 each invented their own.)
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

interface Directive {
  pattern: string;
  apply?: (value: string, parts: TimeParts) => void;
}

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  pm: boolean | null;
  offsetMin: number | null;
  epochMs: number | null;
}

const DIRECTIVES: Record<string, Directive> = {
  Y: { pattern: "(\\d{4})", apply: (v, p) => (p.year = Number(v)) },
  y: { pattern: "(\\d{2})", apply: (v, p) => (p.year = 2000 + Number(v)) },
  m: { pattern: "(\\d{1,2})", apply: (v, p) => (p.month = Number(v) - 1) },
  b: {
    pattern: "([A-Za-z]{3})",
    apply: (v, p) => (p.month = MONTHS[v.toLowerCase()] ?? p.month),
  },
  B: {
    pattern: "([A-Za-z]{3,9})",
    apply: (v, p) => (p.month = MONTHS[v.toLowerCase()] ?? p.month),
  },
  d: { pattern: "(\\d{1,2})", apply: (v, p) => (p.day = Number(v)) },
  e: { pattern: " ?(\\d{1,2})", apply: (v, p) => (p.day = Number(v)) },
  H: { pattern: "(\\d{1,2})", apply: (v, p) => (p.hour = Number(v)) },
  I: { pattern: "(\\d{1,2})", apply: (v, p) => (p.hour = Number(v)) },
  M: { pattern: "(\\d{1,2})", apply: (v, p) => (p.minute = Number(v)) },
  S: { pattern: "(\\d{1,2})", apply: (v, p) => (p.second = Number(v)) },
  L: { pattern: "(\\d{1,3})", apply: (v, p) => (p.ms = Number(v.padEnd(3, "0"))) },
  f: { pattern: "(\\d{1,9})", apply: (v, p) => (p.ms = Number(v.slice(0, 3).padEnd(3, "0"))) },
  p: { pattern: "([AaPp][Mm])", apply: (v, p) => (p.pm = v.toLowerCase() === "pm") },
  s: { pattern: "(\\d{10})", apply: (v, p) => (p.epochMs = Number(v) * 1000) },
  Q: { pattern: "(\\d{13})", apply: (v, p) => (p.epochMs = Number(v)) },
  z: {
    pattern: "(Z|[+-]\\d{2}:?\\d{2})",
    apply: (v, p) => {
      if (v === "Z") p.offsetMin = 0;
      else {
        const sign = v.startsWith("-") ? -1 : 1;
        const digits = v.replace(/[+:-]/g, "");
        p.offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      }
    },
  },
  Z: { pattern: "([A-Za-z]{1,5})" }, // zone abbreviations: matched, not interpreted
};

export interface CompiledTimeFormat {
  /** Source-of-truth pattern text (for anchored embedding elsewhere). */
  regexSource: string;
  /** Parse a string; returns epoch ms or null. Assumes UTC unless %z present. */
  parse(value: string): number | null;
}

export function compileTimeFormat(format: string): CompiledTimeFormat | null {
  let source = "";
  const appliers: ((value: string, parts: TimeParts) => void)[] = [];
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!;
    if (ch !== "%") {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    const code = format[++i];
    if (code === undefined) return null;
    if (code === "%") {
      source += "%";
      continue;
    }
    const directive = DIRECTIVES[code];
    if (!directive) return null;
    source += directive.pattern;
    // Every directive owns exactly one capture group — keep indices aligned.
    appliers.push(directive.apply ?? (() => {}));
  }
  let re: RegExp;
  try {
    re = new RegExp(`^${source}$`);
  } catch {
    return null;
  }
  return {
    regexSource: source,
    parse(value: string): number | null {
      const m = re.exec(value.trim());
      if (!m) return null;
      const parts: TimeParts = {
        year: 1970,
        month: 0,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        ms: 0,
        pm: null,
        offsetMin: null,
        epochMs: null,
      };
      let group = 1;
      for (const apply of appliers) {
        apply(m[group++] ?? "", parts);
      }
      if (parts.epochMs !== null) return parts.epochMs;
      let hour = parts.hour;
      if (parts.pm === true && hour < 12) hour += 12;
      if (parts.pm === false && hour === 12) hour = 0;
      let ts = Date.UTC(parts.year, parts.month, parts.day, hour, parts.minute, parts.second, parts.ms);
      if (parts.offsetMin !== null) ts -= parts.offsetMin * 60_000;
      return Number.isFinite(ts) ? ts : null;
    },
  };
}
