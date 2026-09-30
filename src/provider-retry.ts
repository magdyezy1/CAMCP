/** Normalize provider retry headers to a finite delay, bounded to one day. */
export function providerRetryDelay(response: Response, gateway: string, now = Date.now()): number | undefined {
  const header = response.headers.get('retry-after');
  let delay: number | undefined;
  if (header !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN,
      date = Date.parse(header);
    if (Number.isFinite(seconds)) delay = seconds * 1000;
    else if (Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  if (gateway === 'x_ads_native_action' && response.status === 429) {
    const reset = response.headers.get('x-account-rate-limit-reset') ?? response.headers.get('x-rate-limit-reset'),
      seconds = Number(reset);
    if (reset && Number.isFinite(seconds) && seconds > 0) {
      const server = Date.parse(response.headers.get('date') ?? ''),
        remaining = seconds * 1000 - (Number.isFinite(server) ? server : now);
      delay = Math.max(delay ?? 0, remaining);
    }
  }
  if (delay === undefined && response.status === 429) delay = 30000;
  return delay === undefined ? undefined : Math.max(1000, Math.min(86400000, Math.ceil(delay)));
}
