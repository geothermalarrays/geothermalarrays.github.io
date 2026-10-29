// Levelized cost of electricity, as defined in https://en.wikipedia.org/wiki/Levelized_cost_of_electricity:
//
//              Σ_{t=1..n} (I_t + M_t + F_t) / (1 + r)^t
//   LCOE  =  ─────────────────────────────────────────
//                   Σ_{t=α..n} E_t / (1 + r)^t
//
//   I_t  investment expenditures in the time interval t
//   M_t  operations and maintenance expenditures in the time interval t
//   F_t  fuel expenditures in the time interval t
//   E_t  electrical energy generated in the time interval t: a fixed value, or from the physical model
//   r    discount rate
//   n    expected lifetime of the system in number of time intervals t
//   α    interval in which energy production begins
//
// The time interval is one year. No DOM code: usable from the page, from tests or Node.

const HOURS_PER_YEAR = 365 * 24; // the library uses 365-day years

/**
 * Default values of the inputs, from the literature (the references are listed at the end of
 * calculator.html). White et al. (2023) is the closed-loop geothermal study of the US DOE working group.
 */
export const LCOE_DEFAULTS = {
    // r = 7 %: White et al. (2023); also the central rate of IEA/NEA, Projected Costs of Generating Electricity.
    r: 0.07,
    // α = 2: one year of drilling and construction before the first year of production (assumption).
    alpha: 2,
    // F_t = 0: a geothermal plant burns no fuel.
    F: 0,
    // I_t: drilling at $1,000 per metre of borehole (White et al. 2023, from Utah FORGE drilling rates; the
    // Lukawski et al. 2014 correlation gives about 2.5 times more for a 3 km geothermal well), plus the
    // power plant at $3,000 per kW_e (White et al. 2023).
    drill_usd_per_m: 1000,
    plant_usd_per_kWe: 3000,
    // M_t = 1.5 % of the surface-plant investment per year, no wellfield maintenance (Beckers et al. 2023,
    // sec. 4.2, the methods paper of White et al. 2023). The authors note this is much lower than typical
    // geothermal O&M; 1.5 % of the whole investment is a pessimistic alternative.
    om_share: 0.015,
    // 30 years of production when E_t is a fixed value (plant lifetime of NREL ATB): n = α − 1 + 30.
    n_fixed: 30,
    // Pumping: commercial steel roughness 0.045 mm (standard value of the Moody chart); pump efficiency
    // 75 % (assumption, typical of centrifugal pumps).
    roughness_mm: 0.045,
    pump_efficiency: 0.75,
    // Fixed E_t (MWh per year) used when the user does not take E_t from the model and the model gives
    // no positive net electricity. The plant is then sized for the constant power E_t / 8760 h.
    E_fixed_MWh: 1000,
    // Heat-sink temperature of the thermodynamic limit (sensitivity only): 15 °C, an assumed mean ambient.
    T_sink_C: 15,
};

/**
 * Thermal efficiency of a binary (ORC) plant as a function of the geofluid inlet temperature T (°C),
 * η = (0.0935 T − 2.3266) %: the fit of Tester et al. (2006, The Future of Geothermal Energy, MIT) to ten
 * binary plants with geofluid at 103–166 °C, as given by Mishra et al. (2010). Below 103 °C it is an
 * extrapolation. Clamped at 0.
 */
export function orcEfficiency(T_C) {
    return Math.max(0, (0.0935 * T_C - 2.3266) / 100);
}

/**
 * Thermodynamic limit of the conversion, as a fraction of the heat ṁ c_p (T_hot − T_in) extracted by the
 * wells: the most work any cycle rejecting heat at T_sink can get from water cooled from T_hot to
 * T_c = max(T_in, T_sink), W = ṁ c_p [(T_hot − T_c) − T_sink ln(T_hot / T_c)] in kelvin (the
 * exergy decrease of water at constant c_p, from ∫ ṁ c_p (1 − T_sink/T) dT). Zero when T_hot ≤ T_c: heat below
 * T_sink gives no work, so for T_in < T_sink it does not count.
 * A sensitivity bound, not a plant model: real binary plants reach only a fraction of it.
 */
export function idealWorkFraction(T_hot_C, T_in_C, T_sink_C = LCOE_DEFAULTS.T_sink_C) {
    const T0 = T_sink_C + 273.15, Th = T_hot_C + 273.15, Tc = Math.max(T_in_C + 273.15, T0);
    if (Th - Tc < 1e-6) return 0;
    return ((Th - Tc) - T0 * Math.log(Th / Tc)) / (Th - (T_in_C + 273.15));
}

