// DBHE LCOE calculator: inputs -> predictor -> heat -> E_t (ORC) -> LCOE, and the views of the result.
// To use the surrogate instead of the case library, construct a SurrogatePredictor in init() (see README.md).

import { LAYOUT_FAMILIES, generateLayout, minSpacing } from './layouts.js';
import { LibraryPredictor, MODEL_INPUTS, PARAMS } from './predictor.js';
import {
    LCOE_DEFAULTS, effectiveOrcEfficiency, electricityByYear, grossElectricityByYear, grossPowerKW, heatByYear, lcoe,
} from './economics.js';
import { pumpEnergyByYear, pumpPowerKW } from './pumping.js';

const SIM_YEARS = 20; // length of the simulations
// For now the model inputs are those of the chosen library case and cannot be edited. Set to true to let
// users edit them (the closest case is then used, or the surrogate once it is available).
const PHYSICAL_INPUTS_EDITABLE = false;
const MAX_T = 60;     // longest n with a fixed E_t
const COST_COLS = ['I', 'M', 'F'];

const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();

const $ = (id) => document.getElementById(id);
const state = {
    predictor: null, caseOverride: null, prediction: null, field: null,
    // I_t, M_t, F_t in $, indexed by t − 1; set from the inputs on the left, editable in the table.
    costs: Object.fromEntries(COST_COLS.map((k) => [k, new Array(MAX_T).fill(0)])),
    // Inputs that follow their literature default (and so the model) until the user changes them.
    auto: { I: true, M: true, eta: true, n: true },
};

// ---------- formatting ----------

const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '--' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 0) => `${fmt(v * 100, d)} %`;

// ---------- inputs ----------

function buildParamInputs(ranges) {
    const box = $('param_inputs');
    for (const p of PARAMS) {
        const r = ranges[p.key];
        const lo = r.min * p.scale, hi = r.max * p.scale;
        const mid = ((lo + hi) / 2).toFixed(p.digits);
        const g = document.createElement('div');
        g.className = 'input-group';
        g.innerHTML = `
            <label class="split" for="p_${p.key}"><span>${p.label} (${p.unit}) <code>${p.julia}</code></span>
                <span class="range">library ${fmt(lo, p.digits)}–${fmt(hi, p.digits)}</span></label>
            <div class="slider-row">
                <input type="range" id="r_${p.key}" min="${lo}" max="${hi}" step="${p.step}" value="${mid}"
                    aria-label="${p.label}">
                <input type="number" id="p_${p.key}" step="${p.step}" value="${mid}">
            </div>`;
        box.append(g);
        const range = g.querySelector('input[type=range]'), num = g.querySelector('input[type=number]');
        range.addEventListener('input', () => { num.value = range.value; onPhysicalInput(); });
        num.addEventListener('input', () => { range.value = num.value; onPhysicalInput(); });
    }
}

function setParamInputs(params) {
    for (const p of PARAMS) {
        const v = (params[p.key] * p.scale).toFixed(p.digits);
        $(`p_${p.key}`).value = v;
        $(`r_${p.key}`).value = v;
    }
}

function readRequest() {
    const family = $('family').value;
    const params = readParams();
    // "As in the case": the exact well positions of the last picked library case.
    if (family === 'case') return { family: state.caseLayout.family, wells_xy_m: state.caseLayout.wells, params };
    const n = family === 'single' ? 1 : Math.min(25, Math.max(2, Math.round(+$('n_wells').value || 2)));
    const spacing = Math.max(1, +$('spacing').value || 80);
    return { family, wells_xy_m: generateLayout(family, n, spacing), params };
}

function readParams() {
    const params = {};
    for (const p of PARAMS) {
        const input = $(`p_${p.key}`);
        params[p.key] = (+input.value) / p.scale;
        const r = state.predictor.ranges[p.key];
        input.classList.toggle('outside', params[p.key] < r.min - 1e-9 || params[p.key] > r.max + 1e-9);
    }
    return params;
}

const eMode = () => document.querySelector('input[name=e_mode]:checked').value;
// Every horizon fits the MAX_T years of the cost arrays: with the model, α − 1 + 20 ≤ MAX_T bounds α.
const maxAlpha = () => (eMode() === 'model' ? MAX_T - SIM_YEARS + 1 : MAX_T);
const readAlpha = () => Math.min(maxAlpha(), Math.max(1, Math.round(+$('lcoe_alpha').value || 1)));
const maxN = (alpha) => Math.min(MAX_T, eMode() === 'model' ? alpha - 1 + SIM_YEARS : MAX_T);

function readLcoeInputs() {
    const r = Math.max(0, +$('lcoe_r').value || 0) / 100;
    const alpha = readAlpha();
    $('lcoe_alpha').max = maxAlpha();
    $('lcoe_alpha').classList.toggle('outside', +$('lcoe_alpha').value > maxAlpha());
    if (state.auto.n) $('lcoe_n').value = eMode() === 'model' ? maxN(alpha) : Math.min(MAX_T, alpha - 1 + LCOE_DEFAULTS.n_fixed);
    const n = Math.min(maxN(alpha), Math.max(1, Math.round(+$('lcoe_n').value || 1)));
    $('lcoe_n').max = maxN(alpha);
    $('lcoe_n').classList.toggle('outside', +$('lcoe_n').value > maxN(alpha));
    return { r, n, alpha, eta: readEta() };
}

// ---------- LCOE inputs and their literature defaults ----------

/** Mean outlet temperature of all wells over the simulation, °C. */
function meanOutlet(pr) {
    let s = 0, k = 0;
    for (const w of pr.T_out_C) for (const T of w) { s += T; k++; }
    return s / k;
}

/**
 * η in use: the exact default while it follows the model (the input shows it rounded), else the input.
 * A typed value outside 0–100 % is not used: it is clamped and flagged (see checkEta).
 */
function readEta() {
    if (state.auto.eta && state.etaDefault != null) return state.etaDefault;
    return Math.min(100, Math.max(0, +$('eta').value || 0)) / 100;
}

/**
 * Months of the production horizon in which the gross output exceeds the thermodynamic limit of that month
 * (the exergy of the water, grossPowerKW with 'ideal'). Checked month by month, since an average over the
 * years can hide months above the limit. eta as in grossPowerKW (null: the efficiency fit).
 */
function exergyViolations(pr, eta, years) {
    const gross = grossPowerKW(pr, eta), ideal = grossPowerKW(pr, 'ideal');
    const months = Math.min(gross.length, Math.round(years * gross.length / SIM_YEARS));
    let count = 0, worst = 0;
    for (let i = 0; i < months; i++) {
        const excess = gross[i] - ideal[i];
        if (excess > 1e-6 * Math.max(1, ideal[i])) { count++; worst = Math.max(worst, excess); }
    }
    return { count, months, worst };
}

/**
 * Flags a typed η that is not a percentage, or a gross output (typed η or the default fit) above the
 * thermodynamic limit in any month of the production horizon.
 */
function checkEta({ n, alpha }) {
    const el = $('eta_check'), raw = +$('eta').value;
    const model = eMode() === 'model' && state.prediction;
    let msg = '';
    if (!state.auto.eta && (raw < 0 || raw > 100)) msg = 'η must be between 0 and 100 %.';
    else if (model) {
        const v = exergyViolations(state.prediction, etaArg(), Math.max(0, n - alpha + 1));
        if (v.count) msg = `${state.auto.eta ? 'With the efficiency fit, the' : 'With this η, the'} gross output exceeds the`
            + ` thermodynamic limit in ${v.count} of ${v.months} months (by up to ${fmt(v.worst, 1)} kW_e):`
            + ' no plant can reach it, so this LCOE is physically impossible.';
    }
    el.textContent = msg;
    el.hidden = !msg;
    $('eta').classList.toggle('outside', !!msg);
    // A value that is not a percentage gives no LCOE, rather than one computed with a clamped η.
    if (!state.auto.eta && model && (raw < 0 || raw > 100)) {
        $('kpi_lcoe').textContent = 'Invalid η';
        $('kpi_lcoe').classList.add('none');
        $('kpi_unit').hidden = true;
    }
}

