/**
 * The built-in sample incident — a deterministic, realistic two-file story
 * so the tool demonstrates itself before anyone risks a real file.
 *
 * Story: checkout-service leaks heap after a deploy, OOMs at 02:14:04.612,
 * the gateway returns 502s for two minutes, a restart recovers it.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SAMPLE_BASE_MS = Date.UTC(2026, 6, 26, 2, 0, 0);

const PATHS = ["/api/cart", "/api/checkout", "/api/pay", "/api/login", "/api/stock", "/healthz"];
const SERVICES = ["checkout", "payments", "auth", "inventory"];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clf(ms: number): string {
  const d = new Date(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())} +0000`;
}

export interface SampleFiles {
  app: { name: string; text: string };
  gateway: { name: string; text: string };
}

export function generateSample(): SampleFiles {
  const rand = mulberry32(0x5eed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const appLines: { ts: number; text: string }[] = [];
  const gwLines: { ts: number; text: string }[] = [];

  const app = (ts: number, level: string, service: string, msg: string, extra = "") => {
    appLines.push({
      ts,
      text: `{"time":"${iso(ts)}","level":"${level}","service":"${service}","msg":"${msg}"${extra}}`,
    });
  };

  for (let m = 0; m < 30; m++) {
    const perMin = 70 + Math.floor(rand() * 40);
    for (let i = 0; i < perMin; i++) {
      const ts = SAMPLE_BASE_MS + m * 60_000 + Math.floor(rand() * 60_000);
      if (rand() < 0.48) {
        const inSpike = ts >= SAMPLE_BASE_MS + 14 * 60_000 + 7_000 && ts <= SAMPLE_BASE_MS + 16 * 60_000;
        // During the outage, clients retry the failing endpoints — traffic
        // concentrates on them, which is exactly how real 502 storms look.
        const path =
          inSpike && rand() < 0.7 ? (rand() < 0.6 ? "/api/checkout" : "/api/pay") : pick(PATHS);
        let status = rand() < 0.03 ? 404 : 200;
        let latency = Math.floor(8 + rand() * 120);
        if (inSpike && (path === "/api/checkout" || path === "/api/pay") && rand() < 0.9) {
          status = 502;
          latency = Math.floor(3000 + rand() * 2500);
        }
        const ip = `203.0.113.${Math.floor(rand() * 254) + 1}`;
        gwLines.push({
          ts,
          text: `${ip} - - [${clf(ts)}] "GET ${path} HTTP/1.1" ${status} ${Math.floor(
            200 + rand() * 900,
          )} "-" "Mozilla/5.0" ${latency}ms`,
        });
      } else {
        const service = pick(SERVICES);
        const r = rand();
        if (r < 0.06) {
          app(ts, "debug", service, `cache ${rand() < 0.5 ? "hit" : "miss"} key=cart:${Math.floor(rand() * 90_000)}`);
        } else if (r < 0.12 && service === "payments") {
          app(ts, "info", service, "charge ok", `,"amount":${(rand() * 180 + 3).toFixed(2)},"provider":"stripe","latency_ms":${Math.floor(90 + rand() * 300)}`);
        } else if (r < 0.15) {
          app(ts, "warn", service, "retrying upstream call", `,"attempt":2,"reason":"timeout","latency_ms":${Math.floor(800 + rand() * 900)}`);
        } else {
          app(
            ts,
            "info",
            service,
            pick([
              "request handled",
              "session refreshed",
              "stock check ok",
              "token issued",
              "order draft saved",
            ]),
            `,"latency_ms":${Math.floor(5 + rand() * 90)}`,
          );
        }
      }
    }
    if (m >= 9 && m < 14) {
      app(
        SAMPLE_BASE_MS + m * 60_000 + 30_000,
        "warn",
        "checkout",
        `heap at ${80 + m - 8}% of limit after deploy 7f3c2a1`,
        `,"heap_pct":${80 + m - 8}`,
      );
    }
  }

  const oomTs = SAMPLE_BASE_MS + 14 * 60_000 + 4_612;
  appLines.push({
    ts: oomTs,
    text: `${iso(oomTs)} ERROR checkout - java.lang.OutOfMemoryError: Java heap space`,
  });
  appLines.push({ ts: oomTs, text: "\tat com.shop.cart.CartSerializer.write(CartSerializer.java:141)" });
  appLines.push({ ts: oomTs, text: "\tat com.shop.api.CheckoutHandler.handle(CheckoutHandler.java:52)" });
  appLines.push({ ts: oomTs, text: "\tat java.base/java.lang.Thread.run(Thread.java:840)" });
  app(oomTs + 300, "error", "checkout", "worker pool exhausted - rejecting requests");
  app(oomTs + 4_500, "info", "checkout", "process exited, supervisor restarting (attempt 1)");
  app(SAMPLE_BASE_MS + 15 * 60_000 + 41_000, "info", "checkout", "service healthy - heap 31% after restart", `,"heap_pct":31`);

  appLines.sort((a, b) => a.ts - b.ts);
  gwLines.sort((a, b) => a.ts - b.ts);

  return {
    app: { name: "checkout-app.log", text: appLines.map((l) => l.text).join("\n") + "\n" },
    gateway: { name: "gateway-access.log", text: gwLines.map((l) => l.text).join("\n") + "\n" },
  };
}
