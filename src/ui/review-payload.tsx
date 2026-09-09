import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { HostContext, ToolResultCard } from "./card-types.js";
import {
  fileChangeKindLabel,
  getRenderedFileChangePathDisplay,
  getRenderedFileChangeKind,
  type FileChangeKind,
} from "./patch-display.js";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext: _hostContext,
  errorMessage = null,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const files = useMemo(() => parseFiles(patch), [patch]);
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const visibleFiles = showAllFiles ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  if (files.length === 1) {
    return (
      <div className="review-single-file pretty-scrollbar">
        <ReviewFileBody fileDiff={files[0]} />
      </div>
    );
  }

  return (
    <>
      <div className="review-diff pretty-scrollbar">
        <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);
          const changeKind = getRenderedFileChangeKind(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
              type: fileDiff.type,
            },
            index,
          );
          const pathDisplay = getRenderedFileChangePathDisplay(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
            },
            index,
          );

          return (
            <div className="review-diff-file" key={key}>
              <button
                type="button"
                className="review-diff-file-header"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(openFiles);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  setOpenFiles(next);
                }}
              >
                <span
                  className={`review-file-kind ${changeKind}`}
                  role="img"
                  title={fileChangeKindLabel(changeKind)}
                  aria-label={fileChangeKindLabel(changeKind)}
                >
                  {fileChangeSymbol(changeKind)}
                </span>
                {pathDisplay?.previous ? (
                  <span
                    className="review-diff-file-name renamed"
                    title={pathDisplay.title}
                  >
                    <span className="review-diff-file-path previous">
                      {pathDisplay.previous}
                    </span>
                    <span className="review-diff-file-arrow">→</span>
                    <span className="review-diff-file-path current">
                      {pathDisplay.current}
                    </span>
                  </span>
                ) : (
                  <span className="review-diff-file-name" title={pathDisplay?.title ?? fileDiff.name}>
                    {pathDisplay?.current ?? fileDiff.name}
                  </span>
                )}
                <span className="review-diff-file-stats">
                  <span className="add">+{stats.additions}</span>
                  <span className="remove">-{stats.removals}</span>
                </span>
              </button>
              {isOpen ? (
                <ReviewFileBody fileDiff={fileDiff} />
              ) : null}
            </div>
          );
          })}
        </div>
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="review-more"
          onClick={() => setShowAllFiles(true)}
        >
          Show {hiddenCount} more {hiddenCount === 1 ? "file" : "files"}
        </button>
      ) : null}
    </>
  );
}

interface ReviewLine {
  kind: "context" | "addition" | "deletion" | "hunk";
  oldLine?: number;
  newLine?: number;
  text: string;
}

function ReviewFileBody({ fileDiff }: { fileDiff: FileDiffMetadata }) {
  const lines = useMemo(() => buildReviewLines(fileDiff), [fileDiff]);
  if (lines.length === 0) {
    return <StatusLine message="No textual diff is available for this file." />;
  }

  return (
    <div className="review-code pretty-scrollbar" role="table" aria-label={`Diff for ${fileDiff.name}`}>
      {lines.map((line, index) => (
        <div
          className={`review-code-line ${line.kind}`}
          role="row"
          key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}
        >
          {line.kind === "hunk" ? (
            <div className="review-code-hunk" role="cell">{line.text}</div>
          ) : (
            <>
              <span className="review-code-number" role="cell">{line.oldLine ?? ""}</span>
              <span className="review-code-number" role="cell">{line.newLine ?? ""}</span>
              <span className="review-code-sign" role="cell" aria-hidden="true">
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
              </span>
              <code className="review-code-text" role="cell">{line.text || " "}</code>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function buildReviewLines(fileDiff: FileDiffMetadata): ReviewLine[] {
  const lines: ReviewLine[] = [];

  for (const hunk of fileDiff.hunks) {
    lines.push({
      kind: "hunk",
      text: stripTrailingNewline(
        hunk.hunkSpecs
          ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
      ),
    });

    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          const text = fileDiff.additionLines[segment.additionLineIndex + index]
            ?? fileDiff.deletionLines[segment.deletionLineIndex + index]
            ?? "";
          lines.push({
            kind: "context",
            oldLine,
            newLine,
            text: stripTrailingNewline(text),
          });
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }

      for (let index = 0; index < segment.deletions; index += 1) {
        lines.push({
          kind: "deletion",
          oldLine,
          text: stripTrailingNewline(fileDiff.deletionLines[segment.deletionLineIndex + index] ?? ""),
        });
        oldLine += 1;
      }
      for (let index = 0; index < segment.additions; index += 1) {
        lines.push({
          kind: "addition",
          newLine,
          text: stripTrailingNewline(fileDiff.additionLines[segment.additionLineIndex + index] ?? ""),
        });
        newLine += 1;
      }
    }
  }

  return lines;
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function fileChangeSymbol(kind: FileChangeKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "edited":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
    case "renamed-edited":
      return "R";
    case "unknown":
      return "•";
  }
}

function parseFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={`status ${tone}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {message}
    </div>
  );
}
