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
