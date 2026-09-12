/**
 * DOM interface: toolbar, readouts, inspector, advisors, budget.
 *
 * The tool palette is generated from the configuration tables rather than
 * written out in markup, so adding a building to `BUILDINGS` puts a working,
 * priced button on the palette with no other edits.
 */

import { Z, ZONE_INFO, ROAD_INFO, ROAD, BUILDINGS, POWERLINE_COST, BULLDOZE_COST, SPEED_LABELS, TAX_MIN, TAX_MAX, SERVICE_KEYS, WEALTH_NAMES, ERAS, VERSION } from '../config.js';
import { TOOL } from '../tools.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
import { money, commas, clamp } from '../util.js';

const SERVICE_LABEL = { police: 'Police', fire: 'Fire', health: 'Health', education: 'Schools', park: 'Parks' };

export class UI {
  constructor(game) {
    this.game = game;
    this.selected = null;      // tile currently shown in the inspector
    document.getElementById('version').textContent = `v${VERSION}`;
    this.buildToolbar();
    this.buildSpeeds();
    this.bindChrome();
    this.refresh();
  }

  // ------------------------------------------------------------- toolbar --

  buildToolbar() {
    const host = document.getElementById('tool-groups');
    host.innerHTML = '';

    const groups = [
      {
        title: 'Zones',
        items: [
          ...Object.keys(Z).filter((k) => k !== 'NONE').map((k) => {
            const info = ZONE_INFO[Z[k]];
            const density = info.sub.replace(' Density', '');
            return {
              label: `${info.cat} \u00b7 ${density}`,
              cost: info.cost, tool: `zone:${k}`, arg: k, swatch: info.tint,
              title: `${info.name} - ${info.sub}`,
            };
          }),
        ],
      },
      {
        title: 'Transport',
        items: [
          { label: 'Street', cost: ROAD_INFO[ROAD.STREET].cost, tool: 'road:STREET', arg: 'STREET', swatch: '#6e6b64' },
          { label: 'Avenue', cost: ROAD_INFO[ROAD.AVENUE].cost, tool: 'road:AVENUE', arg: 'AVENUE', swatch: '#8a867c' },
        ],
      },
      {
        title: 'Power',
        items: [
          { label: 'Power line', cost: POWERLINE_COST, tool: TOOL.POWERLINE, swatch: '#5a5348' },
          ...catalogue('power'),
        ],
      },
      { title: 'Services', items: catalogue('service') },
      { title: 'Parks', items: catalogue('park') },
      {
        title: 'Modify',
        items: [{ label: 'Bulldoze', cost: BULLDOZE_COST, tool: TOOL.BULLDOZE, swatch: '#cf6a55' },
                { label: 'Inspect', cost: 0, tool: TOOL.SELECT, swatch: '#ded8c6' }],
      },
    ];

    this.toolButtons = [];
    for (const g of groups) {
      const wrap = document.createElement('div');
      wrap.className = 'tool-group';
      const h = document.createElement('h3');
      h.textContent = g.title;
      wrap.appendChild(h);

      for (const item of g.items) {
        const btn = document.createElement('button');
        btn.className = 'tool-btn';
        btn.title = item.title || item.label;
        btn.innerHTML =
          `<span><i class="swatch" style="background:${item.swatch}"></i>${item.label}</span>` +
          `<span class="cost">${item.cost ? '$' + commas(item.cost) : ''}</span>`;
        btn.addEventListener('click', () => {
          this.game.tools.select(item.tool, item.arg ?? null);
          this.setActiveTool(item.tool);
          document.getElementById('status-tool').textContent = item.label;
        });
        btn.dataset.tool = item.tool;
        wrap.appendChild(btn);
        this.toolButtons.push(btn);
      }
      host.appendChild(wrap);
    }
    this.setActiveTool(TOOL.SELECT);

    function catalogue(category) {
      return Object.entries(BUILDINGS)
        .filter(([, spec]) => spec.category === category)
        .map(([key, spec]) => ({
          label: spec.name.replace(' Power Plant', ' Plant'),
          cost: spec.cost, tool: `build:${key}`, arg: key, swatch: spec.color,
          title: `${spec.name} - ${spec.span}x${spec.span} tiles, ${money(spec.upkeep)}/month`,
        }));
    }
  }

