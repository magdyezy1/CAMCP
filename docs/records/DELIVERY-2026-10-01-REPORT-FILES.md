---
status: record
tier: engineering
---

# Scheduled client report files — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `8b646ed`. Implementation: `363777e`. Batch 59 completes the stated B28 local client-pack scope with
scheduled file destinations.

## Delivered behavior

Reporting overview accepts local PDF/Excel destinations alongside owned Google Sheets tabs. Operators explicitly
choose one or both formats and saved branding, then confirm encrypted storage. The website presents this flow even
without a Sheets login. The existing scheduling engine keeps account, metric, date-window and partial-delivery
settings together, with its clock previews and original cancellation semantics. File delivery does not introduce
another scheduler, an external recipient or arbitrary filesystem paths.

Collection retains its scoped source snapshot, then queues a separate file job. The export freezes the source
fingerprint and presentation. Each successful format is encrypted with tenant/purpose/file-ID binding and retains
its byte count and SHA-256 receipt. A failed later format leaves earlier files available; explicit recovery uses the
original job and generates only missing formats. Existing receipts and bytes are validated before skipping them.
Source changes, wrong job identity, lost worker ownership and revoked access fail before further persistence.

PDF/Excel reuse the existing bounded renderers. Limits are 20 MiB per file, 256 MiB encrypted file storage per
workspace, 100 local destinations and 100 active reporting jobs. Renderer contention retries through bounded worker
backoff. Quota or rendering failures remain visible. Snapshot deletion and report retention remove associated
ciphertext, including orphan cleanup. The existing master-key backup/restore requirements still apply.

Status, delivery history and Operations link the original export and job. Download routes require a current session
and current access to every source, validate the retained source and bytes, and return `no-store` attachments.
Links are authenticated references, not public shares. The website constructs download paths from the original
export ID and known format, escapes labels, and ignores late route/identity responses. Format choices and storage
consent start unchecked. The destination form has explicit fields and responsive grid rules.

MCP adds `amcp_reporting_overview bind_file_destination` with a stable key, explicit confirmation and typed local
destination settings. Existing `export`, `export_status`, `schedule`, `retry` and `cancel` retain their identities.
No new native provider family, permission, dependency or schema migration is needed.

## Verification and limits

Ten backend tests cover real PDF/XLSX output, encrypted at-rest data, frozen branding, stable creation/export keys,
per-format retry, queue separation, one-time synthetic collection, current grants, original-job fencing, source and
receipt integrity, tenant isolation, role/confirmation, quotas, snapshot deletion, retention and authenticated HTTP
downloads. Four controller tests cover no-Sheets availability, explicit consent, safe links, escaping and late
responses. An MCP SDK journey validates advertised schemas, equivalent text/structured responses, original
Operations handoffs, revocation and zero provider requests. The combined group passed 25 tests without failures.
The original API, browser-controller and wrong-job cases were observed failing before their fixes.

Full suite, sanitized release and committed-source parity evidence are recorded in [PROGRESS.md](PROGRESS.md).
Logs remain in ignored `.runtime/report-file-delivery-20261001/`. The in-memory browser fixture now has a real
synthetic PDF/Excel delivery. New visual acceptance remains unverified because the browser control runtime cannot
initialize (`failed to write kernel assets: The system cannot find the path specified (os error 3)`). Controller and
HTTP tests do not replace desktop/mobile, keyboard or assistive-technology acceptance.

The matrix becomes **12 implemented / 14 partial / 2 open**. B28 describes scoped local file delivery; external
email, Drive-folder and object-storage destinations remain optional expansion, not shipped behavior. The remaining
blueprint packages retain their explicit gaps. Deployed queues, workload capacity, external MCP clients and live
provider acceptance have not been established by these synthetic checks.
