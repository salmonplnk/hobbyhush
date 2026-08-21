import {
  calculateCampaignEconomics,
  computeDashboardMetrics,
  derivePlayMetrics,
  evaluateQualityGates,
  formatMoney,
  formatNumber,
  formatPercent,
  parseCsv,
  safeDivide,
} from './core.mjs';
import { cloneScenario } from './fixtures.mjs';

const root = document.querySelector('#dashboard-root');
const scenarioSelect = document.querySelector('#scenario-select');
const periodSelect = document.querySelector('#period-select');
const stateSelect = document.querySelector('#state-select');
const rangeSummary = document.querySelector('#range-summary');
const playSourceLabel = document.querySelector('#play-source-label');
const statusAnnouncer = document.querySelector('#status-announcer');
const dialog = document.querySelector('#csv-dialog');
const fileInput = document.querySelector('#csv-file');
const importFeedback = document.querySelector('#import-feedback');
const dropZone = document.querySelector('#drop-zone');

const appState = {
  scenario: 'healthy',
  period: 30,
  view: 'ready',
  importedPlay: null,
  importName: '',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function scaleCount(value, factor, minimum = 0) {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  return Math.max(minimum, Math.round(value * factor));
}

function getCurrentData() {
  const data = cloneScenario(appState.scenario);
  const factor = appState.period === 7 ? 0.27 : appState.period === 90 ? 2.55 : 1;
  const countFields = [
    'activatedInstallations',
    'webCompletedInstallations',
    'completedRounds',
    'differentDayReplay',
    'shares',
    'referredActivations',
    'totalReports',
    'seriousReports',
  ];

  countFields.forEach((field) => {
    data[field] = scaleCount(data[field], factor);
  });
  Object.keys(data.funnel).forEach((field) => {
    data.funnel[field] = scaleCount(data.funnel[field], factor, 1);
  });
  data.play.downloads = scaleCount(data.play.downloads, factor);
  data.play.storeVisitors = scaleCount(data.play.storeVisitors, factor);
  data.play.storeAcquisitions = scaleCount(data.play.storeAcquisitions, factor);
  data.play.storeConversion = safeDivide(data.play.storeAcquisitions, data.play.storeVisitors);
  data.categories = data.categories.map((item) => ({
    ...item,
    rounds: scaleCount(item.rounds, factor, 1),
    installations: scaleCount(item.installations, factor, 1),
    reports: scaleCount(item.reports, factor),
  }));
  data.mixes = data.mixes.map((item) => ({ ...item, rounds: scaleCount(item.rounds, factor, 1) }));
  data.requests = data.requests.map((item) => ({ ...item, count: scaleCount(item.count, factor, 1) }));
  data.campaigns = data.campaigns.map((item) => ({
    ...item,
    spend: item.spend ? Math.round(item.spend * factor * 100) / 100 : 0,
    activations: scaleCount(item.activations, factor, 1),
    rounds: scaleCount(item.rounds, factor, 1),
    referredActivations: scaleCount(item.referredActivations, factor),
  }));

  const trendLength = Math.min(appState.period, data.trend.length);
  data.trend = data.trend.slice(-trendLength);

  if (appState.importedPlay) {
    data.play = { ...data.play, ...appState.importedPlay };
  }
  return data;
}

function makePath(values, width = 120, height = 32, padding = 2) {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  return values
    .map((value, index) => {
      const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / span) * (height - padding * 2);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function sparkline(values, color) {
  return `
    <svg class="metric-sparkline" style="--accent:${color}" viewBox="0 0 120 32" aria-hidden="true">
      <path d="${makePath(values.slice(-10))}"></path>
    </svg>`;
}

function trendChart(values) {
  const width = 760;
  const height = 155;
  const path = makePath(values, width, 126, 5);
  const area = `${path} L${width - 5},126 L5,126 Z`;
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  const delta = safeDivide(last - first, Math.max(first, 1));
  const lastX = width - 5;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const lastY = 126 - 5 - ((last - min) / Math.max(1, max - min)) * 116;
  return `
    <div class="trend-wrap">
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily completed rounds trend, ${formatPercent(delta)} change">
        <defs>
          <linearGradient id="trend-gradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#72a7ff" stop-opacity="0.24"></stop>
            <stop offset="1" stop-color="#72a7ff" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <g class="trend-grid" aria-hidden="true">
          <line x1="5" y1="10" x2="755" y2="10"></line>
          <line x1="5" y1="68" x2="755" y2="68"></line>
          <line x1="5" y1="126" x2="755" y2="126"></line>
        </g>
        <path class="trend-area" d="${area}"></path>
        <path class="trend-line" d="${path}"></path>
        <circle class="trend-point" cx="${lastX}" cy="${lastY.toFixed(1)}" r="4"></circle>
      </svg>
      <div class="trend-footer"><span>${appState.period === 7 ? '7 days ago' : appState.period === 90 ? 'Oldest available fixture' : '30 days ago'}</span><strong>${delta >= 0 ? '+' : ''}${formatPercent(delta)} period trend</strong><span>Today</span></div>
    </div>`;
}

function metricCard({ label, value, source, note, color, delta, values }) {
  return `
    <article class="metric-card" style="--accent:${color}">
      <div class="metric-top">
        <p class="metric-label">${escapeHtml(label)}</p>
        <span class="metric-source">${escapeHtml(source)}</span>
      </div>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      <div class="metric-bottom">
        <div>
          <p class="metric-note">${escapeHtml(note)}</p>
          <span class="metric-delta ${delta < 0 ? 'is-down' : ''}">${delta >= 0 ? '↗' : '↘'} ${formatPercent(Math.abs(delta))}</span>
        </div>
        ${sparkline(values, color)}
      </div>
    </article>`;
}

function decisionFor(data, gates) {
  const failed = gates.filter((gate) => !gate.passed);
  if ((data.play.crashFree || 0) < 0.995) {
    return {
      title: 'Pause promotion and fix release stability.',
      copy: `Crash-free users are ${formatPercent(data.play.crashFree)}. Protect group sessions before sending more traffic.`,
      icon: '!',
    };
  }
  if (failed.length >= 3) {
    return {
      title: `Fix ${failed[0].label.toLowerCase()} first.`,
      copy: `${failed.length} quality gates are below target. Improve the core loop before any paid creator test.`,
      icon: '↺',
    };
  }
  if (data.activatedInstallations < 120 || data.completedRounds < 400) {
    return {
      title: 'Grow the free test cohort before spending.',
      copy: 'Aim for 120 activated installations and 400 completed group rounds across at least five niches.',
      icon: '＋',
    };
  }
  return {
    title: 'One focused $30 creator test is justified.',
    copy: 'The organic product gates are healthy. Test one niche creator and continue only at ≤ $3 per activated installation.',
    icon: '↗',
  };
}

function renderDecision(data, gates) {
  const passed = gates.filter((gate) => gate.passed).length;
  const decision = decisionFor(data, gates);
  return `
    <section class="decision-card" aria-labelledby="decision-title">
      <div class="decision-orb" aria-hidden="true">${decision.icon}</div>
      <div>
        <p class="decision-label">Recommended next move</p>
        <h2 id="decision-title">${escapeHtml(decision.title)}</h2>
        <p class="decision-copy">${escapeHtml(decision.copy)}</p>
      </div>
      <div class="decision-score" aria-label="${passed} of ${gates.length} quality gates passed">
        <strong>${passed}/${gates.length}</strong>
        <span>gates healthy</span>
      </div>
    </section>`;
}

function renderKpis(data, metrics) {
  const trend = data.trend.length > 2 ? data.trend : [0, 1, 1];
  const reversed = [...trend].reverse();
  return `
    <section class="kpi-grid" aria-label="Key performance indicators">
      ${metricCard({ label: 'Play downloads', value: formatNumber(data.play.downloads), source: 'Play', note: 'Device installs · not people', color: '#72A7FF', delta: 0.18, values: trend })}
      ${metricCard({ label: 'Active install base', value: formatNumber(data.play.activeInstallBase), source: 'Play', note: 'Latest Play snapshot', color: '#75E6C3', delta: 0.11, values: trend.map((value) => value * 0.8) })}
      ${metricCard({ label: 'Activated installations', value: formatNumber(data.activatedInstallations), source: 'Product', note: 'Monthly IDs · not people', color: '#D8FF4F', delta: 0.22, values: trend.map((value) => value * 0.72) })}
      ${metricCard({ label: 'Completed group rounds', value: formatNumber(data.completedRounds), source: 'Product', note: `${metrics.roundsPerActivation.toFixed(1)} per activation`, color: '#AF8CFF', delta: 0.28, values: trend })}
      ${metricCard({ label: 'Store conversion', value: formatPercent(data.play.storeConversion), source: 'Play', note: `${formatNumber(data.play.storeAcquisitions)} acquisitions`, color: '#FFC65A', delta: 0.04, values: trend.map((value, index) => value + index * 2) })}
      ${metricCard({ label: 'Referred activations', value: formatNumber(data.referredActivations), source: 'Product', note: `${metrics.referredPerActivation.toFixed(2)} per activation`, color: '#FF725E', delta: appState.scenario === 'attention' ? -0.12 : 0.16, values: appState.scenario === 'attention' ? reversed : trend })}
    </section>`;
}

function renderFunnel(data) {
  const steps = [
    { label: 'First open', value: data.funnel.firstOpen, rate: 1, note: 'eligible installs' },
    {
      label: 'First round complete',
      value: data.funnel.firstRoundComplete,
      rate: safeDivide(data.funnel.firstRoundComplete, data.funnel.firstOpen),
      note: 'of first opens',
    },
    {
      label: 'Second round',
      value: data.funnel.secondRound,
      rate: safeDivide(data.funnel.secondRound, data.funnel.firstRoundComplete),
      note: 'same session',
    },
    {
      label: 'Different-day replay',
      value: data.differentDayReplay,
      rate: safeDivide(data.differentDayReplay, data.activatedInstallations),
      note: 'days 7–30',
    },
  ];
  return `
    <section class="panel" aria-labelledby="funnel-title">
      <div class="panel-head">
        <div><p class="section-kicker">Activation</p><h2 id="funnel-title">Group journey</h2><p class="section-copy">Installation-level funnel; one phone may represent a whole group.</p></div>
        <span class="panel-tag">Installations</span>
      </div>
      <div class="funnel">
        ${steps
          .map(
            (step) => `<div class="funnel-step"><span>${escapeHtml(step.label)}</span><strong>${formatNumber(step.value)}</strong><em>${step.rate === 1 ? 'Baseline' : `${formatPercent(step.rate)} ${step.note}`}</em></div>`,
          )
          .join('')}
      </div>
    </section>`;
}

function renderCategoryTable(data) {
  return `
    <section class="panel" id="content" aria-labelledby="categories-title">
      <div class="panel-head">
        <div><p class="section-kicker">Content signal</p><h2 id="categories-title">Top categories</h2><p class="section-copy">Played group choices, not inferred personal interests.</p></div>
        <span class="panel-tag">Round complete</span>
      </div>
      <div class="table-scroll" tabindex="0" aria-label="Scrollable top categories table">
        <table class="data-table">
          <thead><tr><th scope="col">Category</th><th scope="col" class="number-cell">Rounds</th><th scope="col" class="number-cell">Installations</th><th scope="col" class="number-cell">Replay</th><th scope="col" class="number-cell">Reports</th></tr></thead>
          <tbody>
            ${data.categories
              .map(
                (item, index) => `
                  <tr>
                    <td><div class="category-cell"><span class="rank">${String(index + 1).padStart(2, '0')}</span><i class="category-dot" style="--dot-color:${item.color}" aria-hidden="true"></i><span class="category-title"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.world)}</span></span></div></td>
                    <td class="number-cell">${formatNumber(item.rounds)}</td>
                    <td class="number-cell">${formatNumber(item.installations)}</td>
                    <td class="number-cell">${formatPercent(item.replayRate)}</td>
                    <td class="number-cell report-count ${item.reports >= 3 ? 'is-alert' : ''}">${formatNumber(item.reports)}</td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderMixes(data) {
  const maximum = Math.max(...data.mixes.map((item) => item.rounds), 1);
  return `
    <section class="panel" aria-labelledby="mixes-title">
      <div class="panel-head">
        <div><p class="section-kicker">Multi-select</p><h2 id="mixes-title">Top category mixes</h2><p class="section-copy">Counted as group selections.</p></div>
      </div>
      <ol class="mix-list">
        ${data.mixes
          .map(
            (item) => `<li class="mix-row"><div><div class="mix-name">${escapeHtml(item.name)}</div><div class="mix-worlds">${escapeHtml(item.worlds.join(' · '))}</div></div><span class="mix-value">${formatNumber(item.rounds)}</span><div class="bar-track"><div class="bar-fill" style="--value:${Math.round((item.rounds / maximum) * 100)}%;--bar-color:${item.color}"></div></div></li>`,
          )
          .join('')}
      </ol>
    </section>`;
}

function renderRequests(data) {
  return `
    <section class="panel" aria-labelledby="requests-title">
      <div class="panel-head">
        <div><p class="section-kicker">Community demand</p><h2 id="requests-title">Requested categories</h2><p class="section-copy">Moderated normalized labels only; raw text stays out.</p></div>
        <span class="panel-tag">${data.requests.reduce((sum, item) => sum + item.count, 0)} signals</span>
      </div>
      <ol class="request-list">
        ${data.requests
          .map(
            (item) => `<li class="request-row"><div><div class="request-title">${escapeHtml(item.label)}</div><span class="request-meta">${escapeHtml(item.age)} · ${escapeHtml(item.trend)} recent</span></div><span class="request-count">${formatNumber(item.count)}</span><span class="status-pill" data-status="${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></li>`,
          )
          .join('')}
      </ol>
    </section>`;
}

function renderCampaigns(data) {
  const campaigns = calculateCampaignEconomics(data.campaigns);
  return `
    <section class="panel" id="growth" aria-labelledby="campaigns-title">
      <div class="panel-head">
        <div><p class="section-kicker">Attribution</p><h2 id="campaigns-title">Campaign economics</h2><p class="section-copy">Continue paid pilots only at ≥ 10 activations and ≤ $3 CPA.</p></div>
        <span class="panel-tag">Cohorts ≥ 5</span>
      </div>
      <div class="table-scroll" tabindex="0" aria-label="Scrollable campaign economics table">
        <table class="data-table campaign-table">
          <thead><tr><th scope="col">Campaign</th><th scope="col" class="number-cell">Spend</th><th scope="col" class="number-cell">Activations</th><th scope="col" class="number-cell">Rounds</th><th scope="col" class="number-cell">CPA</th><th scope="col" class="number-cell">Referral yield</th></tr></thead>
          <tbody>
            ${campaigns
              .map((item) => {
                const paid = item.spend > 0;
                const good = !paid || (item.activations >= 10 && item.cpa <= 3);
                return `<tr><td><span class="campaign-name"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.source)} · ${escapeHtml(item.code)}</span></span></td><td class="number-cell">${formatMoney(item.spend)}</td><td class="number-cell">${formatNumber(item.activations)}</td><td class="number-cell">${formatNumber(item.rounds)}</td><td class="number-cell ${paid ? (good ? 'cpa-good' : 'cpa-bad') : ''}">${paid ? formatMoney(item.cpa) : 'Organic'}</td><td class="number-cell">${item.referralYield.toFixed(2)}</td></tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

function formatGateTarget(gate) {
  const operator = gate.direction === 'min' ? '≥' : '≤';
  return `${operator} ${formatPercent(gate.target)}`;
}

function renderQuality(data, gates) {
  const revealRate = safeDivide(data.funnel.revealComplete, data.funnel.roundStart);
  return `
    <section class="panel" id="quality" aria-labelledby="quality-title">
      <div class="panel-head">
        <div><p class="section-kicker">Release discipline</p><h2 id="quality-title">Quality gates</h2><p class="section-copy">Hard thresholds before paid growth or monetization.</p></div>
        <span class="panel-tag">Reveal ${formatPercent(revealRate)}</span>
      </div>
      <ul class="gate-list">
        ${gates
          .map(
            (gate) => `<li class="gate-row ${gate.passed ? '' : 'is-failed'}"><span class="gate-icon" aria-hidden="true">${gate.passed ? '✓' : '!'}</span><span class="gate-name">${escapeHtml(gate.label)}</span><span class="gate-values"><strong>${formatPercent(gate.value)}</strong> / ${formatGateTarget(gate)}</span><span class="sr-only">${gate.passed ? 'Passed' : 'Needs attention'}</span></li>`,
          )
          .join('')}
      </ul>
    </section>`;
}

function renderReady() {
  const data = getCurrentData();
  const metrics = computeDashboardMetrics(data);
  const gates = evaluateQualityGates(data);
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `
    <div class="dashboard-stack" id="overview">
      ${renderDecision(data, gates)}
      ${renderKpis(data, metrics)}
      <div class="quality-grid">
        ${renderFunnel(data)}
        <section class="panel" aria-labelledby="trend-title"><div class="panel-head"><div><p class="section-kicker">Usage rhythm</p><h2 id="trend-title">Completed rounds</h2><p class="section-copy">Synthetic daily group-round trend.</p></div><span class="panel-tag">Daily</span></div>${trendChart(data.trend)}</section>
      </div>
      <div class="content-grid">${renderCategoryTable(data)}${renderMixes(data)}</div>
      <div class="growth-grid">${renderCampaigns(data)}${renderRequests(data)}</div>
      <div class="quality-grid">${renderQuality(data, gates)}<section class="panel" aria-labelledby="definitions-title"><div class="panel-head"><div><p class="section-kicker">Honest definitions</p><h2 id="definitions-title">What these numbers mean</h2><p class="section-copy">Downloads come from Play. Activated installations use a rotating monthly ID. Rounds describe group sessions. No metric represents people or players.</p></div><span class="panel-tag">Privacy first</span></div><div class="mix-list"><div class="mix-row"><div><div class="mix-name">Crash-free users</div><div class="mix-worlds">${formatPercent(data.play.crashFree)} from Play snapshot</div></div><span class="mix-value">Target 99.5%</span><div class="bar-track"><div class="bar-fill" style="--value:${Math.min(100, data.play.crashFree * 100)}%;--bar-color:#75E6C3"></div></div></div><div class="mix-row"><div><div class="mix-name">Serious reports</div><div class="mix-worlds">${formatNumber(data.seriousReports)} across ${formatNumber(data.completedRounds)} rounds</div></div><span class="mix-value">${formatPercent(metrics.seriousReportRate)}</span><div class="bar-track"><div class="bar-fill" style="--value:${Math.min(100, metrics.seriousReportRate * 4000)}%;--bar-color:#FF725E"></div></div></div></div></section></div>
    </div>`;
}

function renderLoading() {
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = `<section class="skeleton-grid" aria-label="Loading dashboard"><div class="skeleton skeleton-hero"></div><div class="skeleton skeleton-kpis"></div><div class="skeleton skeleton-panel"></div><div class="skeleton skeleton-panel"></div></section>`;
}

function renderEmpty() {
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `<section class="state-card"><div class="state-content"><div class="state-icon" aria-hidden="true">◇</div><h2>No aggregate data yet</h2><p>The shipped app remains analytics-free. Once consent, the endpoint and owner authentication are ready, eligible aggregate cohorts will appear here.</p><button class="button button-primary" type="button" data-action="show-demo">Return to demo data</button></div></section>`;
}

function renderError() {
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `<section class="state-card is-error"><div class="state-content"><div class="state-icon" aria-hidden="true">!</div><h2>Aggregate snapshot unavailable</h2><p>No raw rows were exposed. Check the authenticated owner route, then retry; gameplay and the public app are unaffected.</p><button class="button button-ghost" type="button" data-action="retry">Retry synthetic snapshot</button></div></section>`;
}

function render() {
  rangeSummary.textContent = `Last ${appState.period} days · ${cloneScenario(appState.scenario).note}`;
  playSourceLabel.textContent = appState.importedPlay
    ? `Local CSV · ${appState.importedPlay.rowCount} rows`
    : 'Synthetic snapshot';
  if (appState.view === 'loading') renderLoading();
  else if (appState.view === 'empty') renderEmpty();
  else if (appState.view === 'error') renderError();
  else renderReady();
}

function setView(nextView, announcement) {
  appState.view = nextView;
  stateSelect.value = nextView;
  render();
  if (announcement) statusAnnouncer.textContent = announcement;
}

async function importCsv(file) {
  importFeedback.classList.remove('is-error');
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    importFeedback.textContent = 'Choose a CSV smaller than 5 MB.';
    importFeedback.classList.add('is-error');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.csv')) {
    importFeedback.textContent = 'This does not look like a CSV file.';
    importFeedback.classList.add('is-error');
    return;
  }

  importFeedback.textContent = 'Reading locally…';
  try {
    const text = await file.text();
    const rows = parseCsv(text);
    const metrics = derivePlayMetrics(rows);
    appState.importedPlay = metrics;
    appState.importName = file.name;
    appState.view = 'ready';
    stateSelect.value = 'ready';
    importFeedback.textContent = `Imported ${metrics.rowCount} rows from ${file.name}. Nothing was uploaded.`;
    statusAnnouncer.textContent = `Google Play snapshot imported locally from ${file.name}.`;
    render();
  } catch (error) {
    importFeedback.textContent = error instanceof Error ? error.message : 'The CSV could not be read.';
    importFeedback.classList.add('is-error');
  }
}

scenarioSelect.addEventListener('change', (event) => {
  appState.scenario = event.target.value;
  appState.importedPlay = null;
  appState.importName = '';
  setView('ready', `${event.target.selectedOptions[0].text} synthetic scenario loaded.`);
});

periodSelect.addEventListener('change', (event) => {
  appState.period = Number(event.target.value);
  render();
  statusAnnouncer.textContent = `Reporting period changed to ${appState.period} days.`;
});

stateSelect.addEventListener('change', (event) => {
  setView(event.target.value, `${event.target.selectedOptions[0].text} state preview shown.`);
});

root.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'show-demo' || action === 'retry') setView('ready', 'Synthetic dashboard restored.');
});

document.querySelector('#open-import').addEventListener('click', () => {
  importFeedback.textContent = '';
  importFeedback.classList.remove('is-error');
  fileInput.value = '';
  dialog.showModal();
});

fileInput.addEventListener('change', () => importCsv(fileInput.files?.[0]));

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}
dropZone.addEventListener('drop', (event) => importCsv(event.dataTransfer?.files?.[0]));

document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach((item) => {
      item.classList.toggle('is-active', item === link);
      item.toggleAttribute('aria-current', item === link);
    });
  });
});

window.setTimeout(() => {
  render();
  root.setAttribute('aria-busy', 'false');
}, 260);
