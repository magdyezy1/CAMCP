// MSR-03 slice D: a synthetic copy of TikTok's SDK specification of "Get Pixel Event statistics" and the pin
// tools/tiktok-event-stats-pin.mjs records from it. Synthetic: its commit and bytes are not TikTok's, so it stands for
// the state after the owner pins the real file and is never committed as the deployment's pin.
import {tiktokEventStatsPinFrom} from '../../tools/tiktok-event-stats-pin.mjs';

export const syntheticTiktokCommit = '0123456789abcdef0123456789abcdef01234567';
export const syntheticTiktokSpecification = [
  'openapi: 3.0.1',
  'paths:',
  '  /open_api/v1.3/pixel/event/stats/:',
  '    get:',
  '      summary: Get Pixel Event statistics',
  '      parameters:',
  '        - name: advertiser_id',
  '          in: query',
  '          required: true',
  '        - name: pixel_ids',
  '          in: query',
  '          required: true',
  '        - name: date_range',
  '          in: query',
  '          required: true',
  '          content:',
  '            application/json:',
  '              schema:',
  '                properties:',
  '                  start_date:',
  '                    type: string',
  '                  end_date:',
  '                    type: string',
  '',
].join('\n');
export const syntheticTiktokEventStatsPin = tiktokEventStatsPinFrom(syntheticTiktokSpecification, {
  commit: syntheticTiktokCommit,
  checkedAt: '2026-10-17',
});
