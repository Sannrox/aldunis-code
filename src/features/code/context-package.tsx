import { useState } from "react";
import type { ContextPin, ContextReceipt } from "../../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function ContextPackageSummary({
  receipt,
  label = "Context",
}: {
  receipt: ContextReceipt;
  label?: string;
}) {
  const included = receipt.entries.filter((entry) => entry.omissionReason === null);
  const omitted = receipt.entries.length - included.length;
  return (
    <details className="context-receipt-card">
      <summary>
        <strong>{label}</strong>
        <span>
          {included.length} files · {formatBytes(receipt.totalBytes)}
          {" · "}approximately {receipt.estimatedTokens.toLocaleString()} tokens
        </span>
      </summary>
      <div className="context-package-entries">
        {receipt.entries.map((entry) => (
          <article className={entry.omissionReason ? "is-omitted" : ""} key={`${entry.source}:${entry.path}`}>
            <div>
              <strong title={entry.path}>{entry.path}</strong>
              <small>
                {entry.source === "provider_managed_instruction"
                  ? "Provider-managed instruction"
                  : entry.source === "aldunis_folder" ? "Pinned folder" : "Aldunis attachment"}
              </small>
            </div>
            <span>
              {entry.omissionReason
                ? `Omitted: ${entry.omissionReason}`
                : `${entry.type} · ${formatBytes(entry.bytes ?? 0)}${entry.truncated ? " · truncated" : ""}`}
            </span>
            {entry.digest && <code title={entry.digest}>sha256:{entry.digest.slice(0, 12)}</code>}
          </article>
        ))}
        {receipt.entries.length === 0 && <p>No repository files are included.</p>}
      </div>
      <footer>
        <span>{omitted} omitted</span>
        <code title={receipt.digest}>package {receipt.digest.slice(0, 12)}</code>
      </footer>
    </details>
  );
}

export function ContextPackagePanel({
  receipt,
  pins,
  busy,
  error,
  onAdd,
  onRemove,
  onClose,
}: {
  receipt: ContextReceipt | null;
  pins: ContextPin[];
  busy: boolean;
  error: string | null;
  onAdd: (pin: ContextPin) => void;
  onRemove: (pin: ContextPin) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<ContextPin["kind"]>("file");
  return (
    <aside
      className="context-package-panel"
      aria-label="Draft context package"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div><small>Aldunis-owned context</small><h2>Context package</h2></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close context package">×</button>
      </header>
      <div className="context-package-panel-body">
        <p>Paths are repository-relative. Folders resolve deterministically when the turn is submitted.</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          const input = path.trim();
          const value = input === "." || input === "./"
            ? "."
            : input.replace(/^\.?\//, "").replace(/\/+$/, "");
          if (!value) return;
          onAdd({ path: value, kind });
          setPath("");
        }}>
          <label>Pin type
            <select value={kind} onChange={(event) => setKind(event.target.value as ContextPin["kind"])}>
              <option value="file">File</option>
              <option value="folder">Folder</option>
            </select>
          </label>
          <label>Repository-relative path
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder=". or src/main.ts"
            />
          </label>
          <button type="submit" className="btn btn-default btn-sm">Pin {kind}</button>
        </form>
        <section aria-labelledby="context-pins-title">
          <h3 id="context-pins-title">Conversation pins</h3>
          {pins.length ? (
            <ul className="context-pin-list">
              {pins.map((pin) => (
                <li key={`${pin.kind}:${pin.path}`}>
                  <span><strong>{pin.path}</strong><small>{pin.kind}</small></span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(pin)} aria-label={`Remove ${pin.kind} ${pin.path}`}>Remove</button>
                </li>
              ))}
            </ul>
          ) : <p>No files or folders are pinned.</p>}
        </section>
        {busy && <p role="status">Resolving bounded package…</p>}
        {error && <p className="context-error" role="alert">{error}</p>}
        {receipt && <ContextPackageSummary receipt={receipt} label="Draft package" />}
      </div>
    </aside>
  );
}
