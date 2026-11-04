import type {JsonObject} from './types.js';

export type ReportStatus = 'active' | 'paused' | 'archived' | 'unknown';
export interface ReportStatusEvidence {
  status: ReportStatus;
  native_status: string | null;
  effective_status: string | string[] | null;
  deleted?: true;
}
export type ReportStatusReader = (
  raw: JsonObject,
  context: {level: string; metadata?: JsonObject},
) => ReportStatusEvidence;
export const currentStatusUnavailableWarning =
  'Current native entity status could not be read. Status filters exclude unknown entities and keep the source partial.';

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value);

/** Provider leaves supply the enum map. Serving holds never substitute for an advertiser's configured status. */
export function reportStatus(
  value: unknown,
  states: Readonly<Record<string, Exclude<ReportStatus, 'unknown'>>>,
  effective: unknown = null,
  deleted = false,
): ReportStatusEvidence {
  const native = text(value) ? value : null;
  return {
    status: deleted ? 'archived' : native && Object.hasOwn(states, native) ? states[native]! : 'unknown',
    native_status: native,
    effective_status: text(effective)
      ? effective
      : Array.isArray(effective) && effective.length <= 50 && effective.every(text)
        ? [...effective]
        : null,
    ...(deleted ? {deleted: true as const} : {}),
  };
}
