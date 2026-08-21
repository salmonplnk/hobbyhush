/**
 * HobbyHush telemetry contract — owner-cockpit prototype only.
 *
 * This module does not send, store, or enable telemetry. It freezes and
 * validates the privacy boundary described in docs/analytics/COCKPIT_PLAN.md.
 */

export const TELEMETRY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  dataset: 'hobbyhush_product_events',
  maxBodyBytes: 2048,
  maxEventsPerBatch: 20,
  minimumAggregateCohort: 5,
  eventNames: Object.freeze([
    'app_open',
    'analytics_opt_in',
    'round_start',
    'round_complete',
    'mix_saved',
    'share_tapped',
    'referral_open',
    'category_request_submitted',
    'category_request_ready',
    'category_request_installed',
    'content_report_submitted',
    'deep_dive_preview',
    'purchase_complete',
  ]),
  platforms: Object.freeze(['android', 'ios', 'web']),
  difficulties: Object.freeze(['easy', 'balanced', 'expert']),
  languages: Object.freeze(['en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'ko']),
  eventFields: Object.freeze([
    'eventName',
    'appVersion',
    'platform',
    'language',
    'categoryId',
    'packId',
    'worldId',
    'difficulty',
    'sourceCode',
    'status',
    'playerCountBucket',
    'selectedCategoryCountBucket',
    'sessionRoundNumber',
    'elapsedSeconds',
  ]),
  analyticsEngineColumns: Object.freeze({
    index1: 'server-HMAC of monthly measurement ID',
    blob1: 'event name',
    blob2: 'category ID or empty',
    blob3: 'pack ID or empty',
    blob4: 'world ID or empty',
    blob5: 'platform',
    blob6: 'app version',
    blob7: 'language',
    blob8: 'campaign/source code or empty',
    blob9: 'difficulty or empty',
    blob10: 'status/outcome or empty',
    double1: 'player-count bucket',
    double2: 'selected-category-count bucket',
    double3: 'session round number',
    double4: 'elapsed seconds, coarse and capped',
    double5: 'constant 1',
  }),
  forbiddenFieldFragments: Object.freeze([
    'name',
    'email',
    'phone',
    'contact',
    'secret',
    'word',
    'clue',
    'vote',
    'location',
    'latitude',
    'longitude',
    'advertising',
    'deviceSerial',
    'userAgent',
    'searchText',
    'requestText',
    'payment',
  ]),
});

const ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const MONTHLY_ID_PATTERN = /^m_(\d{4})-(0[1-9]|1[0-2])_[A-Za-z0-9_-]{16,32}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const ALLOWED_EVENT_FIELDS = new Set(TELEMETRY_CONTRACT.eventFields);
const ALLOWED_ENVELOPE_FIELDS = new Set(['schemaVersion', 'monthlyMeasurementId', 'events']);

function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenField(key) {
  if (ALLOWED_EVENT_FIELDS.has(key)) return false;
  const lower = key.toLowerCase();
  return TELEMETRY_CONTRACT.forbiddenFieldFragments.some((fragment) =>
    lower.includes(fragment.toLowerCase()),
  );
}

function validateId(value, label, errors) {
  if (value !== undefined && value !== '' && !ID_PATTERN.test(value)) {
    errors.push(`${label} must be a catalog-style ID of at most 64 characters.`);
  }
}

