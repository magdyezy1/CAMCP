import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * Executions that went beyond an owner's spending cap with the user's acknowledgement (WRT-05 Stage D). Under
 * enforcement `confirm` any operator may execute over a cap with cap_override_confirmed; the audit records it
 * (spend_cap_exceeded_with_confirmation) and the owner's health view reads it back here: how many in the window and the
 * latest ones, with the account, the rules exceeded, who executed it and their role, and the review. Read-only.
 */
const shown = 20;
export function capOverrides(store: Store, tenant: string, days = 30, now = Date.now()): JsonObject {
  const since = now - days * 86400000;
  // The policy check can record one execution more than once (its checks before and at dispatch): one per review.
  const matching = `SELECT max(seq) FROM audit WHERE tenant_id=? AND created_at>=? AND created_at<=?
      AND instr(event,'"event":"spend_cap_exceeded_with_confirmation"')>0 GROUP BY request_id`;
  const count = (store.db.prepare(`SELECT count(*) AS n FROM (${matching})`).get(tenant, since, now) as {n: number}).n;
  const rows = store.db
    .prepare(`SELECT request_id, event, created_at FROM audit WHERE seq IN (${matching}) ORDER BY seq DESC LIMIT ?`)
    .all(tenant, since, now, shown) as {request_id: string; event: string; created_at: number}[];
  const items = rows.map(row => {
    let event: JsonObject = {};
    try {
      event = JSON.parse(row.event);
    } catch {
      // An unreadable row is still counted and listed by its review.
    }
    // Rows written before the event named its actor and account: the review they belong to names them.
    const review =
      event.actor === undefined || event.gateway === undefined
        ? (store.db
            .prepare(
              "SELECT json_extract(data,'$.user_id') AS user_id, json_extract(data,'$.plan.gateway') AS gateway, json_extract(data,'$.plan.accountId') AS account_id FROM documents WHERE tenant_id=? AND kind='write_review' AND id=?",
            )
            .get(tenant, row.request_id) as JsonObject | undefined)
        : undefined;
    return {
      at: row.created_at,
      review_id: row.request_id,
      policy_id: event.policy_id ?? null,
      gateway: event.gateway ?? review?.gateway ?? null,
      account_id: event.account_id ?? review?.account_id ?? null,
      rules: [...new Set((Array.isArray(event.exceeded) ? event.exceeded : []).map((e: JsonObject) => e?.rule))].filter(
        r => typeof r === 'string',
      ),
      actor: event.actor ?? review?.user_id ?? null,
      actor_role: event.actor_role ?? null,
    };
  });
  return {
    window_days: days,
    count,
    needs_attention: count > 0,
    latest: items,
    meaning:
      'Reviewed executions that went beyond a spending cap with the user’s acknowledgement (enforcement confirm). Under block they are refused instead.',
  };
}
