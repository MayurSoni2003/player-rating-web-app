'use client';

import { useState, useRef, useCallback, DragEvent } from 'react';
import Link from 'next/link';

// ─── Response shape types from the API routes ─────────────────────────────────

interface IngestWarning {
  rowIndex: number;
  matchId: string;
  playerName: string;
  field: string;
  message: string;
}

interface IngestSuccess {
  success: true;
  summary: {
    sourceRows: number;
    cleanRows: number;
    duplicatesRemoved: number;
    uniquePlayers: number;
    uniqueMatches: number;
    playersInserted: number;
    matchesUpserted: number;
    appearancesUpserted: number;
  };
  warnings: IngestWarning[];
}

interface IngestError {
  success: false;
  error: string;
  detail?: string;
  summary?: {
    sourceRows: number;
    cleanRows: number;
    duplicatesRemoved: number;
    errors: { rowIndex: number; matchId: string; playerName: string; field: string; message: string }[];
    warnings: { rowIndex: number; matchId: string; playerName: string; field: string; message: string }[];
  };
}

interface RatingsSuccess {
  success: true;
  summary: {
    totalPlayers: number;
    rated: number;
    unrated: number;
    byAgeGroup: {
      U15: { rated: number; unrated: number };
      U17: { rated: number; unrated: number };
    };
    normalizationWarnings: number;
  };
}

interface RatingsError {
  success: false;
  error: string;
  detail?: string;
}

type UploadPhase =
  | 'idle'
  | 'ingesting'
  | 'recomputing'
  | 'done_full'       // ingest + recompute both succeeded
  | 'done_partial'    // ingest OK, recompute failed
  | 'error_ingest';   // ingest failed (recompute never ran)

