import {MirrorError} from '../src/errors.js';
import {assertDownloadAllowed} from '../src/export-policy.js';
import {exportCsv} from '../src/report-table.js';
import {reportEvidence} from '../src/report-quality.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {sha256} from '../src/security.js';
import {handler, type WebsiteSite} from './website-site.js';

/**
 * Report file downloads (SEC-05: each checks that the person may download): the detailed evidence workbook, retained
 * report files, report packs, report evidence metadata and the campaign report CSV. Only where the MCP service runs.
 */
export function reportDownloadRoutes({router, store, web, service}: WebsiteSite) {
  if (!service) return;
  router.get(
    '/api/reporting-evidence/:id.xlsx',
    handler(async (req, res) => {
      const session = web.requireSession(req),
        tenant = session.actor.tenantId,
        id = String(req.params.id),
        language = req.query.language ?? 'en';
      assertDownloadAllowed(store, session.actor);
      if (typeof language !== 'string' || !['en', 'ar'].includes(language))
        throw new MirrorError('INVALID_ARGUMENT', 'Choose an evidence workbook language: en or ar.', {}, 400);
      const report = store.document(tenant, 'decision_report', id);
      store.resolveConnection(session.actor, report.gateway, report.account_id, report.connection_id);
      const {evidenceArtifact} = await import('../src/evidence-artifacts.js');
      const bytes = await evidenceArtifact(tenant, {...report, id}, language);
      const current = web.requireSession(req);
      if (current.actor.tenantId !== tenant || current.actor.userId !== session.actor.userId)
        throw new MirrorError('FORBIDDEN', 'The report session changed.', {}, 403);
      assertDownloadAllowed(store, current.actor);
      store.resolveConnection(current.actor, report.gateway, report.account_id, report.connection_id);
      const retained = store.document(tenant, 'decision_report', id);
      if (retained.revision !== report.revision)
        throw new MirrorError(
          'REVISION_CONFLICT',
          'The evidence changed during generation. Download it again.',
          {},
          409,
        );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="AMCP-detailed-evidence.xlsx"');
      res.setHeader('X-Content-SHA256', sha256(bytes));
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(bytes);
    }),
  );
  for (const format of ['pdf', 'xlsx'] as const)
    router.get(
      '/api/reporting-files/:id.' + format,
      handler((req, res) => {
        const session = web.requireSession(req),
          overview = new ReportingOverview(service);
        assertDownloadAllowed(store, session.actor);
        const file = overview.files.download(session.actor, String(req.params.id), format);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'attachment; filename="AMCP-retained-report.' + format + '"');
        res.setHeader('X-Content-SHA256', file.sha256);
        res.type(file.mime_type).send(file.bytes);
      }),
    );
  for (const format of ['pdf', 'xlsx'] as const)
    router.get(
      '/api/reporting-overview/:id.' + format,
      handler(async (req, res) => {
        const session = web.requireSession(req),
          tenant = session.actor.tenantId,
          id = String(req.params.id);
        assertDownloadAllowed(store, session.actor);
        const overview = new ReportingOverview(service),
          report = store.document(tenant, 'overview_report', id);
        overview.access(session.actor, report.config);
        const {retainedPresentation} = await import('../src/report-packs.js');
        const {reportArtifact} = await import('../src/report-artifacts.js');
        const style = retainedPresentation(store, tenant, id);
        const bytes = await reportArtifact(tenant, report, format, style.presentation);
        const current = web.requireSession(req);
        if (current.actor.tenantId !== tenant || current.actor.userId !== session.actor.userId)
          throw new MirrorError('FORBIDDEN', 'The report session changed.', {}, 403);
        assertDownloadAllowed(store, current.actor);
        const retained = store.document(tenant, 'overview_report', id);
        overview.access(current.actor, retained.config);
        if (
          retained.revision !== report.revision ||
          retainedPresentation(store, tenant, id).presentation_revision !== style.presentation_revision
        )
          throw new MirrorError(
            'REVISION_CONFLICT',
            'The report or presentation changed during generation. Download it again.',
            {},
            409,
          );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'attachment; filename="AMCP-report-pack.' + format + '"');
        res
          .type(
            format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .send(bytes);
      }),
    );
  router.get(
    '/api/reporting-overview/:id.metadata.json',
    handler((req, res) => {
      const session = web.requireSession(req);
      assertDownloadAllowed(store, session.actor);
      const report = store.document(session.actor.tenantId, 'overview_report', String(req.params.id));
      new ReportingOverview(service).access(session.actor, report.config);
      res.setHeader('Content-Disposition', 'attachment; filename=AMCP-report-evidence.json');
      res.json(reportEvidence(report));
    }),
  );
  router.get(
    '/api/reporting-overview/:id.csv',
    handler((req, res) => {
      const session = web.requireSession(req);
      assertDownloadAllowed(store, session.actor);
      const report = store.document(session.actor.tenantId, 'overview_report', String(req.params.id));
      new ReportingOverview(service).access(session.actor, report.config);
      const csv = exportCsv(report);
      res.setHeader('Content-Disposition', 'attachment; filename=AMCP-campaign-report.csv');
      res.type('text/csv').send(csv);
    }),
  );
}