/** η for the electricity: null while it follows the model (the fit is applied month by month), else the input. */
const etaArg = () => (state.auto.eta ? null : readEta());

/**
 * Default I_t: drilling of every well, plus the power plant sized for the largest monthly gross electric
 * power of the simulation (so that no month produces more than the plant can convert), or, with a fixed
 * E_t (MWh/yr), for the constant power E_t / 8760 h. With a fixed E_t no pumping is modelled, so E_t is
 * also the plant output: in both modes the plant is sized on what it produces.
 */
const plantKW = (pr, eta, fixedE = null) => (fixedE != null ? fixedE * 1e3 / (365 * 24) : Math.max(...grossPowerKW(pr, eta)));

function modelDefaults(pr, eta, fixedE = null) {
    const kWe = plantKW(pr, eta, fixedE);
    const nWells = pr.used.wells_xy_m.length;
    const drill = nWells * pr.wellDepth * LCOE_DEFAULTS.drill_usd_per_m;
    const plant = kWe * LCOE_DEFAULTS.plant_usd_per_kWe;
    return { I: Math.round((drill + plant) / 1e4) * 1e4, drill, plant, nWells };
}

/** LCOE of a library case with every input at its default, $/MWh (null if the net E_t sums to ≤ 0). */
function defaultLcoe(pr) {
    const { I, plant } = modelDefaults(pr, null);
    const alpha = LCOE_DEFAULTS.alpha, n = alpha - 1 + SIM_YEARS, build = Math.max(1, alpha - 1);
    const M = LCOE_DEFAULTS.om_share * plant;
    const t = Array.from({ length: n }, (_, i) => i + 1);
    return lcoe({
        I: t.map((x) => (x <= build ? I / build : 0)),
        M: t.map((x) => (x >= alpha ? M : 0)),
        F: t.map((x) => (x >= alpha ? LCOE_DEFAULTS.F : 0)),
        E: electricityByYear(grossElectricityByYear(pr), alpha, n,
            pumpEnergyByYear(pr, LCOE_DEFAULTS.roughness_mm / 1e3, LCOE_DEFAULTS.pump_efficiency)),
        r: LCOE_DEFAULTS.r, n, alpha,
    }).lcoe;
}

/** Applies the defaults to the inputs that still follow them. */
function applyDefaults() {
    const pr = state.prediction;
    if (!pr) return;
    const etaDefault = state.etaDefault = effectiveOrcEfficiency(pr);
    $('eta_hint').textContent = `default ${fmt(etaDefault * 100, 2)} % (exploratory)`;
    if (state.auto.eta) $('eta').value = (etaDefault * 100).toFixed(2);
    const fixedE = eMode() === 'fixed' ? Math.max(0, +$('lcoe_E').value || 0) : null;
    const d = modelDefaults(pr, etaArg(), fixedE);
    $('lcoe_I_src').textContent = `Default: ${d.nWells} wells × ${fmt(pr.wellDepth, 0)} m × $${fmt(LCOE_DEFAULTS.drill_usd_per_m, 0)}/m`
        + ` + power plant at $${fmt(LCOE_DEFAULTS.plant_usd_per_kWe, 0)}/kWe of `
        + (fixedE == null ? 'peak monthly gross output' : 'the fixed E_t as constant power (E_t / 8760 h)')
        + ` = $${fmt(d.I / 1e6, 2)} M.`;
    if (state.auto.I) $('lcoe_I').value = d.I;
    if (state.auto.M) $('lcoe_M').value = Math.round(LCOE_DEFAULTS.om_share * d.plant);
    const cols = ['I', 'M'].filter((k) => state.auto[k]);
    if (cols.length) buildSchedule(cols);
}

/** I_t, M_t and F_t from the inputs on the left: I spread over t = 1…α−1, M and F every year t ≥ α. */
function scheduleValue(k, t) {
    const alpha = readAlpha();
    const build = Math.max(1, alpha - 1);
    const v = Math.max(0, +$(`lcoe_${k}`).value || 0);
    if (k === 'I') return t <= build ? v / build : 0;
    return t >= alpha ? v : 0;
}

function buildSchedule(cols = COST_COLS) {
    for (const k of cols) state.costs[k] = Array.from({ length: MAX_T }, (_, i) => scheduleValue(k, i + 1));
    $('cost_rows').innerHTML = ''; // the year-by-year inputs are rebuilt with the new values
}

function onLcoeInput(e) {
    const id = e.target.id;
    if (id === 'eta') state.auto.eta = false;
    if (id === 'lcoe_I') state.auto.I = false;
    if (id === 'lcoe_M') state.auto.M = false;
    if (id === 'lcoe_n') state.auto.n = false;
    if (id === 'eta' || id === 'lcoe_E') applyDefaults();
    else if (['lcoe_I', 'lcoe_M', 'lcoe_F', 'lcoe_alpha'].includes(id)) buildSchedule();
    onEconInput();
}

function resetDefault(which) {
    if (which === 'I') { state.auto.I = true; state.auto.M = true; }
    if (which === 'eta') state.auto.eta = true;
    applyDefaults();
    updateEconomics();
}

function onModeChange() {
    const model = eMode() === 'model';
    $('phys').disabled = !model;
    $('e_fixed_box').hidden = model;
    $('e_model_note').hidden = !model;
    if (!model && $('lcoe_E').value === '') {
        // Start from the model's mean E_t, so that switching keeps the LCOE in the same range.
        const E = state.prediction ? grossElectricityByYear(state.prediction, etaArg()).map((g, k) => g - (state.pump ? state.pump[k] : 0)) : [];
        const mean = E.length ? E.reduce((a, b) => a + b, 0) / E.length : 0;
        $('lcoe_E').value = mean > 0 ? +mean.toPrecision(3) : LCOE_DEFAULTS.E_fixed_MWh;
    }
    for (const el of document.querySelectorAll('.model-out')) el.hidden = !model || !state.prediction;
    $('outputs_off').hidden = model;
    $('n_hint').textContent = model ? 'α − 1 + 20, the simulated years (at most)'
        : 'α − 1 + 30: 30 years of production, the plant lifetime of NREL ATB';
    state.auto.n = true;
    applyDefaults(); // the plant is sized on E_t
    updateEconomics();
}

let physicalTimer = null, econTimer = null;
function onPhysicalInput() {
    state.caseOverride = null;
    $('case_pick').value = '';
    clearTimeout(physicalTimer);
    physicalTimer = setTimeout(updatePrediction, 100);
}
function onEconInput() {
    clearTimeout(econTimer);
    econTimer = setTimeout(updateEconomics, 80);
}

// ---------- prediction ----------

async function updatePrediction() {
    try {
        const request = readRequest();
        const prediction = await state.predictor.predict(request, {
            caseId: state.caseOverride,
            layoutWeight: +$('match_weight').value,
        });
        state.prediction = prediction;
        updatePump();
        $('status').textContent = '';
        $('case_pick').value = state.caseOverride == null ? '' : String(state.caseOverride);
        applyDefaults();
        renderMatch(prediction);
        renderModelInputs(prediction);
        updateEconomics();
        loadField(prediction);
    } catch (err) {
        console.error(err);
        $('status').textContent = `Could not compute the well outputs: ${err.message}`;
        $('status').className = 'status error';
    }
}

