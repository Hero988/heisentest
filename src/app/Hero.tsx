import { useRef } from "react";
import type { Engine } from "./useEngine";

interface Props {
  engine: Engine;
  dragging: boolean;
}

export function Hero({ engine, dragging }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <main className="hero">
      <div className="hero-inner">
        <p className="hero-kicker">heisentest</p>
        <h1>
          Open huge log files
          <br />
          in your browser.
        </h1>
        <p className="hero-standfirst">
          Drop a log — hundreds of megabytes are fine — and read it like a story: a timeline of
          every event, errors in red, filter-as-you-type, stack traces folded into their errors,
          several files merged into one investigation. Everything happens in this tab.{" "}
          <strong>Your file is never uploaded</strong> — it works with wifi off.
        </p>

        <div
          className={`hero-drop${dragging ? " is-hot" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
          }}
        >
          <p className="hero-drop-main">Drop a log file anywhere on this page</p>
          <p className="hero-drop-sub">or click to browse — .log, .txt, .jsonl, .out, anything text</p>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.currentTarget.files;
            if (list && list.length > 0) void engine.addFiles([...list]);
            e.currentTarget.value = "";
          }}
        />

        <p className="hero-or">
          No log file to hand?{" "}
          <button type="button" className="hero-sample" onClick={() => void engine.loadSample()}>
            Load the sample incident
          </button>{" "}
          — a two-file outage: heap leak, OOM, 502 storm, recovery.
        </p>

        {engine.error !== null && <p className="hero-error">{engine.error}</p>}

        <ul className="hero-points">
          <li>
            <strong>Reads the formats logs actually use.</strong> JSON lines, logfmt, nginx and
            Apache access logs, syslog, Java/Python/Go framework layouts — detected line by line,
            so mixed files still work. Anything unrecognized still loads as searchable text.
          </li>
          <li>
            <strong>The timeline shows you where to look.</strong> Every event bucketed over time,
            errors in red. The 2 a.m. spike is visible in one glance — click it and the table jumps
            there.
          </li>
          <li>
            <strong>Correlate across files.</strong> Drop the app log next to the gateway log:
            timestamps are normalized onto one merged timeline, so cause and effect line up.
          </li>
        </ul>

        <footer className="hero-foot">
          <a href="https://github.com/Hero988/heisentest">Source on GitHub</a> · Apache-2.0 ·
          free — a paid tier for teams (shared investigations) is planned; the analyzer stays free.
        </footer>
      </div>
    </main>
  );
}
