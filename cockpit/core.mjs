import {
  BUILT_IN_MAIN_HOBBY_BY_ID,
  BUILT_IN_MAIN_HOBBY_COUNT,
} from './main-hobby-catalog.mjs';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const MONEY_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export const COMMUNITY_RATING_POLICY = Object.freeze({
  scaleMinimum: 1,
  scaleMaximum: 5,
  minimumAggregateCohort: 5,
  bayesianPriorWeight: 20,
  publicScoreMinimumRatings: 10,
  improvementMinimumRatings: 25,
  improvementMaximumBayesianScore: 3.65,
});

export function formatNumber(value) {
  return NUMBER_FORMAT.format(Number(value) || 0);
}

export function formatPercent(value) {
  return PERCENT_FORMAT.format(Number(value) || 0);
}

export function formatMoney(value) {
  return MONEY_FORMAT.format(Number(value) || 0);
}

export function safeDivide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function parseCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
  );
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function detectOwnerCsvKind(rows) {
  const headers = new Set(Object.keys(rows?.[0] ?? {}).map(normalizeHeader));
  const hasAny = (aliases) => aliases.some((alias) => headers.has(normalizeHeader(alias)));
  if (
    hasAny(['Category ID', 'Hobby ID']) &&
    hasAny(['Rating count', 'Ratings', 'Responses']) &&
    hasAny(['Average rating', 'Average', 'Mean rating'])
  ) {
    return 'community-ratings';
  }
  if (
    hasAny(['Daily Device Installs', 'Device installs', 'New device acquisitions', 'Downloads']) ||
    hasAny(['Active Device Installs', 'Active devices']) ||
    hasAny(['Store Listing Visitors', 'Store listing visitors'])
  ) {
    return 'play';
  }
  return 'unknown';
}

function findValue(row, aliases) {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]),
  );
  for (const alias of aliases) {
    const value = normalized.get(normalizeHeader(alias));
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseNumeric(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[%$€£\s]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  const number = Number(cleaned.replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function latestNonZero(rows, aliases) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = parseNumeric(findValue(rows[index], aliases));
    if (value > 0) return value;
  }
  return 0;
}

function weightedAverage(rows, aliases, weightAliases) {
  let total = 0;
  let weightTotal = 0;
  for (const row of rows) {
    const rawValue = findValue(row, aliases);
    let value = parseNumeric(rawValue);
    if ((typeof rawValue === 'string' && rawValue.includes('%')) || value > 1) value /= 100;
    const weight = Math.max(1, parseNumeric(findValue(row, weightAliases)));
    if (value > 0) {
      total += value * weight;
      weightTotal += weight;
    }
  }
  return weightTotal ? total / weightTotal : 0;
}

export function derivePlayMetrics(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The CSV has no data rows.');
  }

  const sum = (aliases) => rows.reduce((total, row) => total + parseNumeric(findValue(row, aliases)), 0);
  const downloads = sum([
    'Daily Device Installs',
    'Device installs',
    'New device acquisitions',
    'User acquisitions',
    'Downloads',
  ]);
  const visitors = sum(['Store Listing Visitors', 'Store listing visitors', 'Visitors']);
  const acquisitions = sum([
    'Store Listing Acquisitions',
    'Store listing acquisitions',
    'Acquisitions',
  ]);
  const activeInstallBase = latestNonZero(rows, [
    'Active Device Installs',
    'Active device install base',
    'Active devices',
  ]);
  const crashFree = weightedAverage(
    rows,
    ['Crash-free users (%)', 'Crash-free users', 'Crash free users'],
    ['Daily active users', 'Active Device Installs', 'Active devices'],
  );
  const anrRate = weightedAverage(
    rows,
    ['ANR rate (%)', 'User-perceived ANR rate', 'ANR rate'],
    ['Daily active users', 'Active Device Installs', 'Active devices'],
  );

  if (downloads === 0 && activeInstallBase === 0 && visitors === 0) {
    throw new Error(
      'No supported Play columns were found. Export Statistics with device installs, active devices, or store visitors.',
    );
  }

  return {
    downloads,
    activeInstallBase,
    storeVisitors: visitors,
    storeAcquisitions: acquisitions,
    storeConversion: safeDivide(acquisitions, visitors),
    crashFree,
    anrRate,
    rowCount: rows.length,
  };
}

