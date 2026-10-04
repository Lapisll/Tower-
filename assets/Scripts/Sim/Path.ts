import type { Pt } from './SimTypes';

/**
 * Ломаная, по которой идут враги. Хранит кумулятивные длины,
 * чтобы позиция врага была одним числом (пройденной дистанцией) —
 * так бой детерминирован и одинаково считается в игре и в балансном прогоне.
 */
export class PathLine {
    readonly points: Pt[];
    /** cum[i] — длина пути до points[i] */
    readonly cum: number[] = [];
    readonly total: number;

    constructor(points: Pt[]) {
        this.points = points;
        let acc = 0;
        this.cum.push(0);
        for (let i = 1; i < points.length; i++) {
            acc += dist(points[i - 1], points[i]);
            this.cum.push(acc);
        }
        this.total = acc;
    }

    /** Точка на пути по пройденной дистанции (клампится к концам). */
    posAt(d: number, out?: Pt): Pt {
        const r = out ?? { x: 0, z: 0 };
        if (d <= 0) {
            r.x = this.points[0].x;
            r.z = this.points[0].z;
            return r;
        }
        if (d >= this.total) {
            const last = this.points[this.points.length - 1];
            r.x = last.x;
            r.z = last.z;
            return r;
        }
        const i = this.segmentAt(d);
        const a = this.points[i];
        const b = this.points[i + 1];
        const segLen = this.cum[i + 1] - this.cum[i];
        const t = segLen > 0 ? (d - this.cum[i]) / segLen : 0;
        r.x = a.x + (b.x - a.x) * t;
        r.z = a.z + (b.z - a.z) * t;
        return r;
    }

    /** Единичное направление движения в точке. */
    dirAt(d: number): Pt {
        const i = this.segmentAt(Math.min(Math.max(d, 0), this.total - 0.001));
        const a = this.points[i];
        const b = this.points[i + 1];
        const len = dist(a, b) || 1;
        return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    }

    /** Нормаль (перпендикуляр) — по ней отводим слоты в стороны от дороги. */
    normalAt(d: number): Pt {
        const dir = this.dirAt(d);
        return { x: -dir.z, z: dir.x };
    }

    /**
     * Позиция слота: отойти от пути на `side * offset` по нормали.
     * Слоты задаются дистанцией вдоль дороги, поэтому их огневые окна
     * получаются сопоставимыми — исход боя решает состав, а не везение с расстановкой.
     */
    slotPos(along: number, side: number, offset: number): Pt {
        const p = this.posAt(along);
        const n = this.normalAt(along);
        return { x: p.x + n.x * side * offset, z: p.z + n.z * side * offset };
    }

    private segmentAt(d: number): number {
        let lo = 0;
        let hi = this.cum.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (this.cum[mid] <= d) lo = mid;
            else hi = mid;
        }
        return lo;
    }
}

export function dist(a: Pt, b: Pt): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
    const dx = ax - bx;
    const dz = az - bz;
    return dx * dx + dz * dz;
}
