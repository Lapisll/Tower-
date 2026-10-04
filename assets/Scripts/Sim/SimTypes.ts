/**
 * Чистые типы боевой модели.
 * ВАЖНО: в папке Sim нельзя импортировать 'cc' — этот слой исполняется
 * и внутри игры, и в Node (tools/balance.ts) для прогона баланса.
 * По той же причине здесь нет enum и декораторов (Node их не стрипает).
 */

export type UnitKind = 'archer' | 'bomber' | 'mage';
export type EnemyKind = 'grunt' | 'tank' | 'boss';
export type AttackShape = 'single' | 'splash';
/**
 * Чем юнит достаёт цель:
 *  ballistic — летящий снаряд (стрела, камень), урон в момент прилёта;
 *  hitscan   — мгновенный разряд (молния мага), урон в тот же кадр.
 */
export type AttackMode = 'ballistic' | 'hitscan';

export interface Pt {
    x: number;
    z: number;
}

export interface UnitStats {
    kind: UnitKind;
    title: string;
    cost: number;
    /** урон за один выстрел */
    damage: number;
    /** секунд между выстрелами */
    attackInterval: number;
    range: number;
    projectileSpeed: number;
    shape: AttackShape;
    attack: AttackMode;
    /** ballistic: насколько высоко идёт дуга (0 = настильно, 1 = навесом) */
    arc: number;
    /** радиус осколочного урона, только для shape === 'splash' */
    splashRadius: number;
    /** 0 = без замедления, 0.4 = цель теряет 40% скорости */
    slowFactor: number;
    slowDuration: number;
    /** цвет прототипного примитива, пока нет моделей */
    tint: number;
}

export interface EnemyStats {
    kind: EnemyKind;
    hp: number;
    speed: number;
    /** урон базе при прорыве */
    baseDamage: number;
    /** монет за убийство */
    bounty: number;
    radius: number;
    tint: number;
}

/** Один «пакет» врагов внутри волны. */
export interface SpawnGroup {
    kind: EnemyKind;
    count: number;
    /** задержка от старта волны до первого врага группы */
    delay: number;
    /** интервал между врагами внутри группы */
    interval: number;
}

export interface WaveConfig {
    index: number;
    title: string;
    groups: SpawnGroup[];
    /** бонус за прохождение волны */
    clearBonus: number;
}

/** События для слоя представления. Позиции сущностей вью читает напрямую из state. */
export type SimEvent =
    | { t: 'spawn'; id: number; kind: EnemyKind }
    | { t: 'shot'; slot: number; projId: number; targetId: number; kind: UnitKind }
    | { t: 'hit'; projId: number; x: number; z: number; splash: number; kind: UnitKind }
    | {
          t: 'beam';
          slot: number;
          fromX: number;
          fromZ: number;
          toX: number;
          toZ: number;
          kind: UnitKind;
      }
    | { t: 'damage'; id: number; amount: number; x: number; z: number }
    | { t: 'kill'; id: number; x: number; z: number; bounty: number }
    | { t: 'leak'; id: number; damage: number; baseHp: number }
    | { t: 'waveEnd'; won: boolean };

export interface SimEnemy {
    id: number;
    kind: EnemyKind;
    stats: EnemyStats;
    hp: number;
    /** пройденный путь в юнитах длины */
    dist: number;
    x: number;
    z: number;
    slowLeft: number;
    slowFactor: number;
    alive: boolean;
    /** дошёл до базы */
    leaked: boolean;
}

export interface SimUnit {
    slot: number;
    kind: UnitKind;
    stats: UnitStats;
    x: number;
    z: number;
    cooldown: number;
    /** для разворота модели во вью */
    aimX: number;
    aimZ: number;
}

export interface SimProjectile {
    id: number;
    x: number;
    z: number;
    /** откуда вылетел — вью строит по этому дугу полёта */
    ox: number;
    oz: number;
    arc: number;
    targetId: number;
    /** последняя известная позиция цели — снаряд долетит туда, даже если цель умерла */
    tx: number;
    tz: number;
    speed: number;
    damage: number;
    splash: number;
    slowFactor: number;
    slowDuration: number;
    kind: UnitKind;
    dead: boolean;
}

export type WaveOutcome = 'running' | 'won' | 'lost';