function renderMatch(pr) {
    const { source, used, request } = pr;
    $('match_card').hidden = false;
    $('match_title').textContent = source.label;
    const u = used.layout;
    $('match_sub').textContent = `${source.setting} · ${u.n_wells} well${u.n_wells > 1 ? 's' : ''}`
        + (u.min_spacing_m ? ` · closest spacing ${fmt(u.min_spacing_m, 0)} m` : '')
        + ` · undisturbed rock at 3000 m: ${fmt(used.T_bottom_C, 1)} °C`;
    // Match quality from the largest deviation of one input, as a share of its library range, and
    // from the well count.
    const worst = Math.max(...PARAMS.map((p) => {
        const r = state.predictor.ranges[p.key];
        return Math.abs(request.params[p.key] - used.params[p.key]) / (r.max - r.min);
    }));
    const sameCount = request.wells_xy_m.length === u.n_wells;
    const quality = worst <= 0.1 && sameCount ? 'close match' : worst <= 0.25 ? 'approximate match' : 'far from the inputs';
    const chip = $('match_chip');
    chip.textContent = state.caseOverride != null ? 'chosen case' : quality;
    chip.classList.toggle('far', state.caseOverride == null && worst > 0.25);

    const rows = [];
    const offCell = (off) => {
        const w = Math.min(1, off) * 60;
        return `<span class="offbar ${off > 0.25 ? 'far' : ''}"><i style="width:${Math.max(2, w)}px"></i>${pct(off)}</span>`;
    };
    for (const p of PARAMS) {
        const r = state.predictor.ranges[p.key];
        const a = request.params[p.key], b = used.params[p.key];
        rows.push(`<tr><td>${p.label} (${p.unit})</td><td>${fmt(a * p.scale, p.digits)}</td>
            <td>${fmt(b * p.scale, p.digits)}</td><td>${offCell(Math.abs(a - b) / (r.max - r.min))}</td></tr>`);
    }
    const reqN = request.wells_xy_m.length, reqS = minSpacing(request.wells_xy_m);
    const fam = $('family').value === 'case' ? `as case ${state.caseLayout.caseId}`
        : LAYOUT_FAMILIES.find((f) => f.id === request.family)?.label ?? request.family;
    rows.push(`<tr><td>Layout</td><td>${fam}</td><td>${u.label}</td><td></td></tr>`);
    rows.push(`<tr><td>Wells</td><td>${reqN}</td><td>${u.n_wells}</td><td></td></tr>`);
    rows.push(`<tr><td>Closest spacing (m)</td><td>${reqS ? fmt(reqS, 0) : '–'}</td>
        <td>${u.min_spacing_m ? fmt(u.min_spacing_m, 0) : '–'}</td><td></td></tr>`);
    $('match_rows').innerHTML = rows.join('');
    const warn = $('match_warn');
    warn.hidden = reqN === u.n_wells;
    warn.textContent = `The library has no case with ${reqN} wells; the closest has ${u.n_wells}. `
        + 'The outputs are for that case.';
    $('sum_matched').textContent = `#${source.case_id} · ${chip.textContent}`;
    $('outputs_src').textContent = `${source.label} (${source.setting}).`;

    const alts = $('match_alts');
    alts.innerHTML = '';
    for (const a of source.alternatives.filter((a) => a.case_id !== source.case_id).slice(0, 5)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `#${a.case_id} ${a.layout}`;
        b.title = `distance ${fmt(a.distance, 2)}`;
        b.addEventListener('click', () => pickCase(a.case_id));
        alts.append(b);
    }
}

function renderModelInputs(pr) {
    const show = (v, unit) => {
        if (unit === 'm' && v < 1) return `${fmt(v * 1e3, v * 1e3 < 10 ? 2 : 1)} mm`;
        return `${+v.toPrecision(4)} ${unit}`;
    };
    let group = null;
    $('model_input_rows').innerHTML = MODEL_INPUTS.map((d) => {
        let value, status;
        if (d.layout) {
            value = `${pr.used.wells_xy_m.length} well${pr.used.wells_xy_m.length > 1 ? 's' : ''}`;
            status = 'varied';
        } else if (d.param) {
            value = show(pr.used.params[d.param], d.unit);
            status = 'varied';
        } else if (d.value == null) {
            value = '–';
            status = 'fixed, not stated';
        } else {
            value = show(d.value, d.unit);
            status = 'fixed';
        }
        const head = d.group !== group ? `<tr class="group"><td colspan="3"><code>${(group = d.group)}</code></td></tr>` : '';
        const note = d.note ? `<small>${d.note}</small>` : '';
        return `${head}<tr><td><code>${d.name}</code>${note}</td><td>${value}</td><td>${status}</td></tr>`;
    }).join('');
    $('sum_args').textContent = `${MODEL_INPUTS.length} arguments`;
    $('model_inputs_card').hidden = false;
}

/** Uses a library case and sets the model inputs to its values (null: the case closest to the inputs). */
function pickCase(caseId) {
    state.caseOverride = caseId;
    // A new case is a new array: I, M, η, n and the fixed E_t go back to the defaults of that case.
    Object.assign(state.auto, { I: true, M: true, eta: true, n: true });
    $('lcoe_E').value = '';
    $('case_pick').value = caseId == null ? '' : String(caseId);
    const c = state.predictor.cases.find((x) => x.case_id === caseId);
    if (c) {
        setParamInputs(c.params);
        // Request the case's own well positions; the generated layouts cannot reproduce every case.
        state.caseLayout = { caseId: c.case_id, label: c.layout, family: c.family, wells: c.wells_xy_m };
        const opt = $('family').querySelector('option[value="case"]');
        opt.hidden = false;
        opt.textContent = `As in case ${c.case_id} (${c.layout})`;
        $('family').value = 'case';
        $('n_wells').value = c.n_wells;
        if (c.min_spacing_m) $('spacing').value = Math.round(c.min_spacing_m);
        syncLayoutInputs();
    }
    updatePrediction();
}

// ---------- pumping ----------

function readPump() {
    return {
        on: $('pump_on').checked,
        efficiency: Math.min(1, Math.max(0.01, (+$('pump_eff').value || 0) / 100)),
        roughness: Math.max(0, +$('pump_eps').value || 0) / 1e3, // mm -> m
    };
}

/** Pumping power (kW, every outlet sample) and energy (MWh, every year) of the current prediction. */
function updatePump() {
    const pr = state.prediction;
    if (!pr) return;
    const p = readPump();
    state.pumpKW = pumpPowerKW(pr, p.roughness, p.efficiency);
    state.pump = p.on ? pumpEnergyByYear(pr, p.roughness, p.efficiency) : null;
    $('pump_eff').disabled = $('pump_eps').disabled = !p.on;
}

function onPumpInput() {
    updatePump();
    onEconInput();
}

// ---------- economics ----------

function currentE(n, alpha) {
    if (eMode() === 'model') return electricityByYear(grossElectricityByYear(state.prediction, etaArg()), alpha, n, state.pump);
    const v = Math.max(0, +$('lcoe_E').value || 0);
    return Array.from({ length: n }, (_, i) => (i + 1 >= alpha ? v : 0));
}

function updateEconomics() {
    const pr = state.prediction;
    if (!pr) return;
    const { r, n, alpha, eta } = readLcoeInputs();
    const res = lcoe({ ...state.costs, E: currentE(n, alpha), r, n, alpha });
    renderLcoe(res, { r, n, alpha, eta });
    renderBound({ r, n, alpha });
    renderCapacityFactor({ n, alpha });
    renderSensitivity({ r, n, alpha });
    checkEta({ n, alpha });
    renderLcoeCharts(res, alpha);
    renderCostInputs(n);
    renderFoldSummaries({ r, n, alpha, eta });
    const model = eMode() === 'model';
    for (const id of ['kpis', 'table_card', 'outputs_head']) $(id).hidden = false;
    for (const el of document.querySelectorAll('.model-out')) el.hidden = !model;
    if (model) {
        renderOutletChart(pr);
        renderPowerChart(pr);
    }
}

