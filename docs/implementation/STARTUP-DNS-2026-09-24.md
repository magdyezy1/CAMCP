---
status: record
tier: engineering
---

# HTTP startup and public DNS incident — 2026-09-24

The user supplied Railway startup logs and a browser NXDOMAIN screenshot before
the Meta follow-on push. Reporting commit `0d8204d` was already pushed; the next
push was held for this investigation. Only Codex-branch is being changed.

## Confirmed code defects and corrections

1. `server/http.ts` wrote successful startup to stderr and substituted localhost
   for an actual wildcard binding. Railway classifies stderr as error, making the
   screenshot misleading. The corrected single-line JSON event is on stdout at
   info level and uses `listener.address()` for the actual host/port. Public origin
   is a separate field. This is a P2 observability defect, not evidence by itself
   that the deployed listener was inaccessible.
2. Express 5 passes listener errors to the listen callback. The old callback
   ignored that argument: a synthetic occupied-port test printed “listening” and
   exited zero with the worker disabled. With a worker, the process could remain
   running despite a failed listener. The corrected error branch emits
   `http_listen_failed`, shuts down the worker/store and exits nonzero. This is a
   P2 startup/recovery defect; no evidence ties this condition to the screenshot.

Port priority, container `0.0.0.0` binding, TLS origin requirements, host validation,
MCP authorization and health-check routing are preserved. HTTP startup logging is
separate from MCP stdio, which still reserves stdout for protocol messages.
No database migration or runtime dependency was added.

## Public observations — not a DNS repair

All timestamps below are UTC on September 24, from this workstation. DNS and
unauthenticated HTTPS probes used no credentials. Private deployment settings,
Cloudflare account details and registrant contact records were not accessed.

| Time / source | Observation |
|---|---|
| 16:48:14, system / 1.1.1.1 / 8.8.8.8 | A, AAAA and NS queries all returned ENOTFOUND (NXDOMAIN). |
| 16:48:54, public GMO registry RDAP | Domain registered September 6, 2026, expiry September 6, 2027; Cloudflare nameservers alexia and lewis; status client transfer prohibited, no explicit hold in this response. |
| 16:49:34, both assigned Cloudflare authorities | A/AAAA and NS/SOA records existed and agreed. The zone was not missing its public address records. |
| 16:52:09, .shop authority a.gmoregistry.net | NS and SOA for amcp.shop returned ENOTFOUND. A second authority timed out; a timeout is not corroborating NXDOMAIN. |
| 16:52:09, HTTPS /healthz via an address returned by Cloudflare authority | HTTP 200, JSON status up, normal hostname/SNI and certificate verification retained. No hosts-file change, certificate override or credential was used. |
| 16:53:39, registry referral | Registrar is HOSTINGER operations, UAB, IANA 1636. |
| 16:54:02, Hostinger RDAP | Same nameservers and future expiry; transfer prohibited / add period, no explicit clientHold/serverHold. Its database timestamp was September 6, so it does not establish current internal registrar state. |
| 17:04:28, final system / 1.1.1.1 / 8.8.8.8 recheck | A lookups still returned ENOTFOUND; normal DNS resolution was not restored by the code work. |

Inference: the failing DNS path is between parent delegation/recursive resolution
and the working Cloudflare zone. The exact registrar/registry cause is not proven;
do not assert an expired domain, pending verification, suspension or broken CNAME
without the corresponding current evidence. A normal transfer lock is not a DNS
hold. A Git push cannot restore missing registry delegation or clear a resolver's
negative cache. The working routed health probe is not proof that normal browser
access, OAuth or live provider workflows work.

**Operator action:** inspect Hostinger → Domains → amcp.shop for domain status,
contact-verification or delegation notices. Keep the assigned nameservers
`alexia.ns.cloudflare.com` and `lewis.ns.cloudflare.com` unless the actual zone
has moved. If no notice explains the failure, provide Hostinger support with the
observations above and ask it to verify/restore .shop delegation. No support
message was sent. Do not replace working Cloudflare records or weaken TLS/host
checks. After repair, verify normal recursive A/AAAA/NS answers, HTTPS health and
public pages, then authenticated MCP/reporting. No domain/cache/config mutation
was performed during this work.

