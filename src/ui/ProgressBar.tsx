// The one progress bar (job rows, the running job's panel, the setup's download): a value out of a total, with
// the screen reader's progress role. The fill is the measured share; nothing is estimated here. A total not known yet
// (max ≤ 0) is an indeterminate bar: no value or maximum, never a value above a maximum of 0 (senior review N4).
export function ProgressBar({ label, value, max, big = false }: { label: string; value: number; max: number; big?: boolean }) {
  const known = max > 0;
  const pct = known ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={`bar${big ? " big" : ""}${known ? "" : " indeterminate"}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? max : undefined}
      aria-valuenow={known ? value : undefined}
    >
      <span style={known ? { width: `${pct}%` } : undefined} />
    </div>
  );
}
