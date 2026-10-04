/**
 * Балансный прогон: гоняет тот же BattleSim, что и игра, по всем закупкам
 * и всем расстановкам — и проверяет, что волна 1 даёт ровно 3 победных
 * и 2 проигрышных состава, а исход не зависит от того, в какие слоты встали юниты.
 *
 *   npm run balance
 */
import { BattleSim } from '../assets/Scripts/Sim/BattleSim';
import { ECONOMY, SLOT_POSITIONS, UNITS, WAVES, slotsOpenAtWave } from '../assets/Scripts/Sim/Balance';
import {
    allPlacements,
    enumerateLoadouts,
    isMaxedOut,
    loadoutCost,
    loadoutLabel,
    loadoutSize,
    spreadToSlots,
    type Loadout,
} from '../assets/Scripts/Sim/Loadout';
import type { PlacedUnit } from '../assets/Scripts/Sim/BattleSim';

/** Ключ состава: archer-bomber-mage. */
const key = (l: Loadout) => `${l.archer}-${l.bomber}-${l.mage}`;

/** Дизайнерское ожидание для волны 1 при стартовом бюджете. */
const EXPECTED_WAVE1: Record<string, 'win' | 'lose'> = {
    '3-0-0': 'lose', // моно-лучники: нет AoE против плотной толпы
    '0-2-0': 'lose', // моно-метатели: мало DPS и короткий радиус
    '2-1-0': 'win',
    '1-0-1': 'win',
    '0-1-1': 'win',
};

const MAX_PLACEMENTS = 400; // дальше берём равномерную выборку, иначе перебор взрывается

function placementsFor(l: Loadout, slotCount: number): PlacedUnit[][] {
    const all = allPlacements(l, slotCount);
    if (all.length <= MAX_PLACEMENTS) return all;
    const stride = all.length / MAX_PLACEMENTS;
    const out: PlacedUnit[][] = [];
    for (let i = 0; i < MAX_PLACEMENTS; i++) out.push(all[Math.floor(i * stride)]);
    return out;
}

interface Row {
    label: string;
    key: string;
    cost: number;
    runs: number;
    wins: number;
    minLeak: number;
    maxLeak: number;
    minBaseHp: number;
    defaultWin: boolean;
    seconds: number;
}

function runWave(waveIndex: number, l: Loadout, baseHp?: number): Row {
    const wave = WAVES[waveIndex];
    const slotCount = slotsOpenAtWave(waveIndex);
    const placements = placementsFor(l, slotCount);
    let wins = 0;
    let minLeak = Infinity;
    let maxLeak = -Infinity;
    let minBaseHp = Infinity;
    let seconds = 0;

    for (const units of placements) {
        const sim = new BattleSim({ wave, units, baseHp });
        const r = sim.runToEnd();
        if (r.outcome === 'won') wins++;
        minLeak = Math.min(minLeak, r.leaked);
        maxLeak = Math.max(maxLeak, r.leaked);
        minBaseHp = Math.min(minBaseHp, r.baseHp);
        seconds = Math.max(seconds, r.seconds);
    }

    const def = new BattleSim({ wave, units: spreadToSlots(l, slotCount), baseHp });
    const defRes = def.runToEnd();

    return {
        label: loadoutLabel(l),
        key: key(l),
        cost: loadoutCost(l),
        runs: placements.length,
        wins,
        minLeak,
        maxLeak,
        minBaseHp,
        defaultWin: defRes.outcome === 'won',
        seconds,
    };
}