function renderLcoe(res, { r, n, alpha, eta }) {
    // 1 $/MWh = 100 ¢ / 1000 kWh = 0.1 ¢/kWh
    const perUnit = $('lcoe_unit').value === 'cents_per_kWh' ? 0.1 : 1;
    $('kpi_unit').textContent = $('lcoe_unit').selectedOptions[0].text;
    const undef = res.lcoe == null;
    $('kpi_lcoe').textContent = undef ? 'No net electricity' : fmt(res.lcoe * perUnit, 2);
    $('kpi_lcoe').classList.toggle('none', undef);
    $('kpi_unit').hidden = undef;
    const ref = (lo, hi) => `${fmt(lo * perUnit, perUnit < 1 ? 1 : 0)}–${fmt(hi * perUnit, perUnit < 1 ? 1 : 0)} ${perUnit < 1 ? '¢/kWh' : '$/MWh'}`;
    $('kpi_bench').innerHTML = `Other systems, for comparison only (different designs, not targets for these arrays):`
        + ` new conventional geothermal plants ${ref(64, 106)} <a href="#ref-lazard">[7]</a>; the cheapest closed-loop`
        + ` designs of White et al. ${ref(83, 97)}, an optimistic configuration with 5 km deep wells, 20 km laterals,`
        + ` 70 °C/km, high rock conductivity and outlet temperatures above 100 °C <a href="#ref-white">[2]</a>.`;
    $('kpi_num').textContent = `$${fmt(res.costSum, 0)}`;
    $('kpi_den').textContent = `${fmt(res.energySum, 0)} MWh`;
    const total = res.rows.reduce((s, x) => s + x.E, 0);
    const model = eMode() === 'model';
    $('kpi_note').textContent = `n = ${n} years, r = ${fmt(r * 100, 2)} %, α = ${alpha}. `
        + `Σ E_t = ${fmt(total, 0)} MWh over t = ${alpha}…${n}, `
        + (model ? `from ${pr_label()} with ` + (state.auto.eta
            ? `η from the fit, applied month by month (mean ${fmt(eta * 100, 2)} %)` : `η = ${fmt(eta * 100, 2)} %`)
            + (state.pump ? `, net of ${fmt(state.pump.reduce((a, b) => a + b, 0), 0)} MWh of pumping over the 20 years.` : ', without pumping.')
            : 'a fixed value.')
        + (undef ? ' The LCOE is undefined.' : '');
    renderUndefined(undef && model, { r, n, alpha }, perUnit);
    const warn = $('eta_warn');
    const T = meanOutlet(state.prediction);
    warn.hidden = !model;
    warn.innerHTML = (T < 100
        ? `The mean outlet temperature of this case is ${fmt(T, 1)} °C. The ORC efficiency fit is based on plants`
            + ' at 103–166 °C <a href="#ref-mit">[4]</a> and closed-loop studies limit the ORC to geofluid above 100 °C'
            + ' <a href="#ref-white">[2]</a>, so η here is an extrapolation and electricity generation may not be practical. '
        : '')
        + 'This LCOE is an exploratory estimate: the conversion efficiency, the pumping and the thermal predictions are not yet'
        + ' validated. Staying below the thermodynamic limit shows only that the output does not exceed that ceiling, not that'
        + ' a real plant can achieve it.';
}

/**
 * How much the two least certain inputs move this LCOE: the pumping estimate (±15 %; the thermosiphon,
 * neglected, lowers it, and the surface losses, also neglected, raise it) and the O&M basis (1.5 % of the
 * total investment instead of the plant cost). The other inputs stay as they are.
 */
function renderSensitivity({ r, n, alpha }) {
    const el = $('kpi_sens');
    el.hidden = eMode() !== 'model' || !state.pump;
    if (el.hidden) return;
    const pr = state.prediction, perUnit = $('lcoe_unit').value === 'cents_per_kWh' ? 0.1 : 1;
    const unit = $('lcoe_unit').selectedOptions[0].text;
    const gross = grossElectricityByYear(pr, etaArg());
    const at = (costs, f) => lcoe({ ...costs, E: electricityByYear(gross, alpha, n, state.pump.map((p) => p * f)), r, n, alpha }).lcoe;
    const show = (v) => (v == null ? 'undefined (no net electricity)' : `${fmt(v * perUnit, 0)} ${unit}`);
    const G = gross.reduce((a, b) => a + b, 0), P = state.pump.reduce((a, b) => a + b, 0);
    const invest = state.costs.I.slice(0, n).reduce((a, b) => a + b, 0);
    const omTotal = { ...state.costs, M: state.costs.M.map((_, i) => (i + 1 >= alpha ? LCOE_DEFAULTS.om_share * invest : 0)) };
    el.innerHTML = `<b>Main uncertainties.</b> The pumps use ${fmt(P / G * 100, 0)} % of the gross output, so the net electricity`
        + ` is a small difference and the LCOE depends strongly on the pumping estimate: with 15 % less pumping it would be`
        + ` ${show(at(state.costs, 0.85))}, with 15 % more ${show(at(state.costs, 1.15))}. The neglected thermosiphon lowers`
        + ' the pumping and the neglected surface losses raise it. With O&amp;M at 1.5 % of the total investment instead of the'
        + ` plant cost, the LCOE would be ${show(at(omTotal, 1))}.`;
}

/**
 * Capacity factor of the plant, an output: the mean gross output over the production years divided by
 * the plant capacity, the peak monthly gross power (see plantKW). With a fixed E_t the output is
 * constant and the plant is sized for it, so it is 100 %. No downtime is assumed.
 */
function renderCapacityFactor({ n, alpha }) {
    const el = $('kpi_cf');
    if (eMode() !== 'model') {
        el.textContent = 'Capacity factor: 100 %. With a fixed E_t the output is constant and the plant is built for it (no downtime assumed).';
        return;
    }
    const gross = grossElectricityByYear(state.prediction, etaArg());
    const years = Math.min(gross.length, n - alpha + 1);
    el.hidden = !(years > 0 && gross[0] > 0);
    if (el.hidden) return;
    const kW = plantKW(state.prediction, etaArg());
    const cf = gross.slice(0, years).reduce((a, b) => a + b, 0) / years / (kW * 365 * 24 / 1e3);
    el.textContent = `Capacity factor: ${fmt(cf * 100, 1)} %. The plant is built for ${fmt(kW, 1)} kW_e, its highest monthly`
        + ` output; over the ${years} production years it produces on average ${fmt(cf * 100, 1)} % of that, because the output`
        + ' falls as the rock cools (no downtime assumed).';
}

/**
 * Sensitivity: the LCOE with the thermodynamic limit of the conversion instead of the ORC fit, same costs
 * and pumping. A best case for the conversion only; the pumping is an estimate, not a bound.
 */
function renderBound({ r, n, alpha }) {
    const el = $('kpi_bound');
    el.hidden = eMode() !== 'model';
    if (el.hidden) return;
    const pr = state.prediction;
    const E = electricityByYear(grossElectricityByYear(pr, 'ideal'), alpha, n, state.pump);
    const res = lcoe({ ...state.costs, E, r, n, alpha });
    const q = grossElectricityByYear(pr, 'ideal').reduce((a, b) => a + b, 0);
    const Q = heatByYear(pr).reduce((a, b) => a + b, 0);
    const perUnit = $('lcoe_unit').value === 'cents_per_kWh' ? 0.1 : 1;
    el.innerHTML = `<b>Perfect-plant limit.</b> What if the power plant were perfect? At most ${fmt(q / Q * 100, 2)} % of this heat could become electricity`
        + ' (the physical limit at these water temperatures). With that, and the same costs and pumping, the LCOE would be '
        + (res.lcoe == null ? 'still undefined, because the pumps would use more than the plant makes.'
            : `${fmt(res.lcoe * perUnit, 2)} ${$('lcoe_unit').selectedOptions[0].text}.`)
        + ' A real plant converts only part of this, so with these costs its LCOE would be higher.';
}

/**
 * Why the LCOE is undefined, in numbers: the ORC output and the pumping over the simulated years, and the
 * LCOE without pumping, which stays defined as long as the ORC makes anything.
 */