  /**
   * Say that a new version has been deployed.
   *
   * A banner rather than a toast: a notice that disappears after three seconds
   * is no use to someone who was looking at the map when it appeared, and this
   * one has a button on it.
   */
  showUpdate(version) {
    if (!this.updateBanner) return;
    const label = document.getElementById('update-text');
    if (label) label.textContent = version ? `Version ${version} is ready.` : 'A new version is ready.';
    this.updateBanner.classList.remove('hidden');
  }

  hideUpdate() {
    if (this.updateBanner) this.updateBanner.classList.add('hidden');
  }

  /** Flip the traffic on or off, keeping the checkbox and the key in step. */
  toggleVehicles() {
    const on = !this.game.renderer.showVehicles;
    this.game.setVehiclesVisible(on);
    if (this.carsToggle) this.carsToggle.checked = on;
  }

  /** Flip the day/night cycle, keeping the checkbox and the key in step. */
  toggleNight() {
    const on = !this.game.renderer.showNight;
    this.game.renderer.showNight = on;
    this.game.renderer.markDirty();
    if (this.nightToggle) this.nightToggle.checked = on;
  }

  setActiveTool(tool) {
    for (const b of this.toolButtons) b.classList.toggle('active', b.dataset.tool === tool);
  }

  buildSpeeds() {
    const host = document.getElementById('speeds');
    host.innerHTML = '';
    this.speedButtons = SPEED_LABELS.map((label, i) => {
      const b = document.createElement('button');
      b.textContent = i === 0 ? '❚❚' : '▶'.repeat(i);
      b.title = label;
      b.addEventListener('click', () => this.game.setSpeed(i));
      host.appendChild(b);
      return b;
    });
  }

  bindChrome() {
    document.getElementById('overlay-select').addEventListener('change', (e) => {
      this.game.renderer.overlay = e.target.value;
      this.game.renderer.markDirty();
    });
    this.carsToggle = document.getElementById('toggle-cars');
    this.carsToggle.checked = this.game.renderer.showVehicles;
    this.carsToggle.addEventListener('change', (e) => this.game.setVehiclesVisible(e.target.checked));
    this.updateBanner = document.getElementById('update-banner');
    document.getElementById('update-reload').addEventListener('click', () => this.game.applyUpdate());
    document.getElementById('update-later').addEventListener('click', () => this.hideUpdate());
    this.nightToggle = document.getElementById('toggle-night');
    this.nightToggle.checked = this.game.renderer.showNight;
    this.nightToggle.addEventListener('change', (e) => {
      this.game.renderer.showNight = e.target.checked;
      this.game.renderer.markDirty();
    });
    document.getElementById('btn-budget').addEventListener('click', () => this.showBudget());
    document.getElementById('btn-graphs').addEventListener('click', () => this.showGraphs());

    // No new chrome for this: the version is already on screen, and clicking
    // the thing whose notes you want is where a player would look first.
    const version = document.getElementById('version');
    if (version) {
      version.title = 'What changed in this version';
      version.addEventListener('click', () => this.game.showReleaseNotes());
    }
    document.getElementById('btn-save').addEventListener('click', () => this.game.save());
    document.getElementById('btn-load').addEventListener('click', () => {
      if (confirm('Discard changes since the last save and reload the stored city?')) this.game.load();
    });
    document.getElementById('btn-export').addEventListener('click', () => this.game.exportCity());
    document.getElementById('btn-import').addEventListener('click', () => this.game.importCity());
    document.getElementById('btn-new').addEventListener('click', () => {
      // The autosave holds one city, so starting over really does replace it.
      if (confirm('Start a new city? This replaces the saved city in this browser. Export it first if you want to keep it.')) {
        this.game.newCity();
      }
    });
    document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
    document.getElementById('modal').addEventListener('click', (e) => {
      if (e.target.id === 'modal') this.closeModal();
    });
  }

