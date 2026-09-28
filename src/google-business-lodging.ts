import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Business Profile lodging facts, per the pinned Lodging API v1 Discovery document (business-lodging-v1, revision
 * 20260902: locations.updateLodging and locations.getLodging, Lodging and the messages it holds; checked 2026-09-28)
 * and the Lodging reference. PATCH /v1/locations/{id}/lodging?updateMask= updates the fields the mask names; "Repeated field
 * items cannot be individually updated", and "*" would also unset every empty field, so it stays out. metadata.updateTime is
 * "Required. The latest time at which the Lodging data is asserted to be true in the real world", an RFC 3339 UTC "Zulu"
 * timestamp. A fact and its <fact>Exception form one union: only one of them is set. allUnits, someUnits and
 * greenBuildingDesign are output only. The review reads the location (Voice of Merchant, open status) and the lodging;
 * verification reads the lodging again.
 */
type Read = CompiledRequest & {businessLodgingRead?: 'lodging' | 'location'; businessLodgingMask?: string[]};
type Field = {type: string; output: boolean};
const gateway = 'google_business_native_action',
  origin = 'https://mybusinesslodging.googleapis.com',
  infoOrigin = 'https://mybusinessbusinessinformation.googleapis.com';
const oauthScope = 'https://www.googleapis.com/auth/business.manage',
  action = 'gmb_lodging_ops/UPDATE_LODGING';
const locationMask = 'name,title,openInfo,metadata',
  maxPaths = 100,
  maxItems = 50;
/**
 * Every message reachable from Lodging in the pinned document, as field:type. b is a boolean, x a boolean whose
 * <field>Exception enum (X) is its union partner, i an int32, f a float, s a string, t a timestamp, eX/eT/eL/eB/eC an enum
 * below, a message name a nested message and [ a repeated one; ! marks an output-only field. The lodging test checks this
 * table against the pinned document whenever the document is present.
 */
