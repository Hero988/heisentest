import { useCallback, useEffect, useState } from "react";
import type { RowView } from "../engine/store";
import { DetailDrawer } from "./DetailDrawer";
import { FacetRail } from "./FacetRail";
import { FormatDialog } from "./FormatDialog";
import { fmtBytes, fmtCount } from "./format";
import { Hero } from "./Hero";
import { LogTable } from "./LogTable";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { useEngine } from "./useEngine";

export function App() {
  const engine = useEngine();
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<{ position: number; row: RowView } | null>(null);
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState<{ fileId: number; fileName: string } | null>(null);

  // Whole-window drag and drop, in every phase.
  useEffect(() => {
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void engine.addFiles([...e.dataTransfer.files]);
    };
    addEventListener("dragenter", onDragEnter);
    addEventListener("dragover", onDragOver);
    addEventListener("dragleave", onDragLeave);
    addEventListener("drop", onDrop);
    return () => {
      removeEventListener("dragenter", onDragEnter);
      removeEventListener("dragover", onDragOver);
      removeEventListener("dragleave", onDragLeave);
      removeEventListener("drop", onDrop);
    };
  }, [engine]);

  // New snapshot invalidates the selected position's meaning.
  useEffect(() => {
    setSelected(null);
  }, [engine.snapshot]);

  const pickTimeRange = useCallback(
    (range: [number, number] | null) => {
      engine.setFilters({ ...engine.filters, timeRange: range });
      if (range !== null) {
        // After the re-query lands, jump the table to the range start.
        void engine.positionForTime(range[0]).then((position) => setScrollTo(position));
      }
    },
    [engine],
  );

  if (engine.phase === "empty") {
    return <Hero engine={engine} dragging={dragging} />;
  }

  if (engine.phase === "loading") {
    return (
      <main className="loading">
        <div className="loading-box" role="status">
          <p className="loading-count mono">
            {engine.progress !== null
              ? `${fmtCount(engine.progress.rows)} lines · ${fmtBytes(engine.progress.bytes)}`
              : "reading…"}
          </p>
          <p className="loading-label">parsing locally — nothing is uploaded</p>
        </div>
      </main>
    );
  }

  const snapshot = engine.snapshot;
  return (
    <div className={`workbench${dragging ? " is-dropping" : ""}`}>
      <TopBar engine={engine} />
      {snapshot !== null && (
        <div className="workbench-body">
          <FacetRail
            engine={engine}
            snapshot={snapshot}
            onAdjust={(fileId, fileName) => setAdjusting({ fileId, fileName })}
          />
          <main className="workbench-main">
            {snapshot.histogram !== null && (
              <Timeline
                histogram={snapshot.histogram}
                timeRange={engine.filters.timeRange}
                onPick={pickTimeRange}
              />
            )}
            <LogTable
              engine={engine}
              count={snapshot.count}
              selected={selected?.position ?? null}
              onSelect={(position, row) =>
                setSelected((prev) => (prev?.position === position ? null : { position, row }))
              }
              scrollToPosition={scrollTo}
              onScrolled={() => setScrollTo(null)}
            />
            {selected !== null && (
              <DetailDrawer engine={engine} row={selected.row} onClose={() => setSelected(null)} />
            )}
          </main>
        </div>
      )}
      {adjusting !== null && (
        <FormatDialog
          engine={engine}
          fileId={adjusting.fileId}
          fileName={adjusting.fileName}
          onClose={() => setAdjusting(null)}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <p>Drop to add the file to this timeline</p>
        </div>
      )}
    </div>
  );
}