  // ------------------------------------------------------------ readouts --

  refresh() {
    const w = this.game.world;
    const st = w.stats;

    const funds = document.getElementById('stat-funds');
    funds.textContent = money(w.funds);
    funds.classList.toggle('negative', w.funds < 0);

    document.getElementById('stat-pop').textContent = commas(st.population);
    document.getElementById('stat-approval').textContent = `${st.approval}%`;

    const bal = document.getElementById('stat-balance');
    bal.textContent = money(st.lastBalance);
    bal.classList.toggle('negative', st.lastBalance < 0);
    bal.classList.toggle('positive', st.lastBalance > 0);

    document.getElementById('stat-date').textContent = this.game.sim.dateLabel;

    for (const [key, id] of [['R', 'rci-r'], ['C', 'rci-c'], ['I', 'rci-i']]) {
      const v = clamp(w.demand[key], -1, 1);
      const el = document.getElementById(id);
      const half = 14;                       // half the bar's inner height
      if (v >= 0) {
        el.style.bottom = '50%';
        el.style.top = 'auto';
        el.style.height = `${Math.max(1, v * half)}px`;
      } else {
        el.style.top = '50%';
        el.style.bottom = 'auto';
        el.style.height = `${Math.max(1, -v * half)}px`;
      }
    }

    for (let i = 0; i < this.speedButtons.length; i++) {
      this.speedButtons[i].classList.toggle('active', i === this.game.speed);
    }

    this.renderInspector();
    this.renderAdvisors();
  }

  // ----------------------------------------------------------- inspector --

  inspect(tile) {
    this.selected = tile;
    this.renderInspector();
  }

  renderInspector() {
    const body = document.getElementById('inspector-body');
    const title = document.querySelector('#inspector h2');
    const w = this.game.world;

    if (!this.selected || !w.inBounds(this.selected.x, this.selected.y)) {
      title.textContent = 'City';
      body.innerHTML = this.cityReport();
      return;
    }

    const { x, y } = this.selected;
    const i = w.idx(x, y);
    title.textContent = `Tile ${x}, ${y}`;
    body.innerHTML = this.tileReport(x, y, i);
  }

  cityReport() {
    const w = this.game.world;
    const st = w.stats;
    const rows = [];

    rows.push(row('Population', commas(st.population)));
    rows.push(row('Jobs', commas(st.jobs)));
    rows.push(row('Unemployment', `${(st.unemployment * 100).toFixed(1)}%`));
    rows.push(row('Approval', `${st.approval}%`));

    rows.push('<div class="subhead">Power</div>');
    rows.push(row('Produced', commas(st.powerSupply)));
    rows.push(row('Consumed', commas(st.powerDemand)));

    // How close the grid is to its limit, which the two raw figures alone made
    // you work out for yourself.
    const load = st.powerSupply > 0
      ? st.powerDemand / st.powerSupply
      : (st.powerDemand > 0 ? 1 : 0);
    const headroom = st.powerSupply - st.powerDemand;
    rows.push(row('Spare capacity', st.powerSupply > 0 ? commas(headroom) : '-'));
    rows.push(row('Grid load', st.powerSupply > 0 ? `${Math.round(load * 100)}%`
      : (st.powerDemand > 0 ? 'No supply' : '-')));
    rows.push(meter(clamp(load, 0, 1),
      load >= 1 ? 'var(--bad)' : load > 0.85 ? 'var(--accent)' : 'var(--good)'));

    if (st.brownout) {
      const short = Math.round((st.brownoutShare ?? 0) * 100);
      rows.push(`<div class="row"><span class="k" style="color:var(--bad)">Browning out — ${short}% of demand unserved</span></div>`);
    }

    rows.push('<div class="subhead">Environment</div>');
    rows.push(row('Avg land value', Math.round(st.avgLandValue)));
    rows.push(row('Avg pollution', Math.round(st.avgPollution)));
    rows.push(row('Congestion', `${Math.round((st.congestion || 0) * 100)}%`));
    rows.push(meter(clamp(st.congestion || 0, 0, 1), st.congestion > 0.8 ? 'var(--bad)' : 'var(--good)'));

    rows.push('<div class="subhead">Service coverage</div>');
    for (const k of SERVICE_KEYS) {
      const v = this.coverageOfPopulation(k);
      rows.push(row(SERVICE_LABEL[k], `${Math.round(v * 100)}%`));
      rows.push(meter(v, v > 0.6 ? 'var(--good)' : v > 0.3 ? 'var(--accent)' : 'var(--bad)'));
    }

    rows.push('<div class="subhead">Treasury</div>');
    rows.push(row('Income', money(st.income)));
    rows.push(row('Expenses', money(st.expenses)));
    rows.push(row('Net', money(st.lastBalance)));

    return rows.join('');
  }