function validateBucket(value, label, min, max, errors) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${label} must be an integer from ${min} to ${max}.`);
  }
}

export function validateTelemetryEvent(event, index = 0) {
  const errors = [];
  const prefix = `events[${index}]`;

  if (!isPlainObject(event)) {
    return { valid: false, errors: [`${prefix} must be an object.`] };
  }

  for (const key of Object.keys(event)) {
    if (hasForbiddenField(key)) {
      errors.push(`${prefix}.${key} is a forbidden privacy-sensitive field.`);
    } else if (!ALLOWED_EVENT_FIELDS.has(key)) {
      errors.push(`${prefix}.${key} is not in the fixed event schema.`);
    }
  }

  if (!TELEMETRY_CONTRACT.eventNames.includes(event.eventName)) {
    errors.push(`${prefix}.eventName is not allowed.`);
  }
  if (!VERSION_PATTERN.test(event.appVersion ?? '')) {
    errors.push(`${prefix}.appVersion must be a semantic version.`);
  }
  if (!TELEMETRY_CONTRACT.platforms.includes(event.platform)) {
    errors.push(`${prefix}.platform is not allowed.`);
  }
  if (!TELEMETRY_CONTRACT.languages.includes(event.language)) {
    errors.push(`${prefix}.language is not allowed.`);
  }
  if (event.difficulty !== undefined && !TELEMETRY_CONTRACT.difficulties.includes(event.difficulty)) {
    errors.push(`${prefix}.difficulty is not allowed.`);
  }
  if (event.sourceCode !== undefined && event.sourceCode !== '' && !SOURCE_PATTERN.test(event.sourceCode)) {
    errors.push(`${prefix}.sourceCode must be a coarse code of at most 40 characters.`);
  }
  if (event.status !== undefined && (typeof event.status !== 'string' || !ID_PATTERN.test(event.status))) {
    errors.push(`${prefix}.status must be a fixed enum-style value.`);
  }

  validateId(event.categoryId, `${prefix}.categoryId`, errors);
  validateId(event.packId, `${prefix}.packId`, errors);
  validateId(event.worldId, `${prefix}.worldId`, errors);
  validateBucket(event.playerCountBucket, `${prefix}.playerCountBucket`, 3, 16, errors);
  validateBucket(event.selectedCategoryCountBucket, `${prefix}.selectedCategoryCountBucket`, 1, 10, errors);
  validateBucket(event.sessionRoundNumber, `${prefix}.sessionRoundNumber`, 1, 25, errors);

  if (
    event.elapsedSeconds !== undefined &&
    (!Number.isFinite(event.elapsedSeconds) || event.elapsedSeconds < 0 || event.elapsedSeconds > 3600)
  ) {
    errors.push(`${prefix}.elapsedSeconds must be coarse and capped at 3600.`);
  }

  return { valid: errors.length === 0, errors };
}

export function validateTelemetryBatch(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { valid: false, errors: ['Payload must be an object.'] };
  }

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_ENVELOPE_FIELDS.has(key)) {
      errors.push(`${key} is not in the fixed envelope schema.`);
    }
  }

  if (payload.schemaVersion !== TELEMETRY_CONTRACT.schemaVersion) {
    errors.push(`schemaVersion must equal ${TELEMETRY_CONTRACT.schemaVersion}.`);
  }
  if (!MONTHLY_ID_PATTERN.test(payload.monthlyMeasurementId ?? '')) {
    errors.push('monthlyMeasurementId must be a month-scoped random ID.');
  }
  if (!Array.isArray(payload.events) || payload.events.length < 1) {
    errors.push('events must contain at least one event.');
  } else if (payload.events.length > TELEMETRY_CONTRACT.maxEventsPerBatch) {
    errors.push(`events may contain at most ${TELEMETRY_CONTRACT.maxEventsPerBatch} items.`);
  }

  if (byteSize(payload) > TELEMETRY_CONTRACT.maxBodyBytes) {
    errors.push(`Payload exceeds ${TELEMETRY_CONTRACT.maxBodyBytes} bytes.`);
  }

  if (Array.isArray(payload.events)) {
    payload.events.forEach((event, index) => {
      errors.push(...validateTelemetryEvent(event, index).errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

export function isCrossCategoryGraphEligible(worldIds = []) {
  const sensitive = new Set(['health', 'religion', 'politics', 'sexuality']);
  return Array.isArray(worldIds) && worldIds.length > 0 && worldIds.every((id) => !sensitive.has(id));
}
