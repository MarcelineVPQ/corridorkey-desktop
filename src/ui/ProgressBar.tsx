// The one progress bar (job rows, the running job's panel, the setup's download): a value out of a total, with
// the screen reader's progress role. The fill is the measured share; nothing is estimated here.
export function ProgressBar({ label, value, max, big = false }: { label: string; value: number; max: number; big?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={big ? "bar big" : "bar"} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