Retained local public evidence under `.runtime/reporting-20260924/`:
`dns-public-20260924.json`, `dns-authorities-20260924.json`,
`dns-delegation-20260924.json`, `dns-registrar-20260924.json`,
`dns-registrar-status-20260924.json`. Initial sandbox DNS timeouts and failed DoH
fetches are environmental observations, not successful DNS tests; network-enabled
DNS probes supplied the results above. The initial unbounded sequential sandbox
probe was stopped; subsequent probes had explicit request deadlines.
The final recursive recheck is retained in `dns-final-20260924.json`.

## Verification

- `npm.cmd run build` passed in startup-build-1 through startup-build-4 logs.
- `node --test dist/tests/http-startup.test.js` against the original listener:
  all three expectations failed, preserving the logging and false-success repros
  in `startup-baseline.log`.
- First compatibility run: four passed, two failed because Node fetch replaced the
  requested Host header in the new test. The test now uses `node:http.request`
  to send that exact header. The 403 assertion and production middleware were not
  weakened. See `startup-focused-1.log`.
- Final focused command: `node --test dist/tests/http-startup.test.js
  dist/tests/deployment-smoke.test.js dist/tests/http.test.js
  dist/tests/optional-config.test.js`: **11 passed, zero failed/skipped**.
  Includes wildcard/loopback listeners, actual port override, correct log streams,
  host rejection, unauthenticated MCP refusal, public health, bind failure with
  worker enabled/disabled, report persistence smoke and required/optional config.
  `startup-focused-2.log` passed before the extra worker-enabled failure case;
  `startup-focused-3.log` is the expanded result.
- Final test review reused `tests/http-listener.ts` to allocate a Fetch-compatible
  port for the startup subprocess. This prevents the previously documented CI
  ephemeral-port failure without retrying any request or weakening an assertion.
  Root build-5 and `startup-port-fixture.log` passed eight focused tests.

Combined sanitized candidate `.release/startup-20260924-a` contains 553 files,
tree hash `607eea53c916f4ba717437a3ffce23d162f7d96039da9d20f334e2b72b610dcb`.
`npm.cmd ci --offline --ignore-scripts --cache <implementation>/.runtime/npm-cache`
and `npm.cmd run check` both exited 0; `AMCP_SCHEMA_PYTHON` used the bundled
Python. **1417 main tests passed, zero failed, one optional FFmpeg skip; four
capture tests passed.** All following generation/report/web/provider/lifecycle/
contract checks passed. Check log SHA256:
`e00dddafe1160bc57a2b05396df546b68e6e8507bb5e533bd504af079b492bb4`.

The only source delta in final candidate `.release/startup-20260924-b` is the
startup test's port allocator reuse; production code is byte-identical. Candidate
B contains 553 files, tree hash
`c74bcfbd1787de9fb0601089686d97ad01df8d86a5a2eae83d0ec7b0755ce3de`.
Offline install/build and the final startup/port/deployment/HTTP/configuration
suite passed **15 tests, zero failed/skipped**. The entire suite was not rerun for
this test-only adjustment. Final test log SHA256:
`5ac91220f3849ce286d6ac5e996f65c9388319dd310cb2d3b0bec74ec1990ae7`.
Both install logs SHA256:
`b6ebe3f0a3188e0db53898395a619cadcfee9b101220e0c450b99732d97df902`.
`git diff --check` and `node deploy/check-railway.mjs` passed. Node 24.19.0/
npm 11.17.0/Windows. The latter is a static compatibility check, not a container
run. Local FFmpeg-required mode, Docker and GitHub Actions remain unverified.
Remaining post-candidate edits only record documentation and verification evidence.

