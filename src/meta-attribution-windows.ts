/**
 * RPT-07: the Meta Insights attribution windows AMCP requests explicitly. Meta removed the 7-day and 28-day view
 * windows on 2026-01-12 and retains 1-day, 7-day and 28-day click, 1-day view and 1-day engaged-view (`1d_ev`)
 * (Meta for Developers blog, 2025-10-16). A selection names at most one click window, plus the optional view and
 * engaged-view windows; the canonical order below is the order AMCP sends and labels them in.
 */
export const metaAttributionWindows = Object.freeze(['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev']);
export const metaClickWindows = Object.freeze(['1d_click', '7d_click', '28d_click']);
export const metaWindowsMessage =
  'Choose at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.';
/** Whether `windows` is one supported explicit Meta selection. */
export function metaWindowsValid(windows: unknown): windows is string[] {
  return (
    Array.isArray(windows) &&
    windows.length > 0 &&
    windows.length <= 3 &&
    new Set(windows).size === windows.length &&
    windows.every(v => typeof v === 'string' && metaAttributionWindows.includes(v)) &&
    windows.filter(v => metaClickWindows.includes(v)).length <= 1
  );
}
/** The selected windows in the canonical order. */
export const metaWindowsOrdered = (windows: string[]) => metaAttributionWindows.filter(w => windows.includes(w));
