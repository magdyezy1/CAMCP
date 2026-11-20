// Package r25-m4-classic (Round 2.5, M4; the lead's decision L2, 2026-11-20): TikTok stops creating classic Sales, App Promotion and Lead
// Generation campaigns, and ad groups under them, on 2027-01-01, and AMCP refuses them from that day (src/tiktok-manual-cutoff.ts, the dated
// provider deprecation `tiktok_manual_sales_app_lead_creates`).
//
// A test file that drives such a create to test something else, the website purchases pack or an ad group that needs a Sales campaign, pins the
// deprecation clock to the last second before that day, so that it does not turn red on it. Each test file runs in its own process, so the pin
// holds for the whole file; a test that is about the cut-off sets its own clock (tests/tiktok-manual-cutoff.test.mjs). The pin follows the
// date the registry holds, so a corrected date moves it too.
import {deprecationDate, providerDeprecation, setDeprecationClock} from '../../dist/src/provider-deprecations.js';

export const tiktokCutoffId = 'tiktok_manual_sales_app_lead_creates';
export function pinBeforeTiktokCutoff() {
  setDeprecationClock(() => deprecationDate(providerDeprecation(tiktokCutoffId)) - 1000);
}
