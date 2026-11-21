// Package r25-m4-classic (Round 2.5, M4; the lead's decision L2, 2026-11-20): TikTok stops creating classic Sales, App Promotion and Lead
// Generation campaigns, and ad groups under them, on 2027-01-01, and AMCP refuses them from that day (src/tiktok-manual-cutoff.ts, the dated
// provider deprecation `tiktok_manual_sales_app_lead_creates`).
//
// A test file that drives such a create to test something else, the website purchases pack or an ad group that needs a Sales campaign, pins the
// deprecation clock to the last second before that day, so that it does not turn red on it. Each test file runs in its own process, so the pin
// holds for the whole file; a test that is about the cut-off sets its own clock (tests/tiktok-manual-cutoff.test.mjs). The pin follows the
// date the registry holds, so a corrected date moves it too.
//
// The pin is the real time until that last second, and that last second after it (the lead's review S4-3): it never brings another entry's
// date forward, as a clock fixed at the last second of 2026 did (Reddit's refusal of 2026-12-08 was in effect in the pinned files weeks early),
// and a test added to such a file runs at the date every other test does. tests/tiktok-manual-cutoff.test.mjs pins this.
import {deprecationDate, providerDeprecation, setDeprecationClock} from '../../dist/src/provider-deprecations.js';

export const tiktokCutoffId = 'tiktok_manual_sales_app_lead_creates';
export function pinBeforeTiktokCutoff() {
  const lastSecond = deprecationDate(providerDeprecation(tiktokCutoffId)) - 1000;
  setDeprecationClock(() => Math.min(Date.now(), lastSecond));
}
