---
status: record
tier: engineering
---

# Public About Us page — 4 October 2026

Batch 124 adds the owner-requested `/about` page. It explains AMCP's purpose, audience, connected workflow and
review process using the established ink/iris/paper identity. Public home navigation and the workspace footer
link to it; normal document navigation reaches it from the app. Its complete English HTML is readable without a
session or JavaScript. The optional Arabic interface uses the existing first-party catalog and persistent language
preference, including its heading, labels, title and policy links. No team names, customer counts or provider
endorsements are invented. Account options, permissions and supported native contracts remain the source of available
workflows.

The page uses two external first-party scripts and the local Arabic font. It has one main heading, ordered sections,
a working keyboard skip link, explicit navigation landmarks, policy links and account/workspace entry points. It
requires no account API, provider call or advertising mutation. The locale checker now covers marked messages in
every shipped HTML page so public content cannot silently evade Arabic validation.

The anonymous HTTP route regression reproduced a 404 before implementation; the content check reproduced the
missing document. After implementation, 26 relevant HTTP/localization/navigation checks passed, zero failures or
skips, in 1.090 seconds. Static checks passed for 34 scripts, three HTML pages and 3,052 explicitly selected Arabic
messages. Actual synthetic browser inspection covered English and Arabic at desktop (1280px) and phone (375px),
plus English 320px, with no horizontal overflow and all visible controls at least 44px high. Arabic remained selected
after document reload. Keyboard activation of the skip link focused `main`; Sign in reached the existing account
page. Screenshots are retained in the ignored `.runtime/about-us-20261004/` directory. These observations do not
constitute independent assistive-technology certification or deployed-site acceptance.

The full 28-package plan remains active. Adding this page does not close the remaining campaign, measurement,
commerce, performance, localization or provider-eligibility work. Sanitized build/report generation, exact committed
source qualification, tracked report freshness and the Railway/Docker CI are required before release acceptance.

The full check exposed an older route-asset inventory assertion that treated every browser controller as a SPA
dependency. It now derives standalone public scripts from their HTML declarations while preserving exact SPA
asset completeness and once-only initialization. All 33 focused checks pass, zero failures/skips, in 1.413 seconds.
Final sanitized preflight `.release/about-us-preflight-final2-20261004` passed offline install, build, early report
freshness, full check and Railway, each exit zero: 3,908 total / 3,903 passed / zero failures / five expected local
FFmpeg skips in 98.137 seconds, plus four capture checks in 80.012 ms. All three tracked reports stayed byte-identical;
separate isolated build/report generation confirmed freshness. 1,638 public sources plus one generated empty sample;
source hash 8be922ce320093fc735f5a185613246f52a7d2c2f6413c8f2a3829dc70e74f15. This preflight excludes the subsequently
recorded paragraphs; exact committed-source qualification follows before the sole push.