function renderUndefined(show, { r, n, alpha }, perUnit) {
    const el = $('lcoe_undef');
    el.hidden = !show;
    if (!show) return;
    const gross = grossElectricityByYear(state.prediction, etaArg());
    const G = gross.reduce((a, b) => a + b, 0);
    const P = state.pump ? state.pump.reduce((a, b) => a + b, 0) : 0;
    const noPump = lcoe({ ...state.costs, E: electricityByYear(gross, alpha, n, null), r, n, alpha });
    const unit = $('lcoe_unit').selectedOptions[0].text;
    el.textContent = `No LCOE for ${pr_label()}: over the 20 years the ORC makes ${fmt(G, 0)} MWh and the circulation pumps use `
        + `${fmt(P, 0)} MWh, so the array consumes more electricity than it generates. `
        + (noPump.lcoe == null ? 'The ORC makes no electricity at these temperatures.'
            : `Without pumping the LCOE would be ${fmt(noPump.lcoe * perUnit, 2)} ${unit}.`)
        + (state.positiveCases?.length ? ` With the default inputs only case${state.positiveCases.length > 1 ? 's' : ''}`
            + ` ${state.positiveCases.join(' and ')} ha${state.positiveCases.length > 1 ? 've' : 's'} positive net output`
            + ' (marked in the case list).' : '');
}

const pr_label = () => (state.prediction.source.kind === 'library' ? `library case ${state.prediction.source.case_id}` : 'the surrogate');

// Year-by-year inputs of I_t, M_t, F_t in the input panel; rebuilt only when n changes or the columns are
// reset, so typing keeps focus.
function renderCostInputs(n) {
    const body = $('cost_rows');
    if (body.rows.length === n) return;
    body.innerHTML = Array.from({ length: n }, (_, i) => `<tr><td>${i + 1}</td>`
        + COST_COLS.map((k) => `<td><input type="number" min="0" step="1000" data-col="${k}" data-t="${i + 1}"
            aria-label="${k} in year ${i + 1}" value="${state.costs[k][i]}"></td>`).join('') + '</tr>').join('');
}

/** Current values next to the title of each input group, so the panel can be read while folded. */
function renderFoldSummaries({ r, n, alpha, eta }) {
    const money = (v) => (v >= 1e6 ? `$${fmt(v / 1e6, 1)} M` : `$${fmt(v / 1e3, 0)} k`);
    $('sum_exp').textContent = `I ${money(+$('lcoe_I').value || 0)} · M ${money(+$('lcoe_M').value || 0)}/yr`;
    const edited = COST_COLS.some((k) => state.costs[k].some((v, i) => v !== scheduleValue(k, i + 1)));
    $('sum_years_edit').textContent = edited ? 'edited' : `${n} years`;
    $('sum_energy_src').textContent = eMode() === 'model' ? 'model' : `${fmt(+$('lcoe_E').value || 0, 0)} MWh/yr`;
    $('sum_time').textContent = `r ${fmt(r * 100, 1)} % · n ${n} · α ${alpha}`;
    $('sum_unit').textContent = $('lcoe_unit').selectedOptions[0].text;
    $('E_note').textContent = state.pump && eMode() === 'model' ? '· pumping subtracted' : '· pumping not subtracted';
    const pr = state.prediction;
    if (!pr) return;
    $('sum_case').textContent = state.caseOverride != null ? `case ${pr.source.case_id}` : `closest: ${pr.source.case_id}`;
    $('sum_eta').textContent = `η ${fmt(eta * 100, 2)} % · ${state.pump ? 'net of pumping' : 'gross'}`;
    const fam = $('family').value === 'case' ? `as case ${state.caseLayout.caseId}`
        : LAYOUT_FAMILIES.find((f) => f.id === $('family').value)?.label ?? '';
    $('sum_layout').textContent = `${fam}, ${readRequest().wells_xy_m.length} wells`;
    $('sum_rock').textContent = `${fmt(+$('p_mdot_kg_s').value, 1)} kg/s · ${fmt(+$('p_gradient_K_m').value, 1)} K/km`;
    $('sum_match').textContent = $('match_weight').selectedOptions[0].text.split(' ')[0].toLowerCase();
}

function onCostInput(e) {
    const input = e.target;
    if (!input.dataset.col) return;
    const v = +input.value;
    state.costs[input.dataset.col][+input.dataset.t - 1] = Number.isFinite(v) ? v : 0;
    // An edited column no longer follows the model.
    if (input.dataset.col === 'I' || input.dataset.col === 'M') state.auto[input.dataset.col] = false;
    onEconInput();
}

/** Copies the first year of a column (t = 1 for I_t, t = α for M_t and F_t) to every later year. */
function fillDown(col) {
    const first = col === 'I' ? 1 : readAlpha();
    const v = state.costs[col][first - 1];
    for (let i = first - 1; i < MAX_T; i++) state.costs[col][i] = v;
    for (const input of $('cost_rows').querySelectorAll(`input[data-col="${col}"]`)) if (+input.dataset.t >= first) input.value = v;
    updateEconomics();
}

// ---------- charts ----------

let toutChart = null, powerChart = null;

// Chart look of the group site: light surface, hairline grid in the border color, text tokens.
function chartDefaults() {
    Chart.defaults.color = color('--text-muted');
    Chart.defaults.borderColor = color('--border');
    Chart.defaults.font.family = color('--font-family');
    Chart.defaults.font.size = 12;
    Chart.defaults.plugins.tooltip.backgroundColor = color('--bg-color');
    Chart.defaults.plugins.tooltip.titleColor = color('--text-primary');
    Chart.defaults.plugins.tooltip.bodyColor = color('--text-secondary');
    Chart.defaults.plugins.tooltip.borderColor = color('--border');
    Chart.defaults.plugins.tooltip.borderWidth = 1;
}

