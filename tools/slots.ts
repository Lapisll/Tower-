/**
 * Подбор площадок под юнитов.
 *
 * Позиции вдоль дороги заданы вручную (равномерно, см. ALONG), а скрипт решает
 * ДЛЯ КАЖДОЙ, с какой стороны дороги её поставить: ставит туда по одному юниту
 * каждого типа, прогоняет волну 1 и смотрит нанесённый урон. Побеждает сторона,
 * чья сила ближе к медианной — так площадки получаются равноценными и исход
 * волны решает состав армии, а не везение с тапом.
 *
 *   npm run slots      -> печатает готовый блок SLOT_ANCHORS для Balance.ts
 */
import {
    PATH,
    SLOT_OFFSET,
    SLOT_UNLOCK_WAVE,
    UNITS,
    UNIT_ORDER,
    WAVES,
} from '../assets/Scripts/Sim/Balance';
import { BattleSim } from '../assets/Scripts/Sim/BattleSim';
import type { UnitKind } from '../assets/Scripts/Sim/SimTypes';

/**
 * Позиции вдоль дороги, в порядке индексов слотов.
 * Первые три (индексы 0..2) открыты с первой волны и раскиданы равномерно —
 * любые 2-3 юнита на них покрывают трассу целиком, без дыр.
 * Остальные открываются позже и садятся в промежутки.
 */
const ALONG = [8.5, 17.0, 25.5, 4.5, 21.0, 12.5, 29.5];

function measure(x: number, z: number, kind: UnitKind): number {
    const sim = new BattleSim({
        wave: WAVES[0],
        units: [{ slot: 0, kind }],
        slotPositions: [{ x, z }],
        baseHp: 100000, // база не должна пасть раньше конца волны, иначе замер обрежется
    });
    sim.runToEnd();
    return sim.damageDealt;
}

interface Option {
    along: number;
    side: 1 | -1;
    x: number;
    z: number;
    dmg: Record<UnitKind, number>;
    score: number;
}

const options: Option[] = [];
for (const along of ALONG) {
    for (const side of [-1, 1] as const) {
        const p = PATH.slotPos(along, side, SLOT_OFFSET);
        const dmg = { archer: 0, bomber: 0, mage: 0 } as Record<UnitKind, number>;
        for (const k of UNIT_ORDER) dmg[k] = measure(p.x, p.z, k);
        options.push({ along, side, x: p.x, z: p.z, dmg, score: 0 });
    }
}

// нормируем по каждому типу отдельно: площадка должна быть одинаково удобна
// и лучнику с большим радиусом, и метателю с маленьким
const maxByKind: Record<UnitKind, number> = { archer: 0, bomber: 0, mage: 0 };
for (const o of options) {
    for (const k of UNIT_ORDER) maxByKind[k] = Math.max(maxByKind[k], o.dmg[k]);
}
for (const o of options) {
    let sum = 0;
    for (const k of UNIT_ORDER) sum += o.dmg[k] / (maxByKind[k] || 1);
    o.score = sum / UNIT_ORDER.length;
}

const sorted = [...options].sort((a, b) => a.score - b.score);
const median = sorted[Math.floor(sorted.length / 2)].score;

const chosen: Option[] = ALONG.map((along) => {
    const pair = options.filter((o) => o.along === along);
    pair.sort((a, b) => Math.abs(a.score - median) - Math.abs(b.score - median));
    return pair[0];
});

const scores = chosen.map((c) => c.score);
const lo = Math.min(...scores);
const hi = Math.max(...scores);

console.log(`Длина дороги: ${PATH.total.toFixed(1)}`);
console.log(`Медианная сила точки: ${median.toFixed(3)}`);
console.log(
    `Разброс площадок: ${lo.toFixed(3)} .. ${hi.toFixed(3)}  (${((hi / lo - 1) * 100).toFixed(1)}%)`
);

const wave1 = chosen.filter((_, i) => SLOT_UNLOCK_WAVE[i] === 0);
if (wave1.length > 0) {
    const s = wave1.map((c) => c.score);
    const spread = (Math.max(...s) / Math.min(...s) - 1) * 100;
    console.log(`открыты на волне 1: ${wave1.length} шт, разброс ${spread.toFixed(1)}%`);
}

console.log('\nslot  волна  along side      x      z   сила   урон A / B / M');
chosen.forEach((c, i) => {
    console.log(
        String(i).padStart(4) +
            String(SLOT_UNLOCK_WAVE[i] + 1).padStart(7) +
            c.along.toFixed(1).padStart(7) +
            String(c.side).padStart(5) +
            c.x.toFixed(1).padStart(7) +
            c.z.toFixed(1).padStart(7) +
            c.score.toFixed(3).padStart(7) +
            '   ' +
            UNIT_ORDER.map((k) => Math.round(c.dmg[k]).toString().padStart(4)).join(' /')
    );
});

console.log('\n--- вставить в Balance.ts ---');
console.log('export const SLOT_ANCHORS: { along: number; side: 1 | -1 }[] = [');
for (const c of chosen) console.log(`    { along: ${c.along.toFixed(1)}, side: ${c.side} },`);
console.log('];');
console.log(`Радиусы: ${UNIT_ORDER.map((k) => `${UNITS[k].title} ${UNITS[k].range}`).join(', ')}`);
