import {providerById} from './provider-adapters.js';

/**
 * RPT-07: the Meta Insights attribution windows AMCP requests explicitly, under the names Meta's reporting uses. Wave 4c
 * round 6 (w4c-arc6-reporting): they are Meta's adapter facts (`reportWindows` in src/provider-adapters.ts, which holds
 * their rules and their sources), so shared reporting reads them without importing this module.
 */
const meta = providerById('meta')!.reportWindows!;
export const metaAttributionWindows = meta.windows;
export const metaClickWindows = meta.clickWindows;
export const metaWindowsMessage = meta.message;
/** Whether `windows` is one supported explicit Meta selection. */
export const metaWindowsValid = meta.valid;
/** The selected windows in the canonical order. */
export const metaWindowsOrdered = (windows: string[]) => metaAttributionWindows.filter(w => windows.includes(w));
