// Predictors of the DBHE array response. Every predictor takes the same request and returns the same
// prediction, so the page does not change when the case library is replaced by the surrogate.
//
// Request (the inputs of GeothermalWells.jl that the library varies; MODEL_INPUTS lists them all and
// toGeothermalWellsInputs writes a request as the full set of model arguments):
//   {
//     wells_xy_m: [[x, y], ...],               well positions, m
//     family:     'grid' | ...,                 layout family; used only to search the library
//     params: { mdot_kg_s, T_inlet_C, k_rock_W_mK, rho_c_rock_J_m3K, gradient_K_m, T_surface_C },
//   }
//
// Prediction (the outputs of GeothermalWells.jl: outlet temperature of every borehole over time, and
// the rock temperature field):
//   {
//     source:       { kind: 'library' | 'surrogate', label, ... },
//     request,                                  what was asked for
//     used:         { wells_xy_m, params, layout },  what the outputs belong to
//     wellDepth:    m,                          depth of every borehole
//     t_out_years:  [n_t],                      end of each month, years
//     T_out_C:      [n_wells][n_t],             outlet temperature of each well, °C
//     heat_rate_kW: [n_wells][n_t],             mdot cp (T_out - T_inlet), kW
//     loadField():  Promise<Field | null>       rock temperature change, see FieldSlices
//   }

import { extent, minSpacing } from './layouts.js';

export const CP_WATER = 4187.5; // J/(kg K), as in the case library

// The inputs the case library varies, with the GeothermalWells.jl argument each one sets.
export const PARAMS = [
    { key: 'mdot_kg_s', julia: 'ṁ', label: 'Flow rate per well', unit: 'kg/s', scale: 1, step: 0.1, digits: 1 },
    { key: 'T_inlet_C', julia: 'ConstantInlet', label: 'Inlet temperature', unit: '°C', scale: 1, step: 0.1, digits: 1 },
    { key: 'k_rock_W_mK', julia: 'k_rock', label: 'Rock thermal conductivity', unit: 'W/(m·K)', scale: 1, step: 0.01, digits: 2 },
    { key: 'rho_c_rock_J_m3K', julia: 'rho_c_rock', label: 'Rock volumetric heat capacity', unit: 'MJ/(m³·K)', scale: 1e-6, step: 0.01, digits: 2 },
    { key: 'gradient_K_m', julia: 'gradient', label: 'Geothermal gradient', unit: 'K/km', scale: 1e3, step: 0.1, digits: 1 },
    { key: 'T_surface_C', julia: 'T_surface', label: 'Ground surface temperature', unit: '°C', scale: 1, step: 0.1, digits: 1 },
];

// Every input of a GeothermalWells.jl simulation (examples/well_array_basic.jl) and how the case
// library covers it: `param` is varied (request.params), `value` is fixed by the library (SI units),
// `value: null` is fixed but not stated in the library's README.
export const MODEL_INPUTS = [
    { group: 'Borehole', name: 'xc, yc', unit: 'm', layout: true, note: 'well positions' },
    { group: 'Borehole', name: 'h', unit: 'm', value: 3000, note: 'borehole depth' },
    { group: 'Borehole', name: 'r_inner', unit: 'm', value: 0.0506, note: 'inner pipe radius' },
    { group: 'Borehole', name: 't_inner', unit: 'm', value: 0.0114, note: 'inner pipe wall thickness' },
    { group: 'Borehole', name: 'r_outer', unit: 'm', value: 0.0809, note: 'outer pipe radius' },
    { group: 'Borehole', name: 't_outer', unit: 'm', value: 0.00833, note: 'outer pipe wall thickness' },
    { group: 'Borehole', name: 'r_backfill', unit: 'm', value: 0.108, note: 'borehole radius' },
    { group: 'Borehole', name: 'ṁ', unit: 'kg/s', param: 'mdot_kg_s', note: 'mass flow rate, same for all wells' },
    { group: 'Borehole', name: 'insulation_depth', unit: 'm', value: 1000, note: 'inner pipe insulated to this depth' },
    { group: 'HomogenousMaterialProperties', name: 'k_rock', unit: 'W/(m·K)', param: 'k_rock_W_mK' },
    { group: 'HomogenousMaterialProperties', name: 'rho_c_rock', unit: 'J/(m³·K)', param: 'rho_c_rock_J_m3K' },
    { group: 'HomogenousMaterialProperties', name: 'k_water', unit: 'W/(m·K)', value: null },
    { group: 'HomogenousMaterialProperties', name: 'rho_c_water', unit: 'J/(m³·K)', value: null },
    { group: 'HomogenousMaterialProperties', name: 'k_steel', unit: 'W/(m·K)', value: null },
    { group: 'HomogenousMaterialProperties', name: 'rho_c_steel', unit: 'J/(m³·K)', value: null },
    { group: 'HomogenousMaterialProperties', name: 'k_insulating', unit: 'W/(m·K)', value: 0.04 },
    { group: 'HomogenousMaterialProperties', name: 'rho_c_insulating', unit: 'J/(m³·K)', value: null },
    { group: 'HomogenousMaterialProperties', name: 'k_backfill', unit: 'W/(m·K)', value: 1.5, note: 'grout' },
    { group: 'HomogenousMaterialProperties', name: 'rho_c_backfill', unit: 'J/(m³·K)', value: null },
    { group: 'initial_condition_thermal_gradient', name: 'T_surface', unit: '°C', param: 'T_surface_C' },
    { group: 'initial_condition_thermal_gradient', name: 'gradient', unit: 'K/m', param: 'gradient_K_m' },
    { group: 'inlet_model', name: 'ConstantInlet(T_inlet)', unit: '°C', param: 'T_inlet_C', note: 'HeatExchangerInlet(ΔT) is not in the library' },
    { group: 'time', name: 'tspan', unit: 'years', value: 20, note: 'outlet saved monthly, field yearly' },
];

