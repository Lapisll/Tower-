import type { EnemyKind, EnemyStats, Pt, UnitKind, UnitStats, WaveConfig } from './SimTypes';
import { PathLine } from './Path';

/**
 * ЕДИНСТВЕННОЕ место с игровыми числами.
 * Правится руками, проверяется прогоном `npm run balance`
 * (tools/balance.ts гоняет тот же BattleSim по всем закупкам).
 */

// ─── Экономика ──────────────────────────────────────────────────────────────
export const ECONOMY = {
    startCoins: 500,
    /** монеты капают за каждого убитого врага (bounty в статах врага) */
    bountyEnabled: true,
    /** сколько даётся сверху за зачистку волны; индекс = номер волны - 1 */
    clearBonus: [80, 150, 0],
    /** можно ли докупать юнитов между волнами */
    shopBetweenWaves: true,
    /**
     * Не выпускать в первую волну, пока на остаток можно купить ещё юнита.
     * Иначе появляются «серые» недокупы (один маг за 300, лучник+метатель за 350),
     * которые ломают схему «ровно 3 победных / 2 проигрышных состава».
     */
    requireFullSpend: true,
};

/**
 * Синергия классов: армия из разных юнитов бьёт сильнее.
 * Это и есть главный урок плейбла — моно-состав не тянет, микс тянет.
 * Поставь 0, чтобы выключить механику (тогда 2 лучника + метатель
 * перестанет стабильно проходить волну 1, см. npm run balance).
 */
export const SYNERGY = {
    /** +N к множителю урона за каждый КЛАСС сверх первого */
    diversityBonus: 0.55,
};

// ─── База ───────────────────────────────────────────────────────────────────
export const BASE = {
    hp: 100,
    /** позиция замка = конец пути */
};

// ─── Юниты ──────────────────────────────────────────────────────────────────
export const UNITS: Record<UnitKind, UnitStats> = {
    archer: {
        kind: 'archer',
        title: 'Archer',
        cost: 150,
        damage: 12,
        attackInterval: 0.7,
        range: 5.4,
        projectileSpeed: 18,
        shape: 'single',
        attack: 'ballistic',
        arc: 0.35,
        splashRadius: 0,
        slowFactor: 0,
        slowDuration: 0,
        tint: 0x54d17a,
    },
    bomber: {
        kind: 'bomber',
        title: 'Thrower',
        cost: 200,
        damage: 23,
        attackInterval: 1.9,
        range: 4.0,
        projectileSpeed: 11,
        shape: 'splash',
        attack: 'ballistic',
        arc: 1.0,
        splashRadius: 1.7,
        slowFactor: 0,
        slowDuration: 0,
        tint: 0xe8863c,
    },
    mage: {
        kind: 'mage',
        title: 'Mage',
        cost: 300,
        damage: 22,
        attackInterval: 0.95,
        range: 6.4,
        projectileSpeed: 13,
        shape: 'splash',
        attack: 'hitscan',
        arc: 0,
        splashRadius: 1.0,
        slowFactor: 0.30,
        slowDuration: 1.2,
        tint: 0x6f7bff,
    },
};

export const UNIT_ORDER: UnitKind[] = ['archer', 'bomber', 'mage'];

// ─── Враги ──────────────────────────────────────────────────────────────────
export const ENEMIES: Record<EnemyKind, EnemyStats> = {
    grunt: {
        kind: 'grunt',
        hp: 34,
        speed: 4.0,
        baseDamage: 34,
        bounty: 20,
        radius: 0.45,
        tint: 0xc0504d,
    },
    tank: {
        kind: 'tank',
        hp: 190,
        speed: 2.7,
        baseDamage: 50,
        bounty: 70,
        radius: 0.75,
        tint: 0x8a3a6b,
    },
    boss: {
        kind: 'boss',
        hp: 1200, // переопределяется резиновым расчётом, см. BOSS
        speed: 2.0,
        baseDamage: 100,
        bounty: 0,
        radius: 1.3,
        tint: 0x2c2a3e,
    },
};

