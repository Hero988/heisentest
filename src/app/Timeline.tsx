import { useCallback, useEffect, useRef } from "react";
import type { SerializedHistogram } from "../engine/protocol";
import { fmtBucket, fmtDateTime } from "./format";

interface Props {
  histogram: SerializedHistogram;
  timeRange: [number, number] | null;
  onPick: (range: [number, number] | null) => void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Timeline({ histogram, timeRange, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);

    const { total, errors, warns, bucketMs, startMs } = histogram;
    const n = total.length;
    if (n === 0) return;
    let max = 1;
    for (const t of total) if (t > max) max = t;

    const axisY = height - 15;
    g.strokeStyle = cssVar("--line");
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, axisY + 0.5);
    g.lineTo(width, axisY + 0.5);
    g.stroke();

    const bw = width / n;
    const barW = Math.max(1, bw - Math.min(3, bw * 0.25));
    for (let i = 0; i < n; i++) {
      const x = i * bw + (bw - barW) / 2;
      const bucketStart = startMs + i * bucketMs;
      const inRange =
        timeRange !== null && bucketStart >= timeRange[0] && bucketStart <= timeRange[1];
      const t = total[i]!;
      const e = errors[i]!;
      const w = warns[i]!;
      const th = ((axisY - 4) * t) / max;
      const eh = ((axisY - 4) * e) / max;
      const wh = ((axisY - 4) * w) / max;

      g.globalAlpha = timeRange === null || inRange ? 0.45 : 0.15;
      g.fillStyle = inRange ? cssVar("--thread-a") : cssVar("--muted");
      g.fillRect(x, axisY - th, barW, th);

      g.globalAlpha = timeRange === null || inRange ? 1 : 0.3;
      if (wh > 0) {
        g.fillStyle = cssVar("--level-warn");
        g.fillRect(x, axisY - eh - wh, barW, wh);
      }
      if (eh > 0) {
        g.fillStyle = cssVar("--verdict-fail");
        g.fillRect(x, axisY - eh, barW, eh);
      }
    }
    g.globalAlpha = 1;

    // Sparse time labels.
    g.fillStyle = cssVar("--muted");
    g.font = `10px ${cssVar("--font-mono") || "monospace"}, monospace`;
    const labelEvery = Math.max(1, Math.ceil(n / Math.floor(width / 84)));
    for (let i = 0; i < n; i += labelEvery) {
      const ms = startMs + i * bucketMs;
      g.fillText(new Date(ms).toISOString().slice(11, 19), i * bw + 2, height - 4);
    }
  }, [histogram, timeRange]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => draw();
    media.addEventListener("change", onTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onTheme);
    };
  }, [draw]);

  const pick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const i = Math.floor(((event.clientX - rect.left) / rect.width) * histogram.total.length);
      if (i < 0 || i >= histogram.total.length) return;
      const from = histogram.startMs + i * histogram.bucketMs;
      const to = from + histogram.bucketMs - 1;
      if (timeRange !== null && timeRange[0] === from && timeRange[1] === to) {
        onPick(null); // clicking the selected bucket clears it
      } else {
        onPick([from, to]);
      }
    },
    [histogram, onPick, timeRange],
  );

  const spanStart = histogram.startMs;
  const spanEnd = histogram.startMs + histogram.total.length * histogram.bucketMs;

  return (
    <div className="tl">
      <div className="tl-head">
        <h2>Timeline</h2>
        <span className="tl-win mono">
          {fmtDateTime(spanStart)} → {fmtDateTime(spanEnd)} UTC · {fmtBucket(histogram.bucketMs)}{" "}
          buckets · click a bar to zoom the table to it
        </span>
        {timeRange !== null && (
          <button type="button" className="tl-clear" onClick={() => onPick(null)}>
            clear time filter ✕
          </button>
        )}
      </div>
      <canvas ref={canvasRef} className="tl-canvas" onClick={pick} aria-label="Events over time; errors highlighted in red" />
    </div>
  );
}