## Official references inspected September 24, 2026

- [Railway structured logs](https://docs.railway.com/observability/logs)
- [Express 5 listen callback errors](https://expressjs.com/en/guide/migrating-5/#app.listen)
- [Railway listener and target-port diagnosis](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
- [Railway custom domains](https://docs.railway.com/networking/domains/working-with-domains)
- [Cloudflare NXDOMAIN diagnosis](https://developers.cloudflare.com/dns/troubleshooting/dns-probe-finished-nxdomain/)
- [ICANN status-code meanings](https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en)
- [Hostinger domain verification](https://www.hostinger.com/support/domains/domain-verification/)
- [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json),
  [registry status](https://rdap.gmoregistry.net/rdap/domain/amcp.shop),
  [registrar status](https://rdap.hostinger.com/domain/amcp.shop)

Rollback: reverting only this HTTP patch does not migrate stored data, but restores
misleading startup and false-success handling. Do not roll back report definitions,
monthly schedules or uncertain-write receipts as a DNS workaround.

## Public recheck and Hostinger handoff, 19:08 UTC

Two independent public DNS-over-HTTPS resolvers (Google and Cloudflare) still
returned status 3 / NXDOMAIN for amcp.shop, with .shop authority SOA serial
1790276407. System DNS timed out. A prior unauthenticated HEAD returned HTTP 200,
which does not prove public delegation is healthy when these resolvers disagree
with that connection path. Registrar status and the cause remain unconfirmed.

Initial Node trust-store requests failed SELF_SIGNED_CERT_IN_CHAIN. Rechecking
with Node --use-system-ca retained certificate verification and returned the DNS
results above. No TLS validation, DNSSEC or production controls were disabled.
Local evidence: .runtime/contract-completion-20260924/public-dns-recheck.json and
public-dns-recheck-system-ca.json. No registrar/hosting account was accessed.

To check Hostinger: open Domains, manage amcp.shop, then Domain Overview. Inspect
status (active/pending verification/hold), expiration and nameservers. If contact
verification is pending, use the dashboard verification/resend flow and the domain
owner's email. Compare the displayed nameservers to the existing assigned
Cloudflare pair. Do not replace them with Hostinger defaults: AMCP uses its existing
Cloudflare/Railway setup. An active paid hosting plan alone does not prove domain
registry delegation or app availability. A shown hold or mismatch needs Hostinger
support or authorized registrar repair; NXDOMAIN alone does not identify its cause.

Official sources inspected September 24:
[Hostinger Domains overview](https://www.hostinger.com/support/6940479-how-to-use-the-domains-section-in-hostinger-dashboard/),
[contact verification](https://www.hostinger.com/support/1583442-how-to-fix-a-domain-suspended-due-to-pending-icann-verification-at-hostinger/),
[domain status](https://www.hostinger.com/support/6614690-how-to-check-a-domain-status-on-whois-at-hostinger/) and
[clientHold](https://www.hostinger.com/support/how-to-resolve-a-clienthold-domain-status-at-hostinger/).

## User-confirmed availability and current HTTPS result, 19:17 UTC

The user reports the website is working. Fresh TLS-verified HEAD requests to both
https://amcp.shop/ and /healthz returned HTTP 200 with no redirect, corroborating
current availability from the user and this HTTP connection path. Google and
Cloudflare DNS-over-HTTPS still returned NXDOMAIN with the previous .shop SOA.
These observations disagree; resolver caching/propagation is possible but its cause
is not proven. Do not describe the application as down or demand registrar repair
from the historical probe. No DNS/configuration change was made or is proposed
on the strength of that stale outage report. Keep the resolver discrepancy as an
unresolved public observation until independently reconciled. Local evidence:
.runtime/contract-completion-20260924/public-site-recheck-user-working.json,
checked 2026-09-24T19:17:44.806Z. This is public availability evidence, not proof
of authenticated workflows, provider permissions or production revision.
