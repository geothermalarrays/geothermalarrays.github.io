// Circulation pumping power of the coaxial wells: friction losses in the inner pipe and the annulus,
// from the well design of the physical model (MODEL_INPUTS) and the model's outlet temperatures.
// Neglected: the thermosiphon (warm water rising in the inner pipe lowers the pressure the pump must
// supply) and the surface piping and minor losses (which raise it). They act in opposite directions, so
// the estimate is not a bound in either direction.
//
// No DOM code: usable from the page, from tests or Node.

import { MODEL_INPUTS } from './predictor.js';

const HOURS_PER_YEAR = 365 * 24;

/** Density of water, kg/m³, at T (°C): Tanaka et al. (2001), fitted at 0–40 °C. */
export function waterDensity(T) {
    const a1 = -3.983035, a2 = 301.797, a3 = 522528.9, a4 = 69.34881, a5 = 999.974950;
    return a5 * (1 - ((T + a1) ** 2 * (T + a2)) / (a3 * (T + a4)));
}

/** Dynamic viscosity of water, Pa·s, at T (°C): Vogel equation. */
export function waterViscosity(T) {
    return 2.414e-5 * 10 ** (247.8 / (T + 273.15 - 140));
}

/**
 * Darcy friction factor: laminar 64/Re, turbulent from Haaland (1983). 64/Re is exact for a round pipe
 * only (an annulus needs a geometry factor); the library flows are turbulent in both paths (Re > 10⁴),
 * so the laminar branch is not used.
 */
export function frictionFactor(Re, roughness, D) {
    if (Re < 2300) return 64 / Re;
    return (-1.8 * Math.log10((roughness / D / 3.7) ** 1.11 + 6.9 / Re)) ** -2;
}

/** Flow paths of one well: inner pipe and annulus, each as long as the well (m). */
export function wellGeometry() {
    const v = Object.fromEntries(MODEL_INPUTS.filter((d) => 'value' in d).map((d) => [d.name, d.value]));
    const rInnerOut = v.r_inner + v.t_inner; // outer surface of the inner pipe
    return {
        length: v.h,
        paths: [
            { name: 'inner pipe', area: Math.PI * v.r_inner ** 2, D: 2 * v.r_inner },
            // r_outer is taken as the inner radius of the outer pipe, as in GeothermalWells.jl.
            { name: 'annulus', area: Math.PI * (v.r_outer ** 2 - rInnerOut ** 2), D: 2 * (v.r_outer - rInnerOut) },
        ],
    };
}

/** Friction pressure drop of one well, Pa, at flow mdot (kg/s) and water temperature T (°C). */
export function pressureDrop(mdot, T, roughness, geometry = wellGeometry()) {
    const rho = waterDensity(T), mu = waterViscosity(T);
    let dp = 0;
    for (const p of geometry.paths) {
        const v = mdot / (rho * p.area);
        const Re = (rho * v * p.D) / mu;
        dp += frictionFactor(Re, roughness, p.D) * (geometry.length / p.D) * (rho * v * v) / 2;
    }
    return dp;
}

/**
 * Electric power of the circulation pumps of all wells at every outlet sample, kW: ṁ Δp / (ρ η_pump),
 * with the water properties at the mean of the inlet and outlet temperature of each well.
 */
export function pumpPowerKW(prediction, roughness, pumpEfficiency) {
    const { mdot_kg_s: mdot, T_inlet_C: Tin } = prediction.used.params;
    const geometry = wellGeometry();
    return prediction.t_out_years.map((_, i) => {
        let kW = 0;
        for (const w of prediction.T_out_C) {
            const T = (Tin + w[i]) / 2;
            kW += (mdot * pressureDrop(mdot, T, roughness, geometry)) / (waterDensity(T) * pumpEfficiency) / 1e3;
        }
        return kW;
    });
}

/** Pumping energy of every year of operation, MWh (index k − 1 is the k-th year). */
export function pumpEnergyByYear(prediction, roughness, pumpEfficiency) {
    const p = pumpPowerKW(prediction, roughness, pumpEfficiency);
    const perYear = p.length / Math.round(prediction.t_out_years[p.length - 1]);
    const years = [];
    for (let a = 0; a < p.length; a += perYear) {
        let kWh = 0;
        for (let i = a; i < a + perYear; i++) kWh += (p[i] * HOURS_PER_YEAR) / perYear;
        years.push(kWh / 1e3);
    }
    return years;
}