function pad(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
    return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function printTable(title: string, rows: Row[], expected?: Record<string, 'win' | 'lose'>): number {
    console.log('\n' + title);
    console.log(
        pad('состав', 30) +
            padL('цена', 6) +
            padL('вар-в', 7) +
            padL('побед', 8) +
            padL('прорыв', 9) +
            padL('HP базы', 9) +
            padL('сек', 6) +
            '  вердикт'
    );
    console.log('-'.repeat(93));

    let problems = 0;
    for (const r of rows) {
        const rate = r.wins / r.runs;
        const pct = `${Math.round(rate * 100)}%`;
        let verdict: string;
        if (rate === 1) verdict = 'WIN';
        else if (rate === 0) verdict = 'LOSE';
        else verdict = `!! ЗАВИСИТ ОТ СЛОТОВ (${r.defaultWin ? 'дефолт WIN' : 'дефолт LOSE'})`;

        if (expected) {
            const exp = expected[r.key];
            if (exp) {
                const got = rate === 1 ? 'win' : rate === 0 ? 'lose' : 'mixed';
                if (got !== exp) {
                    verdict += `  <-- ЖДАЛИ ${exp.toUpperCase()}`;
                    problems++;
                }
            }
        }
        if (rate > 0 && rate < 1) problems++;

        console.log(
            pad(r.label, 30) +
                padL(String(r.cost), 6) +
                padL(String(r.runs), 7) +
                padL(pct, 8) +
                padL(`${r.minLeak}..${r.maxLeak}`, 9) +
                padL(String(r.minBaseHp), 9) +
                padL(r.seconds.toFixed(1), 6) +
                '  ' +
                verdict
        );
    }
    return problems;
}

// ── 1. Волна 1 на стартовые монеты ──────────────────────────────────────────
const budget = ECONOMY.startCoins;
const wave1Slots = slotsOpenAtWave(0);
const all = enumerateLoadouts(budget, wave1Slots);
const maxed = all.filter((l) => isMaxedOut(l, budget));
const partial = all.filter((l) => !isMaxedOut(l, budget));

console.log(`Бюджет: ${budget}   Площадок на волне 1: ${wave1Slots} из ${SLOT_POSITIONS.length}`);
console.log(
    'Цены: ' +
        Object.values(UNITS)
            .map((u) => `${u.title} ${u.cost}`)
            .join(', ')
);

const maxedRows = maxed.map((l) => runWave(0, l));
let problems = printTable(
    `=== ВОЛНА 1 — закупки «под ноль» (эти и есть 3 победных / 2 проигрышных) ===`,
    maxedRows,
    EXPECTED_WAVE1
);

const winCount = maxedRows.filter((r) => r.wins === r.runs).length;
const loseCount = maxedRows.filter((r) => r.wins === 0).length;

const partialRows = partial.map((l) => runWave(0, l));
printTable(
    ECONOMY.requireFullSpend
        ? '=== ВОЛНА 1 — недокупы (ECONOMY.requireFullSpend не выпускает игрока в бой с такими) ==='
        : '=== ВОЛНА 1 — недокупленные составы (справочно, должны проигрывать) ===',
    partialRows
);

// ── 2. Волна 2: берём победителей волны 1 и докупаем на заработанное ────────
console.log('\n=== ВОЛНА 2 — победители волны 1 + докупка на заработанные монеты ===');
for (const l of maxed) {
    const w1 = new BattleSim({ wave: WAVES[0], units: spreadToSlots(l, wave1Slots) });
    const r1 = w1.runToEnd();
    if (r1.outcome !== 'won') continue;

    const coins = budget - loadoutCost(l) + r1.coins;
    // самый бедный сценарий: игрок не докупает вообще
    const r2none = new BattleSim({
        wave: WAVES[1],
        units: spreadToSlots(l, slotsOpenAtWave(1)),
        baseHp: r1.baseHp,
    }).runToEnd();

    // и самый типичный: докупает лучников, пока хватает монет
    const boosted: Loadout = { ...l };
    let rest = coins;
    while (rest >= UNITS.archer.cost && loadoutSize(boosted) < slotsOpenAtWave(1)) {
        boosted.archer++;
        rest -= UNITS.archer.cost;
    }
    const r2buy = new BattleSim({
        wave: WAVES[1],
        units: spreadToSlots(boosted, slotsOpenAtWave(1)),
        baseHp: r1.baseHp,
    }).runToEnd();

    console.log(
        pad(loadoutLabel(l), 30) +
            `монет после в1: ${padL(String(coins), 4)}   ` +
            `без докупки: ${pad(r2none.outcome, 7)} (HP ${padL(String(r2none.baseHp), 3)})   ` +
            `с докупкой [${loadoutLabel(boosted)}]: ${pad(r2buy.outcome, 7)} (HP ${r2buy.baseHp})`
    );
    if (r2buy.outcome !== 'won') problems++;
}

// ── 3. Волна 3: босс обязан умирать при любом составе ───────────────────────
console.log('\n=== ВОЛНА 3 — босс (должен умирать ВСЕГДА) ===');
let bossFails = 0;
for (const l of all) {
    const sim = new BattleSim({ wave: WAVES[2], units: spreadToSlots(l, slotsOpenAtWave(2)), baseHp: 100 });
    const r = sim.runToEnd();
    if (r.outcome !== 'won') {
        console.log(`  ПРОВАЛ: ${loadoutLabel(l)} -> ${r.outcome} (HP базы ${r.baseHp})`);
        bossFails++;
    }
}
console.log(
    bossFails === 0
        ? `  OK: босс умирает во всех ${all.length} составах`
        : `  ${bossFails} составов НЕ убивают босса`
);
problems += bossFails;

// ── Итог ────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(93));
console.log(`Волна 1, закупки «под ноль»: ${winCount} победных / ${loseCount} проигрышных`);
const targetOk = winCount === 3 && loseCount === 2;
console.log(targetOk ? 'ЦЕЛЬ 3/2 ДОСТИГНУТА' : 'ЦЕЛЬ 3/2 НЕ ДОСТИГНУТА');
console.log(problems === 0 && targetOk ? 'Баланс сходится.' : `Проблем: ${problems + (targetOk ? 0 : 1)}`);
