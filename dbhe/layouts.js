// Well layouts: generate well positions from a few layout parameters, and describe any layout by the
// features the case library is indexed by. The surrogate takes the positions directly.

export const LAYOUT_FAMILIES = [
    { id: 'single', label: 'Single well' },
    { id: 'line', label: 'Line' },
    { id: 'grid', label: 'Grid' },
    { id: 'staggered', label: 'Staggered (hexagonal)' },
    { id: 'ring', label: 'Ring' },
];

const round1 = (v) => Math.round(v * 10) / 10;

function centre(points) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return points.map(([x, y]) => [round1(x - cx), round1(y - cy)]);
}

/** Well positions (m, centred on 0, 0) for a layout family, number of wells and spacing. */
export function generateLayout(family, nWells, spacing) {
    const n = Math.max(1, Math.round(nWells));
    if (family === 'single' || n === 1) return [[0, 0]];
    const pts = [];
    if (family === 'line') {
        for (let i = 0; i < n; i++) pts.push([i * spacing, 0]);
    } else if (family === 'grid' || family === 'staggered') {
        const cols = Math.ceil(Math.sqrt(n));
        const dy = family === 'staggered' ? spacing * Math.sqrt(3) / 2 : spacing;
        for (let i = 0; i < n; i++) {
            const row = Math.floor(i / cols), col = i % cols;
            const shift = family === 'staggered' && row % 2 ? spacing / 2 : 0;
            pts.push([col * spacing + shift, row * dy]);
        }
    } else if (family === 'ring') {
        const r = spacing / (2 * Math.sin(Math.PI / n));
        for (let i = 0; i < n; i++) {
            const a = (2 * Math.PI * i) / n;
            pts.push([r * Math.cos(a), r * Math.sin(a)]);
        }
    } else {
        throw new Error(`unknown layout family: ${family}`);
    }
    return centre(pts);
}

/** Closest distance between two wells, m (null for one well). */
export function minSpacing(wells) {
    let best = Infinity;
    for (let i = 0; i < wells.length; i++)
        for (let j = i + 1; j < wells.length; j++)
            best = Math.min(best, Math.hypot(wells[i][0] - wells[j][0], wells[i][1] - wells[j][1]));
    return Number.isFinite(best) ? best : null;
}

/** Larger side of the box enclosing the wells, m. */
export function extent(wells) {
    const xs = wells.map((p) => p[0]), ys = wells.map((p) => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