/**
 * The request written as the arguments of a GeothermalWells.jl simulation; inputs the library fixes
 * but does not state are null. This is the input the surrogate (or a server running the model) gets.
 */
export function toGeothermalWellsInputs(request) {
    const fixed = Object.fromEntries(MODEL_INPUTS.filter((d) => 'value' in d).map((d) => [d.name, d.value]));
    const p = request.params;
    return {
        boreholes: request.wells_xy_m.map(([xc, yc]) => ({
            xc, yc, h: fixed.h, r_inner: fixed.r_inner, t_inner: fixed.t_inner, r_outer: fixed.r_outer,
            t_outer: fixed.t_outer, r_backfill: fixed.r_backfill, mdot: p.mdot_kg_s, insulation_depth: fixed.insulation_depth,
        })),
        materials: {
            k_rock: p.k_rock_W_mK, rho_c_rock: p.rho_c_rock_J_m3K,
            k_water: fixed.k_water, rho_c_water: fixed.rho_c_water, k_steel: fixed.k_steel, rho_c_steel: fixed.rho_c_steel,
            k_insulating: fixed.k_insulating, rho_c_insulating: fixed.rho_c_insulating,
            k_backfill: fixed.k_backfill, rho_c_backfill: fixed.rho_c_backfill,
        },
        initial_condition: { T_surface: p.T_surface_C, gradient: p.gradient_K_m },
        inlet_model: { type: 'ConstantInlet', T_inlet: p.T_inlet_C },
        tspan_years: fixed.tspan,
    };
}

/** Heat extracted by each well from its outlet temperature, kW (excludes pumping power). */
export function heatRateFromOutlet(T_out_C, params) {
    const k = (params.mdot_kg_s * CP_WATER) / 1e3;
    return T_out_C.map((row) => row.map((T) => k * (T - params.T_inlet_C)));
}

/** Rock temperature change of one case on plan slices and a vertical section (see build_dbhe_assets.py). */
export class FieldSlices {
    constructor(layout, grid, buffer) {
        Object.assign(this, layout, grid);
        this.data = new Int16Array(buffer);
        this.planSize = this.nx * this.ny;
        this.sectionSize = this.nx * this.nz;
        this.sectionOffset = this.years.length * this.plan_depths_m.length * this.planSize;
        let min = 0, max = 0;
        for (const v of this.data) if (v < min) min = v; else if (v > max) max = v;
        this.maxCooling_K = -min / 100;
        this.maxWarming_K = max / 100; // near the top, where the inlet water is warmer than the rock
    }
    /** Temperature change, K, indexed [ix * ny + iy]. */
    plan(iYear, iDepth) {
        const start = (iYear * this.plan_depths_m.length + iDepth) * this.planSize;
        return Float32Array.from(this.data.subarray(start, start + this.planSize), (v) => v / 100);
    }
    /** Temperature change, K, along x at y = section_y_m, indexed [ix * nz + iz]. */
    section(iYear) {
        const start = this.sectionOffset + iYear * this.sectionSize;
        return Float32Array.from(this.data.subarray(start, start + this.sectionSize), (v) => v / 100);
    }
}

/**
 * Answers a request with the closest of the precomputed library cases. The outputs are exactly those
 * of the case, which is reported in `source` and `used`; nothing is interpolated.
 */
export class LibraryPredictor {
    static async load(baseUrl) {
        const res = await fetch(`${baseUrl}/library.json`);
        if (!res.ok) throw new Error(`could not load the case library (${res.status})`);
        return new LibraryPredictor(baseUrl, await res.json());
    }

