import {MirrorError} from './errors.js';
import type {Actor, CompiledRequest} from './types.js';

/**
 * Which request is a Business Profile notification-setting change, and who may make one (ARC-04): a leaf shared by the
 * notification family (src/google-business-notifications.ts, which re-exports both) and the place-action family's
 * verification, which imported each other before.
 */
const gateway = 'google_business_native_action',
  origin = 'https://mybusinessnotifications.googleapis.com';
export function businessNotificationKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.action === 'gmb_notification_ops/UPDATE_NOTIFICATION_SETTING' &&
    p.origin === origin &&
    p.method === 'PATCH' &&
    !p.specialTransport &&
    /^\/v1\/accounts\/\d+\/notificationSetting$/.test(p.path)
  );
}
export function assertBusinessNotificationActor(p: CompiledRequest, actor: Actor) {
  if (businessNotificationKind(p) && (actor.role !== 'admin' || actor.testAccount === true))
    throw new MirrorError(
      'ADMIN_REQUIRED',
      'Only a workspace administrator can change account-wide Business Profile notification destinations. Reviewer test accounts cannot perform this administrative change.',
      {},
      403,
    );
}