/**
 * Босса игрок обязан убить при ЛЮБОМ составе — это финальный WOW перед CTA.
 * Поэтому его HP не фиксировано, а считается от огневой мощи расставленных
 * юнитов: он умирает примерно на `killAtPathFraction` пути.
 */
export const BOSS = {
    rubberBand: true,
    /** доля потенциального урона, которую босс «съедает» до смерти */
    killAtPathFraction: 0.62,
    minHp: 60,
    maxHp: 4000,
};

// ─── Волны ──────────────────────────────────────────────────────────────────
export const WAVES: WaveConfig[] = [
    {
        index: 1,
        title: 'Волна 1',
        // плотная толпа: одиночные цели захлёбываются, AoE выкашивает
        groups: [{ kind: 'grunt', count: 22, delay: 0, interval: 0.26 }],
        clearBonus: ECONOMY.clearBonus[0],
    },
    {
        index: 2,
        title: 'Волна 2',
        // 10 врагов, трое «пожирнее»
        groups: [
            { kind: 'grunt', count: 4, delay: 0, interval: 0.4 },
            { kind: 'tank', count: 3, delay: 2.4, interval: 1.2 },
            { kind: 'grunt', count: 3, delay: 6.5, interval: 0.35 },
        ],
        clearBonus: ECONOMY.clearBonus[1],
    },
    {
        index: 3,
        title: 'БОСС',
        groups: [{ kind: 'boss', count: 1, delay: 0.4, interval: 1 }],
        clearBonus: ECONOMY.clearBonus[2],
    },
];

// ─── Арена ──────────────────────────────────────────────────────────────────
/** Дорога врагов: спавн сверху (−Z), база внизу (+Z). Портретная змейка. */
export const PATH_POINTS: Pt[] = [
    { x: 0, z: -10 },
    { x: 0, z: -6 },
    { x: -4, z: -6 },
    { x: -4, z: -2 },
    { x: 4, z: -2 },
    { x: 4, z: 2 },
    { x: 0, z: 2 },
    { x: 0, z: 8 },
];

export const PATH = new PathLine(PATH_POINTS);

/** Насколько площадка отстоит от кромки дороги. */
export const SLOT_OFFSET = 2.0;

/**
 * Площадки под юнитов. Задаются дистанцией вдоль дороги и стороной —
 * позиции считает PathLine.slotPos, подбирает их `npm run slots`.
 */
export const SLOT_ANCHORS: { along: number; side: 1 | -1 }[] = [
    { along: 8.5, side: -1 },
    { along: 17.0, side: 1 },
    { along: 25.5, side: 1 },
    { along: 4.5, side: 1 },
    { along: 21.0, side: -1 },
    { along: 12.5, side: -1 },
    { along: 29.5, side: -1 },
];

/**
 * С какой волны площадка доступна (0 = сразу).
 *
 * На первую волну открыты ровно три, равномерно вдоль трассы: любые 2-3 юнита
 * закрывают дорогу целиком, поэтому исход решает состав армии, а не то, куда
 * игрок ткнул. Остальные открываются между волнами — это и прогрессия, и повод
 * вернуться в магазин.
 */
export const SLOT_UNLOCK_WAVE = [0, 0, 0, 1, 1, 2, 2];

export function slotsOpenAtWave(waveIndex: number): number {
    let n = 0;
    for (const w of SLOT_UNLOCK_WAVE) if (w <= waveIndex) n++;
    return n;
}

export const SLOT_POSITIONS: Pt[] = SLOT_ANCHORS.map((a) =>
    PATH.slotPos(a.along, a.side, SLOT_OFFSET)
);

export const ARENA = {
    /** габариты земли под камеру, в тайлах 1x1 */
    width: 14,
    depth: 22,
    /** где стоит замок */
    basePos: PATH_POINTS[PATH_POINTS.length - 1],
    spawnPos: PATH_POINTS[0],
    roadWidth: 2,
};

// ─── Прочее ─────────────────────────────────────────────────────────────────
export const SIM = {
    /** фиксированный шаг симуляции; вью интерполирует между шагами */
    step: 1 / 60,
    /** страховка от бесконечного боя в оффлайн-прогоне */
    maxWaveSeconds: 120,
};
