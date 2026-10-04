import type { UnitKind } from './SimTypes';
import { ECONOMY, SLOT_POSITIONS, UNITS, UNIT_ORDER } from './Balance';
import type { PlacedUnit } from './BattleSim';

/** Состав армии: сколько юнитов каждого типа куплено. */
export type Loadout = Record<UnitKind, number>;

export function emptyLoadout(): Loadout {
    return { archer: 0, bomber: 0, mage: 0 };
}

export function loadoutCost(l: Loadout): number {
    let sum = 0;
    for (const k of UNIT_ORDER) sum += UNITS[k].cost * l[k];
    return sum;
}

export function loadoutSize(l: Loadout): number {
    let n = 0;
    for (const k of UNIT_ORDER) n += l[k];
    return n;
}

export function loadoutLabel(l: Loadout): string {
    const parts: string[] = [];
    for (const k of UNIT_ORDER) {
        if (l[k] > 0) parts.push(`${UNITS[k].title}x${l[k]}`);
    }
    return parts.join(' + ') || 'пусто';
}

export const cheapestUnitCost = Math.min(...UNIT_ORDER.map((k) => UNITS[k].cost));

/**
 * Игрок «выжал бюджет», если на остаток уже не купить ни одного юнита.
 * Балансные ожидания (3 победных / 2 проигрышных состава) формулируются
 * именно для таких закупок — недокупленные заведомо слабее.
 */
export function isMaxedOut(l: Loadout, budget: number): boolean {
    return budget - loadoutCost(l) < cheapestUnitCost;
}

/** Все составы, влезающие в бюджет (без учёта порядка покупки). */
export function enumerateLoadouts(budget: number, maxSlots = SLOT_POSITIONS.length): Loadout[] {
    const out: Loadout[] = [];
    const maxA = Math.floor(budget / UNITS.archer.cost);
    for (let a = 0; a <= maxA; a++) {
        const restA = budget - a * UNITS.archer.cost;
        const maxB = Math.floor(restA / UNITS.bomber.cost);
        for (let b = 0; b <= maxB; b++) {
            const restB = restA - b * UNITS.bomber.cost;
            const maxM = Math.floor(restB / UNITS.mage.cost);
            for (let m = 0; m <= maxM; m++) {
                const l: Loadout = { archer: a, bomber: b, mage: m };
                const size = a + b + m;
                if (size === 0 || size > maxSlots) continue;
                out.push(l);
            }
        }
    }
    return out;
}

/** Развернуть состав в плоский список типов: [archer, archer, mage]. */
export function loadoutToKinds(l: Loadout): UnitKind[] {
    const kinds: UnitKind[] = [];
    for (const k of UNIT_ORDER) for (let i = 0; i < l[k]; i++) kinds.push(k);
    return kinds;
}

/**
 * Разложить состав по слотам «по умолчанию»: равномерно вдоль дороги.
 * Так считается эталонный исход, который видит игрок при автоподстановке.
 */
export function spreadToSlots(l: Loadout, slotCount = SLOT_POSITIONS.length): PlacedUnit[] {
    const kinds = loadoutToKinds(l);
    const placed: PlacedUnit[] = [];
    const stride = kinds.length > 0 ? slotCount / kinds.length : 1;
    for (let i = 0; i < kinds.length; i++) {
        const slot = Math.min(slotCount - 1, Math.round(i * stride));
        placed.push({ slot, kind: kinds[i] });
    }
    return placed;
}

/**
 * Все варианты расстановки состава по слотам — для проверки, что исход
 * волны решает состав, а не удачное место. Кол-во = размещения без повторений.
 */
export function allPlacements(l: Loadout, slotCount = SLOT_POSITIONS.length): PlacedUnit[][] {
    const kinds = loadoutToKinds(l);
    const out: PlacedUnit[][] = [];
    const used: boolean[] = new Array(slotCount).fill(false);
    const acc: PlacedUnit[] = [];

    const rec = (i: number) => {
        if (i === kinds.length) {
            out.push(acc.slice());
            return;
        }
        for (let s = 0; s < slotCount; s++) {
            if (used[s]) continue;
            used[s] = true;
            acc.push({ slot: s, kind: kinds[i] });
            rec(i + 1);
            acc.pop();
            used[s] = false;
        }
    };
    rec(0);
    return out;
}

export function canAfford(l: Loadout, kind: UnitKind, coins: number): boolean {
    return coins >= UNITS[kind].cost;
}

export const START_COINS = ECONOMY.startCoins;