/** Outlet temperature of every well (thin, light) and their mean (thick, dark), with the inlet. */
function renderOutletChart(pr) {
    const t = pr.t_out_years, T = pr.T_out_C;
    const mean = t.map((x, i) => ({ x, y: T.reduce((s, w) => s + w[i], 0) / T.length }));
    const inlet = [{ x: 0, y: pr.used.params.T_inlet_C }, { x: t[t.length - 1], y: pr.used.params.T_inlet_C }];
    const line = color('--series-1-line'), dark = color('--series-1-dark');
    const datasets = [
        ...T.map((w, k) => ({ label: `Well ${k + 1}`, legend: 'Each well', data: t.map((x, i) => ({ x, y: w[i] })), borderColor: line, backgroundColor: line, borderWidth: 1, pointRadius: 0, tension: 0.4 })),
        { label: 'Mean of wells', data: mean, borderColor: dark, backgroundColor: dark, borderWidth: 2.5, pointRadius: 0, tension: 0.4 },
        { label: 'Inlet', data: inlet, borderColor: color('--reference'), backgroundColor: color('--reference'), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
    ];
    if (toutChart) {
        toutChart.data.datasets = datasets;
        toutChart.update('none');
        return;
    }
    toutChart = new Chart($('chart_tout'), {
        type: 'line',
        data: { datasets },
        options: {
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { type: 'linear', min: 0, max: 20, title: { display: true, text: 'Years of operation' }, ticks: { stepSize: 5 } },
                y: { title: { display: true, text: '°C' } },
            },
            plugins: {
                legend: {
                    labels: {
                        boxWidth: 12,
                        boxHeight: 2,
                        // One legend entry for all the wells.
                        filter: (item, data) => data.datasets[item.datasetIndex].legend !== 'Each well' || item.datasetIndex === 0,
                        generateLabels: (chart) => Chart.defaults.plugins.legend.labels.generateLabels(chart)
                            .map((l) => ({ ...l, text: chart.data.datasets[l.datasetIndex].legend ?? l.text })),
                    },
                },
                tooltip: {
                    // The mean and the inlet, plus the range of the wells; one line per well would be too long.
                    filter: (item) => item.dataset.label === 'Mean of wells' || (item.dataset.label === 'Inlet' && item.dataIndex === 0),
                    callbacks: {
                        title: (items) => `Year ${fmt(items[0].parsed.x, 2)}`,
                        label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y, 2)} °C`,
                        afterBody: (items) => {
                            const i = items[0].dataIndex, v = state.prediction.T_out_C.map((w) => w[i]);
                            return v.length > 1 ? `Wells: ${fmt(Math.min(...v), 2)} to ${fmt(Math.max(...v), 2)} °C` : '';
                        },
                    },
                },
            },
        },
    });
}

/** Gross ORC output, pumping and net electric power of the array over time, kW_e (one unit, one axis). */
function renderPowerChart(pr) {
    const t = pr.t_out_years;
    const grossKW = grossPowerKW(pr, etaArg());
    const gross = t.map((x, i) => ({ x, y: grossKW[i] }));
    const pump = t.map((x, i) => ({ x, y: state.pump ? state.pumpKW[i] : 0 }));
    const net = gross.map((g, i) => ({ x: g.x, y: g.y - pump[i].y }));
    const datasets = [
        { label: 'Gross ORC output', data: gross, borderColor: color('--reference'), backgroundColor: color('--reference'), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0.4 },
        { label: 'Pumping', data: pump, borderColor: color('--series-2'), backgroundColor: color('--series-2'), borderWidth: 2, pointRadius: 0, tension: 0.4 },
        { label: 'Net', data: net, borderColor: color('--series-1'), backgroundColor: color('--series-1'), borderWidth: 2.5, pointRadius: 0, tension: 0.4 },
    ];
    if (powerChart) {
        powerChart.data.datasets = datasets;
        powerChart.update('none');
        return;
    }
    powerChart = new Chart($('chart_power'), {
        type: 'line',
        data: { datasets },
        options: {
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { type: 'linear', min: 0, max: 20, title: { display: true, text: 'Years of operation' }, ticks: { stepSize: 5 } },
                y: { title: { display: true, text: 'kW_e' }, grid: { color: (c) => (c.tick.value === 0 ? color('--text-3') : color('--border')) } },
            },
            plugins: {
                legend: { labels: { boxWidth: 12, boxHeight: 2 } },
                tooltip: {
                    callbacks: {
                        title: (items) => `Year ${fmt(items[0].parsed.x, 2)}`,
                        label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y, 1)} kW_e`,
                        afterBody: (items) => {
                            const i = items[0].dataIndex;
                            return `Heat extracted: ${fmt(state.prediction.heat_rate_kW.reduce((s, w) => s + w[i], 0), 0)} kW_th`;
                        },
                    },
                },
            },
        },
    });
}

// One bar chart per variable of the LCOE (I_t, M_t, F_t in $, E_t in MWh): different units, so no
// shared axis.
const LCOE_CHARTS = [
    { key: 'I', canvas: 'chart_I', unit: '$', color: '--series-1' },
    { key: 'M', canvas: 'chart_M', unit: '$', color: '--series-1' },
    { key: 'F', canvas: 'chart_F', unit: '$', color: '--series-1' },
    { key: 'E', canvas: 'chart_energy', unit: 'MWh', color: '--series-1' },
];
const lcoeCharts = {};

function money(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return `${fmt(v / 1e6, a >= 1e7 ? 0 : 1)} M`;
    if (a >= 1e3) return `${fmt(v / 1e3, 0)} k`;
    return fmt(v, 0);
}

function renderLcoeCharts(res, alpha) {
    state.alpha = alpha;
    const labels = res.rows.map((r) => r.t);
    for (const c of LCOE_CHARTS) {
        const data = res.rows.map((r) => r[c.key]);
        const chart = lcoeCharts[c.key];
        if (chart) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = data;
            chart.update('none');
            continue;
        }
        const isE = c.key === 'E';
        lcoeCharts[c.key] = new Chart($(c.canvas), {
            type: 'bar',
            data: { labels, datasets: [{ label: `${c.key}_t`, data, backgroundColor: color(c.color), hoverBackgroundColor: color('--text-1'), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', categoryPercentage: 0.85, barPercentage: 0.9 }] },
            options: {
                maintainAspectRatio: false,
                animation: false,
                scales: {
                    x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 6 }, title: { display: true, text: 't (year)' } },
                    // Same axis width in every chart, so the four plot areas line up.
                    y: { beginAtZero: true, suggestedMax: isE ? 1 : 1000, afterFit: (scale) => { scale.width = 64; }, ticks: { callback: (v) => (isE ? fmt(v, 0) : money(v)) }, title: { display: true, text: c.unit } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => `t = ${items[0].label}`,
                            label: (item) => (isE
                                ? (+item.label < state.alpha ? 'E_t: 0 (t < α, before production)' : `E_t: ${fmt(item.parsed.y, 1)} MWh`)
                                : `${c.key}_t: $${fmt(item.parsed.y, 0)}`),
                        },
                    },
                },
            },
        });
    }
}

// ---------- layout view ----------

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p;
    return 10 * p;
}

// ---------- field view ----------

// Temperature: one hue, light (coldest) to dark (hottest). Change: diverging, dark blue (largest
// cooling) through the page colour (no change) to dark orange (largest warming), on a symmetric scale.
const RAMPS = {
    T: [[0, '#fbf1e8'], [0.35, '#f2b48c'], [0.7, '#c94b1a'], [1, '#5c1d06']],
    dT: [[0, '#0d366b'], [0.18, '#2a78d6'], [0.35, '#9ec5f4'], [0.5, '#f7f6f3'], [0.65, '#f2b48c'], [0.82, '#c94b1a'], [1, '#5c1d06']],
};
const rampRGB = Object.fromEntries(Object.entries(RAMPS).map(([k, ramp]) =>
    [k, ramp.map(([s, hex]) => [s, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))])]));
function rampColor(stops, f) {
    f = Math.min(1, Math.max(0, f));
    for (let k = 1; k < stops.length; k++) {
        const [s1, c1] = stops[k];
        if (f <= s1) {
            const [s0, c0] = stops[k - 1];
            const u = (f - s0) / (s1 - s0);
            return c0.map((c, j) => c + (c1[j] - c) * u);
        }
    }
    return stops[stops.length - 1][1];
}

const fieldMode = () => $('field_mode').value;

/** Undisturbed rock temperature (°C) at depth z (m) of the case used: surface temperature plus gradient. */
function undisturbedC(z) {
    const { T_surface_C, gradient_K_m } = state.prediction.used.params;
    return T_surface_C + gradient_K_m * z;
}

/** Lowest and highest rock temperature (°C) over every year and view of the field. */
function temperatureRange(f) {
    let lo = Infinity, hi = -Infinity;
    const scan = (dT, zOf) => dT.forEach((v, i) => { const T = v + undisturbedC(zOf(i)); if (T < lo) lo = T; if (T > hi) hi = T; });
    f.years.forEach((_, iy) => {
        f.plan_depths_m.forEach((z, id) => scan(f.plan(iy, id), () => z));
        scan(f.section(iy), (i) => f.z_m[i % f.nz]);
    });
    return { lo, hi };
}

/** Colour scale of the current mode: rgb of a value, the colour-bar labels and the explanation. */
function fieldScale(f) {
    if (fieldMode() === 'T') {
        const { lo, hi } = f.Trange ??= temperatureRange(f);
        return {
            color: (T) => rampColor(rampRGB.T, (T - lo) / (hi - lo)),
            min: `${fmt(lo, 1)} °C`, max: `${fmt(hi, 1)} °C`, ramp: RAMPS.T,
            sub: 'Rock temperature: the undisturbed temperature (surface temperature plus gradient × depth) plus the change caused by the wells.',
        };
    }
    const L = Math.max(f.maxCooling_K, f.maxWarming_K);
    return {
        color: (dT) => rampColor(rampRGB.dT, 0.5 + dT / (2 * L)),
        min: `−${fmt(L, 1)} K`, max: `+${fmt(L, 1)} K`, ramp: RAMPS.dT,
        sub: `Change from the undisturbed temperature: blue is cooler, orange warmer (near the top, where the inlet water is`
            + ` warmer than the rock). Largest cooling ${fmt(f.maxCooling_K, 1)} K, largest warming ${fmt(f.maxWarming_K, 1)} K.`,
    };
}