  coverageOfPopulation(key) {
    const w = this.game.world;
    const n = w.size * w.size;
    const field = w.coverage[key];
    let weighted = 0, people = 0;
    for (let i = 0; i < n; i++) {
      const p = w.pop[i];
      if (!p) continue;
      weighted += (field[i] / 255) * p;
      people += p;
    }
    return people ? weighted / people : 0;
  }

  tileReport(x, y, i) {
    const w = this.game.world;
    const rows = [];
    const terrainName = ['Water', 'Sand', 'Grass', 'Rock'][w.terrain[i]];

    const b = w.buildingAt(x, y);
    if (b) {
      const spec = BUILDINGS[b.type];
      rows.push(`<div class="subhead">${spec.name}</div>`);
      rows.push(row('Footprint', `${spec.span}x${spec.span}`));
      rows.push(row('Upkeep', `${money(spec.upkeep)}/mo`));
      if (spec.supply) rows.push(row('Output', `${commas(spec.supply)} MW`));
      if (spec.service) rows.push(row('Radius', `${spec.radius} tiles`));
      rows.push(row('Powered', b.powered ? 'Yes' : 'No'));
    } else if (w.zone[i]) {
      const info = ZONE_INFO[w.zone[i]];
      rows.push(`<div class="subhead">${info.name}</div>`);
      rows.push(row('Density', info.sub));
      rows.push(row('Stage', `${w.level[i]} / ${info.cap.length - 1}`));
      if (info.cat === 'R') rows.push(row('Residents', commas(w.pop[i])));
      else rows.push(row('Jobs', commas(w.jobs[i])));
      rows.push(row('Road access', w.roadAccess[i] ? 'Yes' : 'No'));
      rows.push(row('Power', w.powered[i] ? 'Yes' : 'No'));
      if (w.level[i] > 0) {
        rows.push(row('Character', WEALTH_NAMES[w.wealth[i]] ?? '-'));
        rows.push(row('Built', w.builtYear(i)));
        rows.push(row('Style', ERAS[w.eraOf(i)].name));
      } else {
        rows.push(row('Land value needed', info.lvNeed[1]));
      }
    } else if (w.road[i]) {
      const spec = ROAD_INFO[w.road[i]];
      rows.push(`<div class="subhead">${spec.name}</div>`);
      const load = w.traffic[i] / spec.capacity;
      rows.push(row('Traffic', `${Math.round(load * 100)}% of capacity`));
      rows.push(meter(clamp(load, 0, 1), load > 0.85 ? 'var(--bad)' : load > 0.6 ? 'var(--accent)' : 'var(--good)'));
      rows.push(row('Upkeep', `${money(spec.upkeep)}/mo`));
    } else {
      rows.push(`<div class="subhead">${terrainName}</div>`);
      if (w.tree[i]) rows.push(row('Cover', 'Woodland'));
    }

    rows.push('<div class="subhead">Land</div>');
    rows.push(row('Elevation', w.elevation[i]));
    rows.push(row('Land value', w.landValue[i]));
    rows.push(row('Pollution', w.pollution[i]));
    rows.push(row('Crime', w.crime[i]));

    rows.push('<div class="subhead">Coverage</div>');
    for (const k of SERVICE_KEYS) {
      rows.push(row(SERVICE_LABEL[k], `${Math.round((w.coverage[k][i] / 255) * 100)}%`));
    }
    return rows.join('');
  }

