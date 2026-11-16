import type {ReviewVolatile} from './review-state-core.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';

/**
 * What changes by itself in Criteo's answers (R2.5 M1, L5-02): its campaign and line-item resources are flat, so the
 * flat-resource names apply (`updatedAt` is `updated_at`). The spend and budget meters of a line item are left out by
 * the targeting family's own projection (src/criteo-targeting-writes.ts), which names them. A leaf, so the adapter and
 * its campaign family share one table.
 */
export const criteoReviewVolatile: ReviewVolatile = flatResourceTelemetry;