    constructor(baseUrl, library) {
        this.baseUrl = baseUrl;
        this.library = library;
        this.cases = library.cases;
        this.ranges = {};
        for (const { key } of PARAMS) {
            const v = this.cases.map((c) => c.params[key]);
            this.ranges[key] = { min: Math.min(...v), max: Math.max(...v) };
        }
        const n = this.cases.map((c) => c.n_wells);
        const s = this.cases.map((c) => c.min_spacing_m).filter((v) => v != null);
        this.ranges.n_wells = { min: Math.min(...n), max: Math.max(...n) };
        this.ranges.min_spacing_m = { min: Math.min(...s), max: Math.max(...s) };
    }

    /**
     * Distance of a request to every case, nearest first. Cases with the requested number of wells
     * come first (or, if the library has none, with the closest number), because the cost and the
     * heat both scale with it. Within that, each input is scaled by its range in the library, well
     * count and spacing on a log scale; layoutWeight > 1 favours the layout over the rock and
     * operating parameters.
     */
    rank(request, layoutWeight = 1) {
        const wells = request.wells_xy_m;
        const n = wells.length, s = minSpacing(wells);
        const logSpan = (r) => Math.log(r.max / r.min);
        const countGap = (c) => Math.abs(Math.log(n / c.n_wells));
        const closestGap = Math.min(...this.cases.map(countGap));
        return this.cases
            .map((c) => {
                let dp = 0;
                for (const { key } of PARAMS) {
                    const r = this.ranges[key];
                    dp += ((request.params[key] - c.params[key]) / (r.max - r.min)) ** 2;
                }
                let dl = (Math.log(n / c.n_wells) / logSpan(this.ranges.n_wells)) ** 2;
                if (s != null && c.min_spacing_m != null)
                    dl += (Math.log(s / c.min_spacing_m) / logSpan(this.ranges.min_spacing_m)) ** 2;
                if (request.family && request.family !== c.family) dl += 0.25;
                return {
                    case: c,
                    distance: Math.sqrt(dp + layoutWeight ** 2 * dl),
                    paramDistance: Math.sqrt(dp),
                    countMatch: countGap(c) <= closestGap + 1e-12,
                };
            })
            .sort((a, b) => b.countMatch - a.countMatch || a.distance - b.distance);
    }

    /** Prediction for the nearest case, or for a given case when caseId is set. */
    async predict(request, { caseId = null, layoutWeight = 1 } = {}) {
        const ranked = this.rank(request, layoutWeight);
        const hit = caseId == null ? ranked[0] : ranked.find((r) => r.case.case_id === caseId);
        if (!hit) throw new Error(`no library case ${caseId}`);
        const c = hit.case;
        let fieldPromise = null;
        return {
            source: {
                kind: 'library',
                label: `Library case ${c.case_id} · ${c.layout}`,
                case_id: c.case_id,
                distance: hit.distance,
                setting: c.setting,
                alternatives: ranked.slice(0, 6).map((r) => ({ case_id: r.case.case_id, layout: r.case.layout, distance: r.distance })),
            },
            request,
            used: {
                wells_xy_m: c.wells_xy_m,
                params: c.params,
                layout: { family: c.family, label: c.layout, n_wells: c.n_wells, min_spacing_m: c.min_spacing_m, extent_m: extent(c.wells_xy_m) },
                T_bottom_C: c.T_bottom_C,
            },
            wellDepth: this.library.well_depth_m,
            t_out_years: this.library.t_out_years,
            T_out_C: c.T_out_C,
            heat_rate_kW: heatRateFromOutlet(c.T_out_C, c.params),
            loadField: () => (fieldPromise ??= this.#loadField(c)),
        };
    }

    async #loadField(c) {
        const id = String(c.case_id).padStart(3, '0');
        const res = await fetch(`${this.baseUrl}/fields/case_${id}.bin`);
        if (!res.ok) return null;
        return new FieldSlices(this.library.field, c.grid, await res.arrayBuffer());
    }
}

/**
 * Placeholder for the neural-network surrogate (PyTorch, exported to ONNX and run in the browser with
 * onnxruntime-web). It must return the same prediction as LibraryPredictor.predict: build the input
 * tensors from request.wells_xy_m and request.params, run the model, and fill T_out_C (and a field
 * loader, if the model's field output is wanted). See README.md.
 */
export class SurrogatePredictor {
    constructor(modelUrl) {
        this.modelUrl = modelUrl;
    }
    async predict(request) {
        throw new Error('The surrogate model is not available yet; use LibraryPredictor.');
        // const T_out_C = ...run the model...;
        // return {
        //     source: { kind: 'surrogate', label: 'Surrogate model' },
        //     request, used: { wells_xy_m: request.wells_xy_m, params: request.params, layout: ... },
        //     t_out_years, T_out_C, heat_rate_kW: heatRateFromOutlet(T_out_C, request.params),
        //     loadField: async () => null,
        // };
    }
}
