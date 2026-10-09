import {
  currentGoogleAdsCapture,
  extendGoogleAdsTool,
  googleAdsActionVersion,
  googleAdsVersion,
} from './google-version.js';
import {currentMetaCapture, metaActionVersion, metaApiVersion} from './meta-version.js';
import {
  currentLinkedInCapture,
  extendLinkedInTool,
  linkedinActionVersion,
  linkedinVersion,
} from './linkedin-version.js';
import type {Action, JsonObject, ToolDefinition} from './types.js';

/**
 * Gateways whose captured catalog AMCP sends at a newer provider version than it was captured at. Each says how a
 * catalog action, a captured LIST_ACTIONS page or DESCRIBE_ACTION response, and (when its text names a version) the
 * tool definition read at the version sent. The registry, introspection and the capture verification all use this
 * table, so a listing never claims one version while requests go to another.
 */
export const catalogVersions: Record<
  string,
  {
    version: string;
    action: (a: Action) => Action;
    capture: (data: JsonObject) => JsonObject;
    tool?: (tool: ToolDefinition) => ToolDefinition;
  }
> = {
  google_ads_native_action: {
    version: googleAdsVersion,
    action: googleAdsActionVersion,
    capture: currentGoogleAdsCapture,
    tool: extendGoogleAdsTool,
  },
  meta_native_action: {version: metaApiVersion, action: metaActionVersion, capture: currentMetaCapture},
  // The captured LinkedIn catalog reports 202605 (its li-lms-2026-05 snapshot); AMCP sends the reviewed version (PRV-02).
  linkedin_native_action: {
    get version() {
      return linkedinVersion();
    },
    action: linkedinActionVersion,
    capture: currentLinkedInCapture,
    tool: extendLinkedInTool,
  },
};
/** A captured page or description of this gateway, as AMCP answers it now. */
export const currentCapture = (gateway: string, data: JsonObject): JsonObject =>
  catalogVersions[gateway]?.capture(data) ?? data;