export function computeDashboardMetrics(data) {
  const funnel = data.funnel ?? {};
  const activations = data.activatedInstallations ?? 0;
  const completedRounds = data.completedRounds ?? 0;
  const shares = data.shares ?? 0;
  const referredActivations = data.referredActivations ?? 0;
  const seriousReports = data.seriousReports ?? 0;
  const totalReports = data.totalReports ?? 0;

  return {
    activationRate: safeDivide(funnel.firstRoundComplete, funnel.firstOpen),
    revealCompletionRate: safeDivide(funnel.revealComplete, funnel.roundStart),
    secondRoundRate: safeDivide(funnel.secondRound, funnel.firstRoundComplete),
    replayRate: safeDivide(data.differentDayReplay, activations),
    shareRate: safeDivide(shares, activations),
    referredPerActivation: safeDivide(referredActivations, activations),
    roundsPerActivation: safeDivide(completedRounds, activations),
    seriousReportRate: safeDivide(seriousReports, completedRounds),
    reportApprovalRate: safeDivide(totalReports - seriousReports, totalReports),
  };
}

export const QUALITY_GATE_DEFINITIONS = Object.freeze([
  { key: 'activationRate', label: 'First open → completed round', target: 0.65, direction: 'min' },
  { key: 'revealCompletionRate', label: 'Round started → reveal complete', target: 0.85, direction: 'min' },
  { key: 'secondRoundRate', label: 'Second round, first session', target: 0.45, direction: 'min' },
  { key: 'replayRate', label: 'Different-day replay, days 7–30', target: 0.18, direction: 'min' },
  { key: 'shareRate', label: 'Share / QR per activation', target: 0.12, direction: 'min' },
  { key: 'referredPerActivation', label: 'Referred activations / activation', target: 0.08, direction: 'min' },
  { key: 'seriousReportRate', label: 'Serious content report rate', target: 0.005, direction: 'max' },
]);

export function evaluateQualityGates(data) {
  const metrics = computeDashboardMetrics(data);
  const productGates = QUALITY_GATE_DEFINITIONS.map((gate) => {
    const value = metrics[gate.key];
    const passed = gate.direction === 'min' ? value >= gate.target : value <= gate.target;
    return { ...gate, value, passed };
  });

  const crashFree = data.play?.crashFree ?? 0;
  productGates.push({
    key: 'crashFree',
    label: 'Crash-free users',
    value: crashFree,
    target: 0.995,
    direction: 'min',
    passed: crashFree >= 0.995,
  });
  return productGates;
}

export function calculateCampaignEconomics(campaigns = []) {
  return campaigns.map((campaign) => ({
    ...campaign,
    cpa: safeDivide(campaign.spend, campaign.activations),
    roundsPerActivation: safeDivide(campaign.rounds, campaign.activations),
    referralYield: safeDivide(campaign.referredActivations, campaign.activations),
  }));
}