export const lodgingSchemaTable: Record<string, string> = {
  'Accessibility':
    'mobilityAccessible:x mobilityAccessibleElevator:x mobilityAccessibleParking:x mobilityAccessiblePool:x',
  'Activities':
    'beachAccess:x beachFront:x bicycleRental:x boutiqueStores:x casino:x freeBicycleRental:x freeWatercraftRental:x gameRoom:x golf:x horsebackRiding:x nightclub:x privateBeach:x scuba:x snorkeling:x tennis:x waterSkiing:x watercraftRental:x',
  'Business': 'businessCenter:x meetingRooms:x meetingRoomsCount:i meetingRoomsCountException:eX',
  'Connectivity': 'freeWifi:x publicAreaWifiAvailable:x publicInternetTerminal:x wifiAvailable:x',
  'EcoCertification': 'awarded:x ecoCertificate:eC',
  'EnergyEfficiency':
    'carbonFreeEnergySources:x energyConservationProgram:x energyEfficientHeatingAndCoolingSystems:x energyEfficientLighting:x energySavingThermostats:x !greenBuildingDesign:x independentOrganizationAuditsEnergyUse:x',
  'EnhancedCleaning':
    'commercialGradeDisinfectantCleaning:x commonAreasEnhancedCleaning:x employeesTrainedCleaningProcedures:x employeesTrainedThoroughHandWashing:x employeesWearProtectiveEquipment:x guestRoomsEnhancedCleaning:x',
  'Families': 'babysitting:x kidsActivities:x kidsClub:x kidsFriendly:x',
  'FoodAndDrink':
    'bar:x breakfastAvailable:x breakfastBuffet:x buffet:x dinnerBuffet:x freeBreakfast:x restaurant:x restaurantsCount:i restaurantsCountException:eX roomService:x tableService:x twentyFourHourRoomService:x vendingMachine:x',
  'GuestUnitFeatures':
    'bungalowOrVilla:x connectingUnitAvailable:x executiveFloor:x maxAdultOccupantsCount:i maxAdultOccupantsCountException:eX maxChildOccupantsCount:i maxChildOccupantsCountException:eX maxOccupantsCount:i maxOccupantsCountException:eX privateHome:x suite:x tier:eT tierException:eX totalLivingAreas:LivingArea views:ViewsFromUnit',
  'GuestUnitType': 'codes:[s features:GuestUnitFeatures label:s',
  'HealthAndSafety':
    'enhancedCleaning:EnhancedCleaning increasedFoodSafety:IncreasedFoodSafety minimizedContact:MinimizedContact personalProtection:PersonalProtection physicalDistancing:PhysicalDistancing',
  'Housekeeping': 'dailyHousekeeping:x housekeepingAvailable:x turndownService:x',
  'IncreasedFoodSafety':
    'diningAreasAdditionalSanitation:x disposableFlatware:x foodPreparationAndServingAdditionalSafety:x individualPackagedMeals:x singleUseFoodMenus:x',
  'LanguageSpoken': 'languageCode:s spoken:x',
  'LivingArea':
    'accessibility:LivingAreaAccessibility eating:LivingAreaEating features:LivingAreaFeatures layout:LivingAreaLayout sleeping:LivingAreaSleeping',
  'LivingAreaAccessibility':
    'adaCompliantUnit:x hearingAccessibleDoorbell:x hearingAccessibleFireAlarm:x hearingAccessibleUnit:x mobilityAccessibleBathtub:x mobilityAccessibleShower:x mobilityAccessibleToilet:x mobilityAccessibleUnit:x',
  'LivingAreaEating':
    'coffeeMaker:x cookware:x dishwasher:x indoorGrill:x kettle:x kitchenAvailable:x microwave:x minibar:x outdoorGrill:x oven:x refrigerator:x sink:x snackbar:x stove:x teaStation:x toaster:x',
  'LivingAreaFeatures':
    'airConditioning:x bathtub:x bidet:x dryer:x electronicRoomKey:x fireplace:x hairdryer:x heating:x inunitSafe:x inunitWifiAvailable:x ironingEquipment:x payPerViewMovies:x privateBathroom:x shower:x toilet:x tv:x tvCasting:x tvStreaming:x universalPowerAdapters:x washer:x',
  'LivingAreaLayout':
    'balcony:x livingAreaSqMeters:f livingAreaSqMetersException:eX loft:x nonSmoking:x patio:x stairs:x',
  'LivingAreaSleeping':
    'bedsCount:i bedsCountException:eX bunkBedsCount:i bunkBedsCountException:eX cribsCount:i cribsCountException:eX doubleBedsCount:i doubleBedsCountException:eX featherPillows:x hypoallergenicBedding:x kingBedsCount:i kingBedsCountException:eX memoryFoamPillows:x otherBedsCount:i otherBedsCountException:eX queenBedsCount:i queenBedsCountException:eX rollAwayBedsCount:i rollAwayBedsCountException:eX singleOrTwinBedsCount:i singleOrTwinBedsCountException:eX sofaBedsCount:i sofaBedsCountException:eX syntheticPillows:x',
  'Lodging':
    'accessibility:Accessibility activities:Activities !allUnits:GuestUnitFeatures business:Business commonLivingArea:LivingArea connectivity:Connectivity families:Families foodAndDrink:FoodAndDrink guestUnits:[GuestUnitType healthAndSafety:HealthAndSafety housekeeping:Housekeeping metadata:LodgingMetadata name:s parking:Parking pets:Pets policies:Policies pools:Pools property:Property services:Services !someUnits:GuestUnitFeatures sustainability:Sustainability transportation:Transportation wellness:Wellness',
  'LodgingMetadata': 'updateTime:t',
  'MinimizedContact':
    'contactlessCheckinCheckout:x digitalGuestRoomKeys:x housekeepingScheduledRequestOnly:x noHighTouchItemsCommonAreas:x noHighTouchItemsGuestRooms:x plasticKeycardsDisinfected:x roomBookingsBuffer:x',
  'Parking':
    'electricCarChargingStations:x freeParking:x freeSelfParking:x freeValetParking:x parkingAvailable:x selfParkingAvailable:x valetParkingAvailable:x',
  'PaymentOptions': 'cash:x cheque:x creditCard:x debitCard:x mobileNfc:x',
  'PersonalProtection':
    'commonAreasOfferSanitizingItems:x faceMaskRequired:x guestRoomHygieneKitsAvailable:x protectiveEquipmentAvailable:x',
  'Pets': 'catsAllowed:x dogsAllowed:x petsAllowed:x petsAllowedFree:x',
  'PhysicalDistancing':
    'commonAreasPhysicalDistancingArranged:x physicalDistancingRequired:x safetyDividers:x sharedAreasLimitedOccupancy:x wellnessAreasHavePrivateSpaces:x',
  'Policies':
    'allInclusiveAvailable:x allInclusiveOnly:x checkinTime:TimeOfDay checkinTimeException:eX checkoutTime:TimeOfDay checkoutTimeException:eX kidsStayFree:x maxChildAge:i maxChildAgeException:eX maxKidsStayFreeCount:i maxKidsStayFreeCountException:eX paymentOptions:PaymentOptions smokeFreeProperty:x',
  'Pools':
    'adultPool:x hotTub:x indoorPool:x indoorPoolsCount:i indoorPoolsCountException:eX lazyRiver:x lifeguard:x outdoorPool:x outdoorPoolsCount:i outdoorPoolsCountException:eX pool:x poolsCount:i poolsCountException:eX wadingPool:x waterPark:x waterslide:x wavePool:x',
  'Property':
    'builtYear:i builtYearException:eX floorsCount:i floorsCountException:eX lastRenovatedYear:i lastRenovatedYearException:eX roomsCount:i roomsCountException:eX',
  'Services':
    'baggageStorage:x concierge:x convenienceStore:x currencyExchange:x elevator:x frontDesk:x fullServiceLaundry:x giftShop:x languagesSpoken:[LanguageSpoken selfServiceLaundry:x socialHour:x twentyFourHourFrontDesk:x wakeUpCalls:x',
  'Sustainability':
    'energyEfficiency:EnergyEfficiency sustainabilityCertifications:SustainabilityCertifications sustainableSourcing:SustainableSourcing wasteReduction:WasteReduction waterConservation:WaterConservation',
  'SustainabilityCertifications':
    'breeamCertification:eB breeamCertificationException:eX ecoCertifications:[EcoCertification leedCertification:eL leedCertificationException:eX',
  'SustainableSourcing':
    'ecoFriendlyToiletries:x locallySourcedFoodAndBeverages:x organicCageFreeEggs:x organicFoodAndBeverages:x responsiblePurchasingPolicy:x responsiblySourcesSeafood:x veganMeals:x vegetarianMeals:x',
  'TimeOfDay': 'hours:i minutes:i nanos:i seconds:i',
  'Transportation':
    'airportShuttle:x carRentalOnProperty:x freeAirportShuttle:x freePrivateCarService:x localShuttle:x privateCarService:x transfer:x',
  'ViewsFromUnit': 'beachView:x cityView:x gardenView:x lakeView:x landmarkView:x oceanView:x poolView:x valleyView:x',
  'WasteReduction':
    'compostableFoodContainersAndCutlery:x compostsExcessFood:x donatesExcessFood:x foodWasteReductionProgram:x noSingleUsePlasticStraws:x noSingleUsePlasticWaterBottles:x noStyrofoamFoodContainers:x recyclingProgram:x refillableToiletryContainers:x safelyDisposesBatteries:x safelyDisposesElectronics:x safelyDisposesLightbulbs:x safelyHandlesHazardousSubstances:x soapDonationProgram:x toiletryDonationProgram:x waterBottleFillingStations:x',
  'WaterConservation':
    'independentOrganizationAuditsWaterUse:x linenReuseProgram:x towelReuseProgram:x waterSavingShowers:x waterSavingSinks:x waterSavingToilets:x',
  'Wellness':
    'doctorOnCall:x ellipticalMachine:x fitnessCenter:x freeFitnessCenter:x freeWeights:x massage:x salon:x sauna:x spa:x treadmill:x weightMachine:x',
};
export const lodgingEnums: Record<string, string[]> = {
  'B': [
    'BREEAM_CERTIFICATION_UNSPECIFIED',
    'NO_BREEAM_CERTIFICATION',
    'BREEAM_PASS',
    'BREEAM_GOOD',
    'BREEAM_VERY_GOOD',
    'BREEAM_EXCELLENT',
    'BREEAM_OUTSTANDING',
  ],
  'C': [
    'ECO_CERTIFICATE_UNSPECIFIED',
    'ISO14001',
    'ISO50001',
    'ASIAN_ECOTOURISM',
    'BIOSPHERE_RESPOSNIBLE_TOURISM',
    'BUREAU_VERITAS',
    'CONTROL_UNION',
    'EARTHCHECK',
    'ECO_CERTIFICATION_MALTA',
    'ECOTOURISM_AUSTRALIAS_ECO',
    'GREAT_GREEN_DEAL',
    'GREEN_GLOBE',
    'GREEN_GROWTH2050',
    'GREEN_KEY',
    'GREEN_KEY_ECO_RATING',
    'GREEN_SEAL',
    'GREEN_STAR',
    'GREEN_TOURISM_ACTIVE',
    'HILTON_LIGHTSTAY',
    'HOSTELLING_INTERNATIONALS_QUALITY_AND_SUSTAINABILITY',
    'HOTELES_MAS_VERDES',
    'NORDIC_SWAN_ECOLABEL',
    'PREFERRED_BY_NATURE_SUSTAINABLE_TOURISM',
    'SUSTAINABLE_TRAVEL_IRELAND',
    'TOF_TIGERS_INITITIVES_PUG',
    'TRAVELIFE',
    'UNITED_CERTIFICATION_SYSTEMS_LIMITED',
    'VIREO_SRL',
  ],
  'L': [
    'LEED_CERTIFICATION_UNSPECIFIED',
    'NO_LEED_CERTIFICATION',
    'LEED_CERTIFIED',
    'LEED_SILVER',
    'LEED_GOLD',
    'LEED_PLATINUM',
  ],
  'T': ['UNIT_TIER_UNSPECIFIED', 'STANDARD_UNIT', 'DELUXE_UNIT'],
  'X': ['EXCEPTION_UNSPECIFIED', 'UNDER_CONSTRUCTION', 'DEPENDENT_ON_SEASON', 'DEPENDENT_ON_DAY_OF_WEEK'],
};
const schema = new Map<string, Map<string, Field>>();
for (const [name, line] of Object.entries(lodgingSchemaTable)) {
  const fields = new Map<string, Field>();
  for (const token of line.split(' ')) {
    const [raw, type] = token.split(':') as [string, string],
      output = raw.startsWith('!'),
      key = output ? raw.slice(1) : raw;
    if (type === 'x') {
      fields.set(key, {type: 'b', output});
      fields.set(key + 'Exception', {type: 'eX', output});
    } else fields.set(key, {type, output});
  }
  schema.set(name, fields);
}
/** Codes the reference accepts for LanguageSpoken.languageCode. */
const languages = ['ar', 'de', 'en', 'es', 'fil', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'vi', 'yue'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const zulu = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_BUSINESS_LODGING_EDIT', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function businessLodgingKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.origin === origin &&
    p.method === 'PATCH' &&
    p.action === action &&
    !p.specialTransport &&
    /^\/v1\/locations\/[1-9][0-9]*\/lodging$/.test(p.path)
  );
}
const lodgingOf = (p: CompiledRequest) => p.path.slice(4);
const locationOf = (p: CompiledRequest) => p.path.slice(4, -'/lodging'.length);
const maskOf = (p: CompiledRequest) => String(p.query.updateMask ?? '').split(',');
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
/** The field a mask path names, or a refusal saying why it cannot be updated. */
function resolve(path: string): Field {
  const parts = path.split('.');
  let message = 'Lodging',
    field: Field | undefined;
  if (parts[0] === 'name' || (parts[0] === 'metadata' && path !== 'metadata.updateTime'))
    invalid('updateMask cannot name ' + path + '; metadata.updateTime is the only metadata field.');
  parts.forEach((part, i) => {
    if (!/^[a-z][A-Za-z0-9]*$/.test(part))
      invalid('updateMask paths are lowerCamelCase fields joined by dots: ' + path + '.');
    if (i > 0 && (!field || !schema.has(field.type)))
      invalid(
        path +
          ' goes below a field that holds no fields' +
          (field?.type.startsWith('[') ? ' (repeated fields are replaced whole).' : '.'),
      );
    if (i > 0) message = field!.type;
    field = schema.get(message)!.get(part);
    if (!field) invalid(path + ' is not a lodging field.');
    if (field.output) invalid(path + ' is output only.');
  });
  return field!;
}
/** Checks a value against its field type; null clears the field. */
function check(type: string, v: unknown, at: string, message = ''): void {
  if (v === null) return;
  if (type === 'b') {
    if (typeof v !== 'boolean') invalid(at + ' is true or false.');
    return;
  }
  if (type.startsWith('e')) {
    const values = lodgingEnums[type.slice(1)]!;
    if (typeof v !== 'string' || !values.includes(v)) invalid(at + ' is one of ' + values.join(', ') + '.');
    return;
  }
  if (type === 'i') {
    const max =
      message === 'TimeOfDay'
        ? ({hours: 23, minutes: 59, seconds: 59, nanos: 999999999}[at.split('.').at(-1)!] ?? 2147483647)
        : 2147483647;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max)
      invalid(at + ' is a whole number from 0 to ' + max + '.');
    return;
  }
  if (type === 'f') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid(at + ' is a non-negative number.');
    return;
  }
  if (type === 't') {
    if (typeof v !== 'string' || !zulu.test(v) || Number.isNaN(Date.parse(v)))
      invalid(at + ' is an RFC 3339 UTC time such as 2026-09-28T09:00:00Z.');
    return;
  }
  if (type === 's') {
    if (at.endsWith('languageCode')) {
      if (!languages.includes(v as string)) invalid(at + ' is one of ' + languages.join(', ') + '.');
      return;
    }
    if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > 100 || /[\u0000-\u001f\u007f]/.test(v))
      invalid(at + ' is 1–100 characters without surrounding spaces.');
    return;
  }
  if (type.startsWith('[')) {
    const item = type.slice(1);
    if (!Array.isArray(v) || v.length > maxItems)
      invalid(at + ' lists at most ' + maxItems + ' items; a repeated field is replaced whole.');
    (v as unknown[]).forEach((x, i) => {
      if (x === null) invalid(at + '[' + i + '] is not null.');
      check(item, x, at + '[' + i + ']', message);
    });
    const keys = (v as unknown[]).map(x => JSON.stringify(normal(item, x)));
    if (new Set(keys).size !== keys.length) invalid(at + ' repeats an item.');
    return;
  }
  const fields = schema.get(type);
  if (!fields || !obj(v)) invalid(at + ' is a ' + type + ' object.');
  for (const [k, x] of Object.entries(v as JsonObject)) {
    const f = fields!.get(k);
    if (!f) invalid(at + '.' + k + ' is not a ' + type + ' field.');
    if (f!.output) invalid(at + '.' + k + ' is output only.');
    check(f!.type, x, at + '.' + k, type);
    if (
      k.endsWith('Exception') &&
      x !== null &&
      x !== undefined &&
      fields!.has(k.slice(0, -9)) &&
      (v as JsonObject)[k.slice(0, -9)] !== undefined &&
      (v as JsonObject)[k.slice(0, -9)] !== null
    )
      invalid(at + ' sets both ' + k.slice(0, -9) + ' and ' + k + '; they are one union.');
  }
  if (
    type === 'GuestUnitType' &&
    (!Array.isArray((v as JsonObject).codes) ||
      !((v as JsonObject).codes as unknown[]).length ||
      typeof (v as JsonObject).label !== 'string')
  )
    invalid(at + ' needs codes and a label.');
  if (type === 'LanguageSpoken' && typeof (v as JsonObject).languageCode !== 'string')
    invalid(at + ' needs a languageCode.');
}
/** A value in one comparable form: proto3 JSON omits zero times and empty fields, and lists compare as sets. */
function normal(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type.startsWith('['))
    return Array.isArray(v)
      ? v
          .map(x => normal(type.slice(1), x))
          .map(x => JSON.stringify(x))
          .sort()
          .map(x => JSON.parse(x))
      : null;
  if (type === 'TimeOfDay' && obj(v))
    return {
      hours: Number(v.hours ?? 0),
      minutes: Number(v.minutes ?? 0),
      seconds: Number(v.seconds ?? 0),
      nanos: Number(v.nanos ?? 0),
    };
  const fields = schema.get(type);
  if (fields && obj(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v).sort()) {
      const f = fields.get(k);
      const x = normal(f?.type ?? '?', v[k]);
      if (x !== null) out[k] = x;
    }
    return Object.keys(out).length ? out : null;
  }
  if (type === 't' && typeof v === 'string' && !Number.isNaN(Date.parse(v)))
    return new Date(Date.parse(v)).toISOString();
  return v;
}
const at = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (obj(v) ? v[k] : undefined), root);
export function assertBusinessLodging(p: CompiledRequest): void {
  if (!businessLodgingKind(p)) return;
  if (p.accountId !== locationOf(p))
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Select this exact locations/{id} grant with location_id; an account grant does not name the location.',
      {},
      403,
    );
  if (Object.keys(p.headers ?? {}).length) invalid('Lodging edits take no header overrides.');
  if (Object.keys(p.query).some(k => k !== 'updateMask') || typeof p.query.updateMask !== 'string')
    invalid('A lodging edit takes only updateMask in the query.');
  const mask = maskOf(p);
  if (p.query.updateMask === '*')
    invalid('updateMask "*" would also unset every field left empty; list the fields to change.');
  if (!mask.length || mask.length > maxPaths || new Set(mask).size !== mask.length)
    invalid('updateMask lists 1–' + maxPaths + ' distinct field paths.');
  for (const m of mask)
    if (mask.some(o => o !== m && m.startsWith(o + '.')))
      invalid('updateMask names ' + m + ' and its parent; name one of them.');
  const fields = new Map(mask.map(m => [m, resolve(m)]));
  const b = p.body;
  if (!obj(b)) invalid('Provide the Lodging body.');
  if (b.name !== undefined && b.name !== lodgingOf(p)) invalid('name, when sent, is ' + lodgingOf(p) + '.');
  if (!obj(b.metadata) || Object.keys(b.metadata).join() !== 'updateTime')
    invalid('metadata is {updateTime}: the time the facts are asserted true, which Business Profile requires.');
  check('t', (b.metadata as JsonObject).updateTime, 'metadata.updateTime');
  if (Date.parse(String((b.metadata as JsonObject).updateTime)) > Date.now() + 300000)
    invalid('metadata.updateTime is not in the future.');
  // Every value lies under a masked path (fields outside the mask would be ignored), and every masked path is given a value or null.
  const walk = (v: unknown, path: string): void => {
    if (path && (fields.has(path) || path === 'metadata.updateTime')) return;
    if (!obj(v) || (path && !mask.some(m => m.startsWith(path + '.'))))
      invalid((path || 'The body') + ' is not in updateMask; Business Profile would ignore it.');
    for (const [k, x] of Object.entries(v as JsonObject))
      if (path || (k !== 'name' && k !== 'metadata')) walk(x, path ? path + '.' + k : k);
  };
  walk(b, '');
  for (const [m, f] of fields) {
    if (m === 'metadata.updateTime') continue;
    const v = at(b, m);
    if (v === undefined) invalid(m + ' is in updateMask without a value; give null to clear it.');
    check(
      f.type,
      v,
      m,
      m.split('.').length > 1
        ? m
            .split('.')
            .slice(0, -1)
            .reduce((t, k) => schema.get(t)?.get(k)?.type ?? t, 'Lodging')
        : 'Lodging',
    );
    const leaf = m.split('.').at(-1)!,
      parent = m.split('.').slice(0, -1).join('.'),
      partner = leaf.endsWith('Exception') ? leaf.slice(0, -9) : leaf + 'Exception',
      other = parent ? parent + '.' + partner : partner;
    if (v !== null && fields.has(other) && at(b, other) !== null && at(b, other) !== undefined)
      invalid(m + ' and ' + other + ' are one union; set one of them.');
  }
  const codes = (Array.isArray(b.guestUnits) ? b.guestUnits : []).flatMap(u =>
    obj(u) && Array.isArray(u.codes) ? u.codes : [],
  );
  if (new Set(codes).size !== codes.length) invalid('Each guest unit code is unique within the lodging.');
}
export function assertBusinessLodgingScope(c: Connection): void {
  if (!c.scopes.includes(oauthScope))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Business Profile with business.manage.', {}, 403);
}
const base = (p: CompiledRequest): Read => ({
  ...p,
  method: 'GET',
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
});
const lodgingRead = (p: CompiledRequest): Read => ({
  ...base(p),
  action: 'gmb_lodging_ops/GET_LODGING',
  origin,
  path: '/v1/' + lodgingOf(p),
  query: {readMask: '*'},
  businessLodgingRead: 'lodging',
});
const locationRead = (p: CompiledRequest): Read => ({
  ...base(p),
  action: 'gmb_location_ops/GET_LOCATION',
  origin: infoOrigin,
  path: '/v1/' + locationOf(p),
  query: {readMask: locationMask},
  businessLodgingRead: 'location',
});
/** The validated edit and the reads of the same location: the lodging and the location. */
export function authorizeBusinessLodging(p: CompiledRequest, c: Connection, id: string): boolean {
  if (businessLodgingKind(p)) {
    assertBusinessLodging(p);
    assertBusinessLodgingScope(c);
    if (p.accountId !== id) fail('ACCOUNT_SCOPE_MISMATCH', 'Select this exact location grant.', {}, 403);
    return true;
  }
  const kind = (p as Read).businessLodgingRead;
  if (
    p.gateway !== gateway ||
    !kind ||
    p.method !== 'GET' ||
    !p.readOnly ||
    !id.startsWith('locations/') ||
    Object.keys(p.query).length !== 1
  )
    return false;
  assertBusinessLodgingScope(c);
  if (kind === 'lodging') return p.origin === origin && p.path === '/v1/' + id + '/lodging' && p.query.readMask === '*';
  return p.origin === infoOrigin && p.path === '/v1/' + id && p.query.readMask === locationMask;
}
export function businessLodgingSnapshots(p: CompiledRequest): Read[] {
  return [locationRead(p), lodgingRead(p)];
}
export function isBusinessLodgingRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).businessLodgingRead;
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
export async function readBusinessLodgings(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const kind = (p as Read).businessLodgingRead;
  if (!kind) return request(p);
  let r: TransportResult;
  try {
    r = await request({...(p as Read), businessLodgingRead: undefined} as Read);
  } catch (e) {
    if (kind === 'lodging' && notFound(e)) return {status: 200, headers: {}, data: {lodging: {present: false}}};
    throw e;
  }
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.error) unverified('Business Profile did not return the ' + kind + '.');
  if (kind === 'location') {
    if (d.name !== p.path.slice(4))
      fail('STATE_TARGET_MISMATCH', 'Business Profile returned another location.', {}, 409);
    const meta = obj(d.metadata) ? d.metadata : {};
    return {
      status: 200,
      headers: {},
      data: {
        location: {
          name: d.name,
          title: d.title ?? null,
          open: obj(d.openInfo) ? (d.openInfo.status ?? null) : null,
          voiceOfMerchant: meta.hasVoiceOfMerchant === true,
        },
      },
    };
  }
  if (d.name !== p.path.slice(4))
    fail('STATE_TARGET_MISMATCH', 'Business Profile returned the lodging of another location.', {}, 409);
  return {status: 200, headers: {}, data: {lodging: {present: true, ...(normal('Lodging', d) as JsonObject)}}};
}
export function validateBusinessLodgingState(p: CompiledRequest, r: TransportResult): void {
  const kind = (p as Read).businessLodgingRead,
    d = r.data;
  if (!kind || r.status !== 200 || !obj(d) || !obj(kind === 'location' ? d.location : d.lodging))
    unverified('Missing verified ' + (kind ?? 'lodging') + ' state.');
}
const states = (values: unknown[]) => ({
  location: values.map(v => (obj(v) ? v.location : undefined)).find(obj),
  lodging: values.map(v => (obj(v) ? v.lodging : undefined)).find(obj),
});
/** The masked facts as the edit leaves them: the value sent, or null when cleared. The asserted time is metadata, not a fact. */
const facts = (mask: string[]) => mask.filter(m => m !== 'metadata.updateTime');
function expectedOf(p: CompiledRequest): JsonObject {
  const b = body(p),
    out: JsonObject = {};
  for (const m of facts(maskOf(p))) out[m] = normal(resolve(m).type, at(b, m));
  return out;
}
export function businessLodgingPrerequisites(p: CompiledRequest, values: unknown[]): void {
  if (!businessLodgingKind(p)) return;
  const {location, lodging} = states(values);
  if (!obj(location) || !obj(lodging)) unverified('Missing verified location or lodging state.');
  if (location.voiceOfMerchant !== true)
    invalid(
      'The listing has no Voice of Merchant, so Business Profile would not apply edits; check locations.getVoiceOfMerchantState first.',
    );
  if (location.open === 'CLOSED_PERMANENTLY')
    invalid('The location is closed permanently; its lodging facts no longer change here.');
  const want = expectedOf(p),
    current: JsonObject = lodging.present === true ? lodging : {};
  if (
    Object.entries(want).every(
      ([m, v]) => JSON.stringify(normal(resolve(m).type, at(current, m))) === JSON.stringify(v),
    )
  )
    invalid('The lodging already has these values.');
}
export function businessLodgingImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!businessLodgingKind(p)) return;
  const {location, lodging} = states(state),
    mask = maskOf(p),
    b = body(p);
  return {
    provider: 'google_business',
    scope: 'lodging',
    operation: 'update',
    location: {name: locationOf(p), title: obj(location) ? (location.title ?? null) : null},
    lodging_present: obj(lodging) && lodging.present === true,
    fields: mask.filter(m => at(b, m) !== null),
    clearing: mask.filter(m => at(b, m) === null),
    asserted_at: obj(b.metadata) ? b.metadata.updateTime : null,
    may_affect_serving: false,
    effect:
      'Changes the lodging facts the public listing shows (' +
      mask.join(', ') +
      '); Google may review them before they appear. No advertising spending changes.',
    verification: 'Reads the lodging again and compares each masked field.',
    source: 'https://developers.google.com/my-business/reference/lodging/rest/v1/locations/updateLodging',
  };
}
export function businessLodgingOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return r.status === 200 && obj(d) && !d.error && d.name === lodgingOf(p);
}
export function businessLodgingVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const read: Read = {...lodgingRead(p), businessLodgingMask: facts(maskOf(p))};
  return [{read, expected: {lodging: expectedOf(p)}, id: lodgingOf(p)}];
}
export function businessLodgingObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const lodging = obj(data.lodging) && data.lodging.present === true ? data.lodging : {},
    out: JsonObject = {};
  for (const m of (read as Read).businessLodgingMask ?? []) out[m] = normal(resolve(m).type, at(lodging, m));
  return {lodging: out};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const businessLodgingFamily: ReviewedFamily = {
  name: 'google_business_lodging',
  files: ['src/google-business-lodging.ts', ['tests/google-business-lodging.test.mjs']],
  kind: businessLodgingKind,
  assert: assertBusinessLodging,
  authorize: authorizeBusinessLodging,
  snapshots: businessLodgingSnapshots,
  isRead: isBusinessLodgingRead,
  reader: readBusinessLodgings,
  validateState: validateBusinessLodgingState,
  prerequisites: businessLodgingPrerequisites,
  impact: businessLodgingImpact,
  outcome: businessLodgingOutcome,
  verification: businessLodgingVerification,
  observed: businessLodgingObserved,
  exemptFromSpendTextMatch: true,
};
