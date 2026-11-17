// tiktok_brand_safety: POST /v1.3/tiktok_inventory_filters/update/ (API for Business v1.3, Brand Safety Hub). The
// decisive field is the account's current `brand_safety_type`, the inventory tier the update replaces (wider inventory
// can raise delivery and spend).
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_brand_safety',
  // Spend-affecting (the registry asks spendConfirmation), so it counts as money evidence (R1), not settings.
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_tiktok_inventory_filters_update',
    payload: {
      cover_all_ad_objectives: false,
      brand_safety_type: 'LIMITED_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    },
  },
  seed: () => ({
    hub: {
      cover_all_ad_objectives: false,
      brand_safety_type: 'STANDARD_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    },
  }),
  unpaginated: 'GET /v1.3/tiktok_inventory_filters/get/ returns one settings object without page_info or a cursor',
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/tiktok_inventory_filters/update/'),
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/tiktok_inventory_filters/get/')) return ok(structuredClone(state.hub));
    if (method === 'POST' && path.endsWith('/v1.3/tiktok_inventory_filters/update/')) {
      if (mode.partial) return failed('Brand safety settings could not be saved');
      state.hub = {
        ...state.hub,
        cover_all_ad_objectives: body.cover_all_ad_objectives,
        ...(body.brand_safety_type
          ? {
              brand_safety_type: body.brand_safety_type,
              category_exclusion_ids: body.category_exclusion_ids ?? [],
              vertical_sensitivity_id: body.vertical_sensitivity_id ?? '',
            }
          : {}),
      };
      return ok(structuredClone(state.hub));
    }
  },
  decisive: {change: state => (state.hub.brand_safety_type = 'EXPANDED_INVENTORY'), field: /brand_safety_type/},
};