  renderAdvisors() {
    const host = document.getElementById('advisor-log');
    const log = this.game.world.log;
    if (!log.length) {
      host.innerHTML = '<div class="empty">No pressing business, Mayor.</div>';
      return;
    }
    // The log is a history, so a standing problem legitimately appears in it
    // more than once. The panel shows the current situation, so collapse to the
    // most recent instance of each distinct message.
    const seen = new Set();
    const unique = [];
    for (let i = log.length - 1; i >= 0 && unique.length < 8; i--) {
      if (seen.has(log[i].text)) continue;
      seen.add(log[i].text);
      unique.push(log[i]);
    }
    host.innerHTML = unique.map((m) => `<div class="${m.kind}">${m.text}</div>`).join('');
  }

  // -------------------------------------------------------------- modals --

  /**
   * What changed in the versions this player has not seen.
   *
   * Shown once after an update rather than every load, and never to someone
   * opening the game for the first time -- a brand new player has nothing to
   * compare it against, and a wall of notes about versions they never played
   * is a poor welcome.
   */
  showChangelog(entries, { firstRun = false } = {}) {
    if (!entries.length) {
      if (!firstRun) this.toast('You are up to date.');
      return false;
    }

    const one = entries.length === 1;
    document.getElementById('modal-title').textContent = one
      ? `What's new in ${entries[0].version}`
      : `What's new since you were last here`;
    document.getElementById('modal-body').innerHTML = entries.map((e) => `
      <div class="release">
        <div class="release-head">
          <span class="k">${e.headline}</span>
          <span class="v">${e.version}</span>
        </div>
        <ul>${e.changes.map((c) => `<li>${c}</li>`).join('')}</ul>
      </div>`).join('');
    document.getElementById('modal').classList.remove('hidden');
    return true;
  }

  /**
   * The city's own history, which it has been recording all along.
   *
   * A monthly snapshot has been written since the first version and nothing
   * ever displayed it -- two hundred and forty months of population, treasury,
   * approval and land value serialised into every save file and never read.
   * Drawn as plain SVG paths: the series are a few hundred points at most, and
   * a charting library would be larger than the rest of the game.
   */
  showGraphs() {
    const h = this.game.world.history;
    if (h.length < 2) {
      this.toast('Not enough history yet -- give the city a few months.');
      return;
    }

    const series = [
      { label: 'Population', color: '#7fb86a', at: (m) => m.population, fmt: commas },
      { label: 'Treasury', color: '#c9a13b', at: (m) => m.funds, fmt: money },
      { label: 'Approval', color: '#7fa8d6', at: (m) => m.approval, fmt: (v) => `${Math.round(v)}%` },
      { label: 'Land value', color: '#c98a5a', at: (m) => m.landValue, fmt: (v) => Math.round(v) },
      { label: 'Unemployment', color: '#c46b5c', at: (m) => m.unemployment * 100, fmt: (v) => `${v.toFixed(1)}%` },
    ];

    const first = h[0], last = h[h.length - 1];
    document.getElementById('modal-title').textContent = 'City history';
    document.getElementById('modal-body').innerHTML = `
      <div class="subhead">${MONTHS[first.month]} ${first.year} – ${MONTHS[last.month]} ${last.year}
        · ${h.length} month${h.length === 1 ? '' : 's'}</div>
      ${series.map((s) => this.chart(h, s)).join('')}
    `;
    document.getElementById('modal').classList.remove('hidden');
  }