/**
 * Mean η of a prediction, for display: the efficiency fit applied month by month to the temperature of
 * the water reaching the plant (the mixed outlet of all wells, which all run at the same flow rate),
 * weighted by the heat of that month. The electricity itself is computed month by month (grossPowerKW),
 * because a single η keeps the undiscounted total but not the discounted one.
 */
export function effectiveOrcEfficiency(prediction) {
    const q = totalHeatKW(prediction), p = grossPowerKW(prediction);
    const Q = q.reduce((a, b) => a + b, 0);
    return Q > 0 ? p.reduce((a, b) => a + b, 0) / Q : 0;
}

/** Heat rate of all wells at every outlet sample, kW_th. */
function totalHeatKW(prediction) {
    return prediction.t_out_years.map((_, i) => prediction.heat_rate_kW.reduce((s, w) => s + w[i], 0));
}

/**
 * Gross ORC output at every outlet sample, kW_e: a constant η when one is given, else the efficiency fit
 * evaluated on the mixed outlet temperature of that sample, or, with eta = 'ideal', the thermodynamic
 * limit between that temperature and the inlet temperature.
 */
export function grossPowerKW(prediction, eta = null) {
    const T = prediction.T_out_C, Tin = prediction.used.params.T_inlet_C;
    return totalHeatKW(prediction).map((Q, i) => {
        if (typeof eta === 'number') return eta * Q;
        const Tmix = T.reduce((s, w) => s + w[i], 0) / T.length;
        return (eta === 'ideal' ? idealWorkFraction(Tmix, Tin) : orcEfficiency(Tmix)) * Q;
    });
}

/** Sums a quantity sampled at the outlet times (kW) over every year of operation, MWh. */
function byYear(prediction, kW) {
    const t = prediction.t_out_years;
    const nYears = Math.round(t[t.length - 1]);
    const perYear = t.length / nYears;
    const hoursPerSample = HOURS_PER_YEAR / perYear;
    return Array.from({ length: nYears }, (_, y) => {
        let kWh = 0;
        for (let i = y * perYear; i < (y + 1) * perYear; i++) kWh += kW[i] * hoursPerSample;
        return kWh / 1e3;
    });
}

/**
 * Heat extracted in every year of operation, MWh_th: Σ_wells Σ_samples heat_rate × Δt, with
 * heat_rate = ṁ c_p (T_out − T_in) from the model. Index k − 1 is the k-th year of operation.
 */
export function heatByYear(prediction) {
    return byYear(prediction, totalHeatKW(prediction));
}

/** Gross ORC electricity of every year of operation, MWh_e (see grossPowerKW). */
export function grossElectricityByYear(prediction, eta = null) {
    return byYear(prediction, grossPowerKW(prediction, eta));
}

/**
 * E_t of the physical model, MWh_e, indexed by t − 1: the gross ORC electricity of the k-th year of
 * operation, k = t − α + 1, minus the electricity of the circulation pumps. Negative when the pumps use
 * more than the ORC makes. Zero before α and after the simulated years.
 */
export function electricityByYear(grossMWh, alpha, n, pumpMWh = null) {
    return Array.from({ length: n }, (_, i) => {
        const k = i + 1 - alpha;
        if (k < 0 || k >= grossMWh.length) return 0;
        return grossMWh[k] - (pumpMWh ? pumpMWh[k] : 0);
    });
}

/** LCOE and its terms. I, M, F and E are arrays indexed by t − 1; costs in $, energy in MWh. */
export function lcoe({ I, M, F, E, r, n, alpha }) {
    const rows = [];
    let costSum = 0, energySum = 0;
    for (let t = 1; t <= n; t++) {
        const df = (1 + r) ** -t;
        const cost = (I[t - 1] + M[t - 1] + F[t - 1]) * df;
        const energy = t >= alpha ? E[t - 1] * df : 0;
        costSum += cost;
        energySum += energy;
        rows.push({ t, I: I[t - 1], M: M[t - 1], F: F[t - 1], E: t >= alpha ? E[t - 1] : 0, df, cost, energy });
    }
    return { rows, costSum, energySum, lcoe: energySum > 0 ? costSum / energySum : null };
}
