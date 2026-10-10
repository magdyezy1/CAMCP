// Dependency-free metadata vocabulary: schema construction must not depend on a service import cycle.
export const operationKinds = [
  'campaign',
  'upload',
  'report',
  'export',
  'schedule',
  'incident',
  'workbook_report',
  'workbook_schedule',
  // Standalone reviewed writes (WRT-08).
  'write',
];
export const operationStates = ['all', 'attention', 'active', 'complete', 'deferred'];