// ─── Component ────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>('idle');

  // Results
  const [ingestResult, setIngestResult] = useState<IngestSuccess | null>(null);
  const [ingestError, setIngestError] = useState<IngestError | null>(null);
  const [ratingsResult, setRatingsResult] = useState<RatingsSuccess | null>(null);
  const [ratingsError, setRatingsError] = useState<RatingsError | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File validation ────────────────────────────────────────────────────────

  function validateFile(f: File): string | null {
    if (!f.name.toLowerCase().endsWith('.csv')) {
      return `"${f.name}" is not a CSV file. Please select a file ending in .csv`;
    }
    if (f.size === 0) {
      return 'The selected file is empty.';
    }
    if (f.size > 10 * 1024 * 1024) {
      return 'File is too large (max 10 MB).';
    }
    return null;
  }

  function handleFileChange(f: File | null) {
    if (!f) {
      setFile(null);
      setFileError(null);
      return;
    }
    const err = validateFile(f);
    setFileError(err);
    setFile(err ? null : f);
    // Reset result state when a new file is selected
    setPhase('idle');
    setIngestResult(null);
    setIngestError(null);
    setRatingsResult(null);
    setRatingsError(null);
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFileChange(dropped);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    // Client-side guard (belt + braces — validateFile() already ran on selection)
    const err = validateFile(file);
    if (err) {
      setFileError(err);
      return;
    }

    // Reset
    setIngestResult(null);
    setIngestError(null);
    setRatingsResult(null);
    setRatingsError(null);

    // ── Step 1: Ingest ──
    setPhase('ingesting');
    let ingest: IngestSuccess | IngestError;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/ingest', { method: 'POST', body: formData });
      ingest = await res.json();
    } catch (e) {
      setIngestError({
        success: false,
        error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      setPhase('error_ingest');
      return;
    }

    if (!ingest.success) {
      setIngestError(ingest as IngestError);
      setPhase('error_ingest');
      return;
    }

    setIngestResult(ingest as IngestSuccess);

    // ── Step 2: Recompute ratings ──
    setPhase('recomputing');
    let ratings: RatingsSuccess | RatingsError;
    try {
      const res = await fetch('/api/compute-ratings', { method: 'POST' });
      ratings = await res.json();
    } catch (e) {
      setRatingsError({
        success: false,
        error: `Network error during rating recompute: ${e instanceof Error ? e.message : String(e)}`,
      });
      setPhase('done_partial');
      return;
    }

    if (!ratings.success) {
      setRatingsError(ratings as RatingsError);
      setPhase('done_partial');
      return;
    }

    setRatingsResult(ratings as RatingsSuccess);
    setPhase('done_full');
  }

  const isInFlight = phase === 'ingesting' || phase === 'recomputing';
  const isDone = phase === 'done_full' || phase === 'done_partial';

  return (
    <div className="flex flex-col flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">

      {/* ── Back link ────────────────────────────────────────── */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-muted hover:text-foreground transition-colors text-sm mb-6"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        All players
      </Link>

      {/* ── Header ───────────────────────────────────────────── */}
      <header className="mb-8 animate-fade-in">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">Upload CSV</h1>
        <p className="text-muted text-sm sm:text-base">
          Upload a <code className="text-accent-hover text-xs bg-surface px-1.5 py-0.5 rounded">match_events.csv</code> to
          add or update match data. Existing records are updated in place — nothing is deleted.
        </p>
      </header>

      {/* ── Upload form ───────────────────────────────────────── */}
      {!isDone && (
        <form
          onSubmit={handleSubmit}
          className="glass-card p-6 sm:p-8 animate-fade-in"
          style={{ animationDelay: '0.05s' }}
        >
          {/* Drag-and-drop zone */}
          <div
            id="drop-zone"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              flex flex-col items-center justify-center gap-3
              border-2 border-dashed rounded-xl p-10 sm:p-14
              cursor-pointer transition-all duration-200
              ${isDragging
                ? 'border-accent bg-accent/5 scale-[1.01]'
                : file
                  ? 'border-success/40 bg-success/5'
                  : 'border-border hover:border-accent/40 hover:bg-surface-hover'
              }
            `}
          >
            {/* Icon */}
            {file ? (
              <svg className="w-10 h-10 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
              </svg>
            ) : (
              <svg className="w-10 h-10 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            )}

            {file ? (
              <div className="text-center">
                <p className="font-medium text-success text-sm">{file.name}</p>
                <p className="text-muted text-xs mt-0.5">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-sm font-medium">
                  {isDragging ? 'Drop the file here' : 'Drag & drop a CSV here'}
                </p>
                <p className="text-muted text-xs mt-1">or click to browse · .csv only</p>
              </div>
            )}

            <input
              ref={fileInputRef}
              id="csv-file-input"
              type="file"
              accept=".csv,text/csv,application/csv"
              className="hidden"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            />
          </div>

          {/* Client-side file error */}
          {fileError && (
            <div className="mt-3 p-3 bg-danger/5 border border-danger/15 rounded-lg">
              <p className="text-danger text-sm">{fileError}</p>
            </div>
          )}

          {/* Merge note */}
          <p className="mt-4 text-xs text-muted leading-relaxed">
            <span className="font-medium text-foreground/60">Re-upload behaviour:</span>{' '}
            This will be <em>merged</em> into the existing dataset. Existing players, matches, and appearances
            matched by their IDs are updated in place. New rows are added. Nothing is deleted. Ratings are
            recomputed immediately after.
          </p>

          {/* Submit */}
          <button
            id="upload-submit-btn"
            type="submit"
            disabled={!file || !!fileError || isInFlight}
            className={`
              mt-6 w-full flex items-center justify-center gap-2
              px-6 py-3 rounded-xl font-semibold text-sm
              transition-all duration-200
              ${!file || !!fileError || isInFlight
                ? 'bg-surface text-muted cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-white shadow-lg shadow-accent/20 hover:shadow-accent/30'
              }
            `}
          >
            {isInFlight ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {phase === 'ingesting' ? 'Ingesting data…' : 'Recomputing ratings…'}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Upload & Recompute Ratings
              </>
            )}
          </button>
        </form>
      )}

      {/* ── Progress indicators (shown while in flight) ───────── */}
      {isInFlight && (
        <div className="mt-4 glass-card p-4 flex items-center gap-3 animate-fade-in">
          <div className="flex gap-1.5">
            <StepDot done={false} active={phase === 'ingesting'} label="1" />
            <StepDot done={ingestResult !== null} active={phase === 'recomputing'} label="2" />
          </div>
          <p className="text-sm text-muted">
            Step {phase === 'ingesting' ? '1' : '2'} of 2:{' '}
            {phase === 'ingesting' ? 'Cleaning & storing CSV data…' : 'Recomputing player ratings…'}
          </p>
        </div>
      )}

      {/* ── Error: Ingest failed ──────────────────────────────── */}
      {phase === 'error_ingest' && ingestError && (
        <ErrorCard
          title="Upload failed"
          error={ingestError.error}
          detail={ingestError.detail}
          validationErrors={ingestError.summary?.errors}
          validationWarnings={ingestError.summary?.warnings}
          onRetry={() => {
            setPhase('idle');
            setIngestError(null);
          }}
        />
      )}

      {/* ── Results: done (full or partial) ──────────────────── */}
      {isDone && (
        <div className="space-y-4 animate-fade-in">

          {/* Ingest summary */}
          {ingestResult && (
            <div className="glass-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <CheckIcon className="text-success" />
                <h2 className="font-semibold text-base">Data ingested</h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryTile label="Source rows" value={ingestResult.summary.sourceRows} />
                <SummaryTile label="Clean rows" value={ingestResult.summary.cleanRows} />
                <SummaryTile label="Duplicates removed" value={ingestResult.summary.duplicatesRemoved} />
                <SummaryTile label="Players new" value={ingestResult.summary.playersInserted} dim={ingestResult.summary.playersInserted === 0} />
                <SummaryTile label="Matches upserted" value={ingestResult.summary.matchesUpserted} dim={ingestResult.summary.matchesUpserted === 0} />
                <SummaryTile label="Appearances upserted" value={ingestResult.summary.appearancesUpserted} dim={ingestResult.summary.appearancesUpserted === 0} />
                <SummaryTile label="Unique players" value={ingestResult.summary.uniquePlayers} />
                <SummaryTile label="Unique matches" value={ingestResult.summary.uniqueMatches} />
              </div>

              {/* Warnings */}
              {ingestResult.warnings.length > 0 && (
                <details className="mt-4">
                  <summary className="text-xs text-warning cursor-pointer hover:text-warning/80 transition-colors">
                    ⚠ {ingestResult.warnings.length} warning{ingestResult.warnings.length !== 1 ? 's' : ''} (non-fatal)
                  </summary>
                  <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                    {ingestResult.warnings.map((w, i) => (
                      <div key={i} className="text-xs p-2 bg-warning/5 border border-warning/10 rounded">
                        <span className="text-warning/80 font-medium">[Row {w.rowIndex}] {w.playerName} / {w.matchId}</span>
                        <span className="text-muted ml-1">— {w.field}: {w.message}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Ratings recompute: success */}
          {ratingsResult && (
            <div className="glass-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <CheckIcon className="text-success" />
                <h2 className="font-semibold text-base">Ratings recomputed</h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryTile label="Total players" value={ratingsResult.summary.totalPlayers} />
                <SummaryTile label="Rated" value={ratingsResult.summary.rated} />
                <SummaryTile label="Unrated" value={ratingsResult.summary.unrated} dim={ratingsResult.summary.unrated === 0} />
                <SummaryTile label="U15 rated" value={ratingsResult.summary.byAgeGroup.U15.rated} />
                <SummaryTile label="U17 rated" value={ratingsResult.summary.byAgeGroup.U17.rated} />
              </div>
            </div>
          )}

          {/* Ratings recompute: failed (partial success) */}
          {phase === 'done_partial' && ratingsError && (
            <div className="glass-card p-5 border border-warning/20">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-warning">
                    Data uploaded successfully, but rating recomputation failed
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {ratingsError.error}
                    {ratingsError.detail ? ` — ${ratingsError.detail}` : ''}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    Ratings may be stale until this is resolved. Retry by re-uploading the same file.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/"
              id="view-players-link"
              className="flex-1 flex items-center justify-center gap-2 px-5 py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-semibold text-sm transition-all shadow-lg shadow-accent/20 hover:shadow-accent/30"
            >
              View updated players list →
            </Link>
            <button
              onClick={() => {
                setFile(null);
                setFileError(null);
                setPhase('idle');
                setIngestResult(null);
                setIngestError(null);
                setRatingsResult(null);
                setRatingsError(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="px-5 py-3 border border-border-subtle hover:bg-surface-hover rounded-xl text-sm font-medium transition-colors text-muted hover:text-foreground"
            >
              Upload another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function StepDot({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <div className={`
      w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
      ${done ? 'bg-success text-white' : active ? 'bg-accent text-white' : 'bg-surface text-muted border border-border'}
    `}>
      {done ? '✓' : label}
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={`w-5 h-5 flex-shrink-0 ${className}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function SummaryTile({ label, value, dim = false }: { label: string; value: number; dim?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-bold font-mono ${dim ? 'text-muted' : 'text-foreground'}`}>
        {value}
      </div>
    </div>
  );
}

function ErrorCard({
  title,
  error,
  detail,
  validationErrors,
  validationWarnings,
  onRetry,
}: {
  title: string;
  error: string;
  detail?: string;
  validationErrors?: { rowIndex: number; matchId: string; playerName: string; field: string; message: string }[];
  validationWarnings?: { rowIndex: number; matchId: string; playerName: string; field: string; message: string }[];
  onRetry: () => void;
}) {
  return (
    <div className="glass-card p-6 border border-danger/20 animate-fade-in mt-4">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-danger text-sm">{title}</p>
          <p className="text-sm text-muted mt-1">{error}</p>
          {detail && <p className="text-xs text-muted mt-0.5">{detail}</p>}

          {/* Validation errors from the CSV pipeline */}
          {validationErrors && validationErrors.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-danger/80 mb-1.5">
                Errors ({validationErrors.length}):
              </p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {validationErrors.map((e, i) => (
                  <div key={i} className="text-xs p-2 bg-danger/5 border border-danger/10 rounded">
                    <span className="text-danger/80 font-medium">[Row {e.rowIndex}] {e.playerName} / {e.matchId}</span>
                    <span className="text-muted ml-1">— {e.field}: {e.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {validationWarnings && validationWarnings.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-warning/80 mb-1.5">
                Warnings ({validationWarnings.length}):
              </p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {validationWarnings.map((w, i) => (
                  <div key={i} className="text-xs p-2 bg-warning/5 border border-warning/10 rounded">
                    <span className="text-warning/80 font-medium">[Row {w.rowIndex}] {w.playerName} / {w.matchId}</span>
                    <span className="text-muted ml-1">— {w.field}: {w.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onRetry}
        className="mt-4 px-4 py-2 text-sm border border-border-subtle hover:bg-surface-hover rounded-lg transition-colors text-muted hover:text-foreground"
      >
        ← Try again
      </button>
    </div>
  );
}