let fieldToken = 0;
async function loadField(pr) {
    const token = ++fieldToken;
    $('field_readout').textContent = 'Loading the rock temperature field…';
    const field = await pr.loadField();
    if (token !== fieldToken) return;
    state.field = field;
    if (!field) {
        $('field_readout').textContent = 'No temperature field for this prediction.';
        return;
    }
    const ys = $('field_year'), ds = $('field_depth');
    if (!ys.options.length) {
        ys.innerHTML = field.years.map((y, i) => `<option value="${i}">${y}</option>`).join('');
        ds.innerHTML = field.plan_depths_m.map((d, i) => `<option value="${i}">${fmt(d, 0)} m</option>`).join('');
        ys.value = String(field.years.length - 1);
        ds.value = String(field.plan_depths_m.length - 2);
    }
    $('field_readout').textContent = 'Hover a view for the local rock temperature, or a well for its outlet temperature.';
    renderField();
}

function paint(canvas, nCols, nRows, valueAt, color, overlay) {
    const dpr = window.devicePixelRatio || 1;
    const W = 300 * dpr;
    canvas.width = W;
    canvas.height = W;
    const img = new ImageData(nCols, nRows);
    for (let r = 0; r < nRows; r++)
        for (let c = 0; c < nCols; c++) {
            const [R, G, B] = color(valueAt(c, r));
            const o = (r * nCols + c) * 4;
            img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
        }
    const off = document.createElement('canvas');
    off.width = nCols;
    off.height = nRows;
    off.getContext('2d').putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W, W);
    ctx.save();
    ctx.scale(W, W);
    overlay(ctx, 1 / W);
    ctx.restore();
}

function renderField() {
    const f = state.field, pr = state.prediction;
    if (!f || !pr) return;
    const iy = +$('field_year').value, id = +$('field_depth').value;
    const plan = f.plan(iy, id), sec = f.section(iy);
    const fx = (x) => (x - f.x0) / (f.x1 - f.x0), fy = (y) => 1 - (y - f.y0) / (f.y1 - f.y0);
    const wells = pr.used.wells_xy_m;
    const scale = fieldScale(f), abs = fieldMode() === 'T';
    // Wells sit in the most cooled rock: dark blue in the change view (white rings), orange in the
    // temperature view (dark filled dots with a light edge).
    const markColor = abs ? '#111111' : 'rgba(255,255,255,0.9)';
    const guideColor = 'rgba(17,17,17,0.45)';
    const planT0 = abs ? undisturbedC(f.plan_depths_m[id]) : 0;
    const secT0 = abs ? f.z_m.map(undisturbedC) : f.z_m.map(() => 0);
    $('field_sub').textContent = scale.sub;
    $('field_min').textContent = scale.min;
    $('field_max').textContent = scale.max;
    document.querySelector('.colorbar .ramp').style.background =
        `linear-gradient(to right, ${scale.ramp.map(([s, c]) => `${c} ${s * 100}%`).join(', ')})`;

    paint($('field_plan'), f.nx, f.ny, (c, r) => plan[c * f.ny + (f.ny - 1 - r)] + planT0, scale.color, (ctx, px) => {
        ctx.lineWidth = 1.2 * px;
        ctx.strokeStyle = abs ? 'rgba(255,255,255,0.85)' : markColor;
        ctx.fillStyle = markColor;
        for (const [x, y] of wells) {
            ctx.beginPath();
            ctx.arc(fx(x), fy(y), (abs ? 4 : 3.5) * px, 0, 2 * Math.PI);
            if (abs) ctx.fill();
            ctx.stroke();
        }
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = guideColor;
        ctx.beginPath();
        ctx.moveTo(0, fy(f.section_y_m));
        ctx.lineTo(1, fy(f.section_y_m));
        ctx.stroke();
    });
    const zMax = f.z_m[f.nz - 1];
    const halfCell = (f.y1 - f.y0) / (f.ny - 1) / 2;
    paint($('field_section'), f.nx, f.nz, (c, r) => sec[c * f.nz + r] + secT0[r], scale.color, (ctx, px) => {
        ctx.lineWidth = (abs ? 2 : 1.2) * px;
        ctx.strokeStyle = markColor;
        for (const [x, y] of wells) {
            if (Math.abs(y - f.section_y_m) > halfCell) continue;
            ctx.beginPath();
            ctx.moveTo(fx(x), 0);
            ctx.lineTo(fx(x), 1);
            ctx.stroke();
        }
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = guideColor;
        const yd = f.plan_depths_m[id] / zMax;
        ctx.beginPath();
        ctx.moveTo(0, yd);
        ctx.lineTo(1, yd);
        ctx.stroke();
    });
    const year = f.years[iy];
    $('field_plan_cap').textContent = `Plan at ${fmt(f.plan_depths_m[id], 0)} m depth after ${year} years; x and y in m`;
    $('field_section_cap').textContent = `Section at y = ${fmt(f.section_y_m, 0)} m (dashed in the plan); x and depth in m`;
    drawTicks($('field_plan_ticks'), [f.x0, f.x1], [f.y0, f.y1], false);
    drawTicks($('field_section_ticks'), [f.x0, f.x1], [0, zMax], true);
}

// Animation over the stored years of the field: one step every FIELD_STEP_MS, stopping at the last year.
const FIELD_STEP_MS = 900;
let fieldTimer = null;

function stopFieldPlay() {
    clearInterval(fieldTimer);
    fieldTimer = null;
    $('field_play').textContent = '▶ Play';
    $('field_play').setAttribute('aria-pressed', 'false');
}

function toggleFieldPlay() {
    if (fieldTimer) return stopFieldPlay();
    const ys = $('field_year'), last = ys.options.length - 1;
    if (last < 1) return;
    if (+ys.value >= last) ys.value = '0';
    renderField();
    $('field_play').textContent = '❚❚ Pause';
    $('field_play').setAttribute('aria-pressed', 'true');
    fieldTimer = setInterval(() => {
        ys.value = String(+ys.value + 1);
        renderField();
        if (+ys.value >= last) stopFieldPlay();
    }, FIELD_STEP_MS);
}

/**
 * Distance ticks around a field view: x below, y (or depth, downward when `down`) on the left, as
 * percentages of the view so they follow its size.
 */
function drawTicks(el, [x0, x1], [y0, y1], down) {
    const ticks = (a, b) => {
        const step = niceStep((b - a) / 4), out = [];
        for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(v);
        return out;
    };
    const pct = (v, a, b) => ((v - a) / (b - a)) * 100;
    el.innerHTML = ticks(x0, x1).map((v) => `<span class="tx" style="left:${pct(v, x0, x1)}%">${fmt(v, 0)}</span>`).join('')
        + ticks(y0, y1).map((v) => `<span class="ty" style="top:${down ? pct(v, y0, y1) : 100 - pct(v, y0, y1)}%">${fmt(v, 0)}</span>`).join('');
}

/** Rock temperature, its change and the undisturbed temperature at one point. */
function pointText(dT, z) {
    const T0 = undisturbedC(z);
    return `${fmt(T0 + dT, 2)} °C (undisturbed ${fmt(T0, 2)} °C, ΔT ${dT > 0 ? '+' : ''}${fmt(dT, 2)} K)`;
}