  /** One series as an SVG path, with its range labelled. */
  chart(history, series) {
    const W = 330, H = 64, PAD = 3;
    const values = history.map(series.at);
    let lo = Math.min(...values), hi = Math.max(...values);
    if (hi - lo < 1e-6) { hi = lo + 1; }                 // a flat line still needs a box
    const span = hi - lo;

    const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
    const points = values.map((v, k) => {
      const x = PAD + k * step;
      const y = PAD + (1 - (v - lo) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Filled under the line, which reads better than a bare stroke at this size.
    const area = `M${points[0]} L${points.join(' L')} L${(PAD + (values.length - 1) * step).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;

    return `
      <div class="chart">
        <div class="chart-head">
          <span class="k">${series.label}</span>
          <span class="v">${series.fmt(values[values.length - 1])}</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${series.label} over time">
          <path d="${area}" fill="${series.color}" fill-opacity="0.18"/>
          <path d="M${points.join(' L')}" fill="none" stroke="${series.color}" stroke-width="1.5"/>
        </svg>
        <div class="chart-foot"><span>${series.fmt(lo)}</span><span>${series.fmt(hi)}</span></div>
      </div>`;
  }

  showBudget() {
    const w = this.game.world;
    const st = w.stats;
    const bd = st.breakdown || { taxR: 0, taxC: 0, taxI: 0, roadCost: 0, lineCost: 0, serviceCost: 0 };

    const taxRow = (key, label) => `
      <div class="tax-row">
        <span class="k">${label}</span>
        <input type="range" min="${TAX_MIN}" max="${TAX_MAX}" value="${w.tax[key]}" data-tax="${key}">
        <span class="v" id="tax-val-${key}">${w.tax[key]}%</span>
      </div>`;

    document.getElementById('modal-title').textContent = 'Budget';
    document.getElementById('modal-body').innerHTML = `
      <div class="subhead">Tax rates</div>
      ${taxRow('R', 'Residential')}
      ${taxRow('C', 'Commercial')}
      ${taxRow('I', 'Industrial')}
      <div class="subhead">Last month's revenue</div>
      ${row('Residential', money(bd.taxR))}
      ${row('Commercial', money(bd.taxC))}
      ${row('Industrial', money(bd.taxI))}
      <div class="subhead">Last month's outgoings</div>
      ${row('Roads', money(bd.roadCost))}
      ${row('Power lines', money(bd.lineCost))}
      ${row('Services', money(bd.serviceCost))}
      <div class="subhead">Balance</div>
      ${row('Net', money(st.lastBalance))}
      ${row('Treasury', money(w.funds))}
    `;

    for (const input of document.querySelectorAll('#modal-body input[data-tax]')) {
      input.addEventListener('input', (e) => {
        const key = e.target.dataset.tax;
        w.tax[key] = Number(e.target.value);
        document.getElementById(`tax-val-${key}`).textContent = `${w.tax[key]}%`;
      });
    }
    document.getElementById('modal').classList.remove('hidden');
  }

  closeModal() { document.getElementById('modal').classList.add('hidden'); }

  /** Show when the city was last written out, or that writing failed. */
  setSaveStatus(label) {
    const el = document.getElementById('save-status');
    if (!el) return;
    const failed = label === 'failed';
    el.classList.toggle('failed', failed);
    el.textContent = failed ? 'Save failed' : label ? `Saved ${label}` : '';
  }

  toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /** Live cost readout while a drag is in progress. */
  setCost(cost, affordable) {
    const el = document.getElementById('status-cost');
    el.textContent = cost ? money(cost) : '';
    el.style.color = affordable ? 'var(--accent)' : 'var(--bad)';
  }
}

function row(k, v) {
  return `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function meter(fraction, color) {
  const pct = Math.round(clamp(fraction, 0, 1) * 100);
  return `<div class="meter"><i style="width:${pct}%;background:${color}"></i></div>`;
}