function normalizeCategoryRatingRecord(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Category rating row ${index + 1} must be an object.`);
  }
  if (Object.keys(item).some((key) => normalizeHeader(key).startsWith('pack'))) {
    throw new Error('Pack-level ratings are not accepted. Import main Hobby category aggregates only.');
  }

  const unsupportedEvidenceFields = new Set([
    'eligibleinstallations',
    'eligibleusers',
    'eligibleratinginstallations',
    'previousaverage',
    'previousperiodaverage',
    'trend',
  ]);
  if (Object.keys(item).some((key) => unsupportedEvidenceFields.has(normalizeHeader(key)))) {
    throw new Error('Eligibility counts, previous-period values and rating trends are not provided by the current owner contract.');
  }

  const label = item.name || item.categoryName || item.categoryId || `row ${index + 1}`;
  const catalogEntry = BUILT_IN_MAIN_HOBBY_BY_ID.get(item.categoryId);
  if (!catalogEntry) {
    throw new Error(`${label}: categoryId must be one of the ${BUILT_IN_MAIN_HOBBY_COUNT} built-in main Hobby IDs.`);
  }
  if (!Number.isInteger(item.ratingCount) || item.ratingCount < 0) {
    throw new Error(`${label}: rating count must be a non-negative integer.`);
  }
  if (
    !Number.isFinite(item.averageRating) ||
    item.averageRating < COMMUNITY_RATING_POLICY.scaleMinimum ||
    item.averageRating > COMMUNITY_RATING_POLICY.scaleMaximum
  ) {
    throw new Error(`${label}: average rating must be from 1 to 5.`);
  }

  if (item.distribution !== undefined) {
    const distribution = item.distribution;
    const expectedKeys = ['1', '2', '3', '4', '5'];
    if (
      !distribution ||
      typeof distribution !== 'object' ||
      Array.isArray(distribution) ||
      Object.keys(distribution).some((key) => !expectedKeys.includes(key)) ||
      expectedKeys.some((key) => !Number.isInteger(distribution[key]) || distribution[key] < 0)
    ) {
      throw new Error(`${label}: distribution must contain non-negative integer counts for ratings 1 through 5.`);
    }
    const distributionTotal = expectedKeys.reduce((sum, key) => sum + distribution[key], 0);
    if (distributionTotal !== item.ratingCount) {
      throw new Error(`${label}: distribution total must equal rating count.`);
    }
    const distributionAverage = safeDivide(
      expectedKeys.reduce((sum, key) => sum + Number(key) * distribution[key], 0),
      distributionTotal,
    );
    if (distributionTotal > 0 && Math.abs(distributionAverage - item.averageRating) > 0.011) {
      throw new Error(`${label}: average rating must match the 1–5 distribution.`);
    }
  }

  return {
    ...item,
    name: catalogEntry.name,
    world: catalogEntry.world,
  };
}

/**
 * Calculates category-level quality signals from the current owner aggregate contract.
 * The contract contains current ratings only; it does not prove round eligibility or history.
 */
export function computeCommunityRatingAnalytics(categoryRatings = [], options = {}) {
  if (!Array.isArray(categoryRatings)) {
    throw new Error('Category ratings must be an array of aggregate rows.');
  }
  const normalizedRatings = categoryRatings.map(normalizeCategoryRatingRecord);

  const ids = normalizedRatings.map((item) => item.categoryId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Category rating aggregates must contain one row per main Hobby category.');
  }

  const ratingTotal = normalizedRatings.reduce((sum, item) => sum + item.ratingCount, 0);
  const observedMean = safeDivide(
    normalizedRatings.reduce((sum, item) => sum + item.averageRating * item.ratingCount, 0),
    ratingTotal,
  );
  const priorMean = Number.isFinite(options.priorMean)
    ? options.priorMean
    : observedMean || 3.8;
  const priorWeight = Number.isFinite(options.priorWeight)
    ? Math.max(0, options.priorWeight)
    : COMMUNITY_RATING_POLICY.bayesianPriorWeight;

  const categories = normalizedRatings.map((item) => {
    const bayesianScore = safeDivide(
      item.averageRating * item.ratingCount + priorMean * priorWeight,
      item.ratingCount + priorWeight,
    );
    const publicScoreEligible = item.ratingCount >= COMMUNITY_RATING_POLICY.publicScoreMinimumRatings;
    return {
      ...item,
      bayesianScore,
      qualityScore: Math.max(0, Math.min(100, ((bayesianScore - 1) / 4) * 100)),
      confidence: publicScoreEligible ? 'high' : item.ratingCount >= 10 ? 'emerging' : 'early',
      publicScoreEligible,
    };
  });

  const ranking = [...categories].sort(
    (left, right) => right.bayesianScore - left.bayesianScore || right.ratingCount - left.ratingCount,
  );
  const improvementQueue = categories
    .filter((item) => (
      item.ratingCount >= COMMUNITY_RATING_POLICY.improvementMinimumRatings &&
      item.bayesianScore <= COMMUNITY_RATING_POLICY.improvementMaximumBayesianScore
    ))
    .sort((left, right) => left.bayesianScore - right.bayesianScore || right.ratingCount - left.ratingCount);

  return {
    categories,
    ranking,
    improvementQueue,
    ratingTotal,
    observedMean,
    priorMean,
    publicScoreEligibleCount: categories.filter((item) => item.publicScoreEligible).length,
  };
}

/** Parse a local, already-aggregated category-rating CSV. Raw responses are out of scope. */
export function deriveCommunityRatingMetrics(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The category-rating CSV has no data rows.');
  }
  const headers = Object.keys(rows[0]).map(normalizeHeader);
  if (headers.some((key) => key.startsWith('pack'))) {
    throw new Error('Pack-level columns are not accepted. Use main Hobby category aggregates only.');
  }
  const unsupportedHeaders = new Set([
    'eligibleinstallations',
    'eligibleusers',
    'eligibleratinginstallations',
    'previousaverage',
    'previousperiodaverage',
    'trend',
  ]);
  if (headers.some((key) => unsupportedHeaders.has(key))) {
    throw new Error('This CSV contains eligibility or trend fields that the current owner contract does not provide.');
  }

  const distributionAliases = [1, 2, 3, 4, 5].map((rating) => [
    `Rating ${rating}`,
    `${rating}-star ratings`,
    `Distribution ${rating}`,
  ]);
  const hasAnyDistributionColumn = distributionAliases.some((aliases) => (
    aliases.some((alias) => headers.includes(normalizeHeader(alias)))
  ));
  const hasEveryDistributionColumn = distributionAliases.every((aliases) => (
    aliases.some((alias) => headers.includes(normalizeHeader(alias)))
  ));
  if (hasAnyDistributionColumn && !hasEveryDistributionColumn) {
    throw new Error('Rating distribution columns must include all five ratings from 1 through 5.');
  }

  const seen = new Set();
  let suppressedRows = 0;
  const categories = rows.flatMap((row, index) => {
    const categoryId = String(findValue(row, ['Category ID', 'Hobby ID', 'categoryId'])).trim();
    const ratingCount = parseNumeric(findValue(row, ['Rating count', 'Ratings', 'Responses']));
    const averageRating = parseNumeric(findValue(row, ['Average rating', 'Average', 'Mean rating']));
    const distribution = hasAnyDistributionColumn
      ? Object.fromEntries(distributionAliases.map((aliases, offset) => [
        String(offset + 1),
        parseNumeric(findValue(row, aliases)),
      ]))
      : undefined;
    const item = {
      categoryId,
      ratingCount,
      averageRating,
      ...(distribution ? { distribution } : {}),
    };
    const normalizedItem = normalizeCategoryRatingRecord(item, index);
    if (seen.has(categoryId)) throw new Error(`${normalizedItem.name}: duplicate category aggregate.`);
    seen.add(categoryId);
    if (ratingCount < COMMUNITY_RATING_POLICY.minimumAggregateCohort) {
      suppressedRows += 1;
      return [];
    }
    return [normalizedItem];
  });

  if (categories.length === 0) {
    throw new Error('No category rows meet the minimum aggregate cohort of 5.');
  }
  return { categories, rowCount: rows.length, suppressedRows };
}