function fieldHover(e, kind) {
    const f = state.field;
    if (!f) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height;
    const ix = Math.min(f.nx - 1, Math.max(0, Math.round(u * (f.nx - 1))));
    const x = f.x0 + u * (f.x1 - f.x0);
    const iy = +$('field_year').value;
    const tip = $('tooltip');
    tip.hidden = true;
    if (kind === 'plan') {
        const pr = state.prediction;
        const wells = pr.used.wells_xy_m;
        const px = (w) => [((w[0] - f.x0) / (f.x1 - f.x0)) * rect.width, (1 - (w[1] - f.y0) / (f.y1 - f.y0)) * rect.height];
        const near = wells.findIndex((w) => { const [a, b] = px(w); return Math.hypot(a - (e.clientX - rect.left), b - (e.clientY - rect.top)) < 9; });
        if (near >= 0) {
            const n = pr.t_out_years.length;
            const avg = (row, a, b) => row.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
            tip.innerHTML = `<b>Well ${near + 1}</b> at (${fmt(wells[near][0], 0)}, ${fmt(wells[near][1], 0)}) m<br>
                Outlet, year 1: ${fmt(avg(pr.T_out_C[near], 0, 12), 2)} °C<br>
                Outlet, year 20: ${fmt(avg(pr.T_out_C[near], n - 12, n), 2)} °C<br>
                Heat, year 20: ${fmt(avg(pr.heat_rate_kW[near], n - 12, n), 0)} kW`;
            tip.hidden = false;
            tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
            tip.style.top = `${e.clientY + 14}px`;
        }
        const jy = Math.min(f.ny - 1, Math.max(0, Math.round((1 - v) * (f.ny - 1))));
        const y = f.y0 + (1 - v) * (f.y1 - f.y0);
        const z = f.plan_depths_m[+$('field_depth').value];
        const dT = f.plan(iy, +$('field_depth').value)[ix * f.ny + jy];
        $('field_readout').textContent = `x ${fmt(x, 0)} m, y ${fmt(y, 0)} m: ${pointText(dT, z)}`;
    } else {
        const iz = Math.min(f.nz - 1, Math.max(0, Math.round(v * (f.nz - 1))));
        const dT = f.section(iy)[ix * f.nz + iz];
        $('field_readout').textContent = `x ${fmt(x, 0)} m, depth ${fmt(f.z_m[iz], 0)} m: ${pointText(dT, f.z_m[iz])}`;
    }
}

// ---------- tooltip ----------


// ---------- references ----------

/**
 * Results, Method and References fold. A link to one of them, or a citation (#ref-…, in References),
 * opens it before the browser scrolls.
 */
function openReferencesOnCite() {
    const open = (hash) => {
        const id = hash.startsWith('#ref-') ? 'references' : hash.slice(1);
        if (['results_sec', 'method', 'references'].includes(id)) $(id).open = true;
    };
    document.addEventListener('click', (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (a) open(a.getAttribute('href'));
    });
    window.addEventListener('hashchange', () => open(location.hash));
    if (location.hash) {
        open(location.hash);
        try { document.querySelector(location.hash)?.scrollIntoView(); } catch { /* not an element id */ }
    }
}

// ---------- start ----------

/** Model inputs are shown, but set by the chosen case only; nearest-case matching is hidden. */
function lockPhysicalInputs() {
    for (const id of ['family', 'n_wells', 'spacing']) $(id).disabled = true;
    for (const el of $('param_inputs').querySelectorAll('input')) el.disabled = true;
    $('fold_matched').hidden = true;
    $('fold_matching').hidden = true;
    $('case_hint').textContent = 'The model inputs below are those of the selected case. They cannot be changed yet.'
        + ' Picking a case also resets I_t, M_t, η, n and the fixed E_t to that case\'s defaults.';
}

function syncLayoutInputs() {
    const fixed = !PHYSICAL_INPUTS_EDITABLE || ['single', 'case'].includes($('family').value);
    $('n_wells').disabled = fixed;
    $('spacing').disabled = fixed;
}

async function init() {
    openReferencesOnCite();
    chartDefaults();
    try {
        state.predictor = await LibraryPredictor.load('dbhe/data');
    } catch (err) {
        $('status').textContent = `${err.message}. Run tools/build_dbhe_assets.py to create public/dbhe/data.`;
        $('status').className = 'status error';
        return;
    }
    const lib = state.predictor;

    $('family').innerHTML = LAYOUT_FAMILIES.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')
        + '<option value="case" hidden>As in the selected case</option>';
    $('family').value = 'grid';
    $('case_pick').innerHTML = (PHYSICAL_INPUTS_EDITABLE ? '<option value="">Closest to the inputs below</option>' : '')
        + lib.cases.map((c) => `<option value="${c.case_id}">#${c.case_id} · ${c.layout} · ${c.setting}</option>`).join('');

    buildParamInputs(lib.ranges);
    $('lcoe_r').value = +(LCOE_DEFAULTS.r * 100).toFixed(2);
    $('lcoe_alpha').value = LCOE_DEFAULTS.alpha;
    $('lcoe_F').value = LCOE_DEFAULTS.F;
    for (const id of ['lcoe_I', 'lcoe_M', 'lcoe_F', 'lcoe_E', 'lcoe_r', 'lcoe_n', 'lcoe_alpha', 'eta']) $(id).addEventListener('input', onLcoeInput);
    $('pump_eff').value = LCOE_DEFAULTS.pump_efficiency * 100;
    $('pump_eps').value = LCOE_DEFAULTS.roughness_mm;
    for (const id of ['pump_on', 'pump_eff', 'pump_eps']) $(id).addEventListener('input', onPumpInput);
    for (const el of document.querySelectorAll('input[name=e_mode]')) el.addEventListener('change', onModeChange);
    $('reset_I').addEventListener('click', () => resetDefault('I'));
    $('lcoe_unit').addEventListener('change', updateEconomics);
    $('reset_eta').addEventListener('click', () => resetDefault('eta'));
    $('cost_rows').addEventListener('input', onCostInput);
    $('fold_open').addEventListener('click', () => { for (const d of document.querySelectorAll('details.fold')) d.open = true; });
    $('fold_close').addEventListener('click', () => { for (const d of document.querySelectorAll('details.fold')) d.open = false; });
    for (const b of document.querySelectorAll('button[data-fill]')) b.addEventListener('click', () => fillDown(b.dataset.fill));

    for (const id of ['family', 'n_wells', 'spacing', 'match_weight']) {
        $(id).addEventListener('input', () => { syncLayoutInputs(); onPhysicalInput(); });
    }
    $('case_pick').addEventListener('change', (e) => pickCase(e.target.value === '' ? null : +e.target.value));
    $('field_year').addEventListener('change', renderField);
    $('field_depth').addEventListener('change', renderField);
    $('field_mode').addEventListener('change', renderField);
    $('field_play').addEventListener('click', toggleFieldPlay);
    $('field_year').addEventListener('input', () => stopFieldPlay());
    $('field_plan').addEventListener('mousemove', (e) => fieldHover(e, 'plan'));
    $('field_section').addEventListener('mousemove', (e) => fieldHover(e, 'section'));
    $('field_plan').addEventListener('mouseleave', () => { $('tooltip').hidden = true; });
    syncLayoutInputs();
    if (!PHYSICAL_INPUTS_EDITABLE) lockPhysicalInputs();

    // Start from the library case with the lowest LCOE at the default LCOE inputs.
    // The cases with positive net output at the defaults are marked in the list.
    let best = null;
    state.positiveCases = [];
    for (const c of lib.cases) {
        const v = defaultLcoe(await lib.predict(readRequest(), { caseId: c.case_id }));
        if (v == null) continue;
        state.positiveCases.push(c.case_id);
        $('case_pick').querySelector(`option[value="${c.case_id}"]`).textContent += ' · net output > 0';
        if (best == null || v < best.v) best = { id: c.case_id, v };
    }
    pickCase(best ? best.id : lib.cases[0].case_id);
}

init();
