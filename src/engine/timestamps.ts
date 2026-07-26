/**
 * Timestamp recognition across the formats real logs actually use.
 *
 * A parsed timestamp is epoch milliseconds (UTC). Lines whose timestamps
 * carry no zone are treated as UTC — consistency across files matters more
 * for correlation than absolute wall-clock truth, and a zone offset control
 * can shift a whole file later.
 */

export interface TsMatch {
  ts: number;
  start: number;
  end: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 2026-07-26T02:14:04.612Z · 2026-07-26 02:14:04,612 · 2026/07/26 02:14:04 +01:00
const RE_ISO =
  /(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?/;

// 26/Jul/2026:02:14:04 +0000  (nginx/apache access logs)
const RE_CLF = /(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?/;

// Jul 26 02:14:04  (classic syslog — no year)
const RE_SYSLOG = /^([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/;

// 1753495200 · 1753495200123 · 1753495200.123  (epoch at line start or ts= value)
const RE_EPOCH = /^(\d{10})(?:(\d{3})|\.(\d{1,6}))?\b/;

/** Search the head of a line for any recognizable timestamp. */
export function findTimestamp(text: string, referenceYear?: number): TsMatch | null {
  const head = text.length > 96 ? text.slice(0, 96) : text;

  const iso = RE_ISO.exec(head);
  if (iso) {
    const ms = iso[7] ? Math.round(Number(`0.${iso[7]}`) * 1000) : 0;
    let ts = Date.UTC(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      Number(iso[6]),
      ms,
    );
    const zone = iso[8];
    if (zone && zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.replace(/[+:-]/g, "");
      const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0"));
      ts -= offMin * 60_000;
    }
    return { ts, start: iso.index, end: iso.index + iso[0].length };
  }

  const clf = RE_CLF.exec(head);
  if (clf) {
    const mon = MONTHS[clf[2]!.toLowerCase()];
    if (mon !== undefined) {
      let ts = Date.UTC(
        Number(clf[3]),
        mon,
        Number(clf[1]),
        Number(clf[4]),
        Number(clf[5]),
        Number(clf[6]),
      );
      const zone = clf[7];
      if (zone) {
        const sign = zone.startsWith("-") ? -1 : 1;
        const offMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
        ts -= offMin * 60_000;
      }
      return { ts, start: clf.index, end: clf.index + clf[0].length };
    }
  }

  const sys = RE_SYSLOG.exec(head);
  if (sys) {
    const mon = MONTHS[sys[1]!.toLowerCase()];
    if (mon !== undefined) {
      const year = referenceYear ?? new Date().getUTCFullYear();
      let ts = Date.UTC(year, mon, Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5]));
      // A "future" syslog date means the file is from last year (no year in format).
      if (referenceYear === undefined && ts > Date.now() + 48 * 3_600_000) {
        ts = Date.UTC(year - 1, mon, Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5]));
      }
      return { ts, start: 0, end: sys[0].length };
    }
  }

  const epoch = RE_EPOCH.exec(head);
  if (epoch) {
    const seconds = Number(epoch[1]);
    let ts = seconds * 1000;
    if (epoch[2]) ts += Number(epoch[2]);
    else if (epoch[3]) ts += Math.round(Number(`0.${epoch[3]}`) * 1000);
    return { ts, start: 0, end: epoch[0].length };
  }

  return null;
}

/** Parse a timestamp value from a structured field (JSON / logfmt). */
export function parseFieldTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: 10-digit seconds vs 13-digit millis vs already-ms.
    if (value > 1e12) return Math.round(value);
    if (value > 1e9) return Math.round(value * 1000);
    return null;
  }
  if (typeof value === "string") {
    const m = findTimestamp(value);
    if (m) return m.ts;
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return parseFieldTimestamp(asNum);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}
