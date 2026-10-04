import type {
    EnemyKind,
    Pt,
    SimEnemy,
    SimEvent,
    SimProjectile,
    SimUnit,
    UnitKind,
    WaveConfig,
    WaveOutcome,
} from './SimTypes';
import { BASE, BOSS, ENEMIES, PATH, SIM, SLOT_POSITIONS, SYNERGY, UNITS } from './Balance';
import { PathLine, dist2 } from './Path';

export interface PlacedUnit {
    slot: number;
    kind: UnitKind;
}

export interface BattleSetup {
    wave: WaveConfig;
    units: PlacedUnit[];
    /** HP базы на старте волны (переносится между волнами) */
    baseHp?: number;
    path?: PathLine;
    /** переопределение позиций слотов — нужно инструменту подбора слотов */
    slotPositions?: Pt[];
}

export interface BattleResult {
    outcome: WaveOutcome;
    baseHp: number;
    killed: number;
    leaked: number;
    coins: number;
    seconds: number;
}

interface ScheduledSpawn {
    time: number;
    kind: EnemyKind;
}

/**
 * Детерминированный бой с фиксированным шагом. Никакого рандома и никакого 'cc':
 * один и тот же прогон в игре и в tools/balance.ts даёт один и тот же исход.
 */
export class BattleSim {
    readonly path: PathLine;
    readonly enemies: SimEnemy[] = [];
    readonly units: SimUnit[] = [];
    readonly projectiles: SimProjectile[] = [];
    readonly events: SimEvent[] = [];

    baseHp: number;
    coinsEarned = 0;
    /** эффективный (без оверкилла) урон — метрика для подбора слотов */
    damageDealt = 0;
    killed = 0;
    leaked = 0;
    time = 0;
    outcome: WaveOutcome = 'running';

    private schedule: ScheduledSpawn[] = [];
    private spawnCursor = 0;
    private nextId = 1;
    private nextProjId = 1;
    private accumulator = 0;
    private bossHp = ENEMIES.boss.hp;
    /** множитель урона за разнообразие классов, см. SYNERGY */
    readonly damageMul: number;
    private readonly wave: WaveConfig;

    constructor(setup: BattleSetup) {
        this.path = setup.path ?? PATH;
        this.wave = setup.wave;
        this.baseHp = setup.baseHp ?? BASE.hp;

        const slots = setup.slotPositions ?? SLOT_POSITIONS;
        this.damageMul = synergyMultiplier(setup.units);
        for (const p of setup.units) {
            const stats = UNITS[p.kind];
            const pos = slots[p.slot];
            this.units.push({
                slot: p.slot,
                kind: p.kind,
                stats,
                x: pos.x,
                z: pos.z,
                // разводим первый залп по времени: иначе все бьют в одну цель и получается overkill
                cooldown: (p.slot % 4) * 0.12,
                aimX: pos.x,
                aimZ: pos.z + 1,
            });
        }

        this.buildSchedule();
        this.applyBossScaling();
    }

    // -- публичное API -------------------------------------------------------

    /** Прогон кадра: дробит dt на фиксированные шаги. */
    update(dt: number): void {
        if (this.outcome !== 'running') return;
        this.accumulator += Math.min(dt, 0.25);
        while (this.accumulator >= SIM.step) {
            this.accumulator -= SIM.step;
            this.step(SIM.step);
            if (this.outcome !== 'running') break;
        }
    }

    /** Безвизуальный прогон до конца волны — для балансных прогонов. */
    runToEnd(): BattleResult {
        while (this.outcome === 'running' && this.time < SIM.maxWaveSeconds) {
            this.step(SIM.step);
        }
        return this.result();
    }

    result(): BattleResult {
        return {
            outcome: this.outcome,
            baseHp: this.baseHp,
            killed: this.killed,
            leaked: this.leaked,
            coins: this.coinsEarned,
            seconds: this.time,
        };
    }

    /** Забрать накопленные события и очистить очередь. */
    drainEvents(out: SimEvent[]): void {
        for (const e of this.events) out.push(e);
        this.events.length = 0;
    }

    findEnemy(id: number): SimEnemy | null {
        for (const e of this.enemies) if (e.id === id) return e;
        return null;
    }

    get bossMaxHp(): number {
        return this.bossHp;
    }

    // -- шаг симуляции -------------------------------------------------------

    private step(dt: number): void {
        this.time += dt;
        this.doSpawns();
        this.moveEnemies(dt);
        this.fireUnits(dt);
        this.moveProjectiles(dt);
        this.cleanup();
        this.checkEnd();
    }

    private buildSchedule(): void {
        for (const g of this.wave.groups) {
            for (let i = 0; i < g.count; i++) {
                this.schedule.push({ time: g.delay + i * g.interval, kind: g.kind });
            }
        }
        this.schedule.sort((a, b) => a.time - b.time);
    }

    private doSpawns(): void {
        while (
            this.spawnCursor < this.schedule.length &&
            this.schedule[this.spawnCursor].time <= this.time
        ) {
            const s = this.schedule[this.spawnCursor++];
            const stats = ENEMIES[s.kind];
            const start = this.path.posAt(0);
            const e: SimEnemy = {
                id: this.nextId++,
                kind: s.kind,
                stats,
                hp: s.kind === 'boss' ? this.bossHp : stats.hp,
                dist: 0,
                x: start.x,
                z: start.z,
                slowLeft: 0,
                slowFactor: 0,
                alive: true,
                leaked: false,
            };
            this.enemies.push(e);
            this.events.push({ t: 'spawn', id: e.id, kind: e.kind });
        }
    }

    private moveEnemies(dt: number): void {
        const tmp = { x: 0, z: 0 };
        for (const e of this.enemies) {
            if (!e.alive) continue;
            if (e.slowLeft > 0) {
                e.slowLeft -= dt;
                if (e.slowLeft <= 0) e.slowFactor = 0;
            }
            const speed = e.stats.speed * (1 - e.slowFactor);
            e.dist += speed * dt;
            if (e.dist >= this.path.total) {
                e.alive = false;
                e.leaked = true;
                this.leaked++;
                this.baseHp -= e.stats.baseDamage;
                this.events.push({
                    t: 'leak',
                    id: e.id,
                    damage: e.stats.baseDamage,
                    baseHp: this.baseHp,
                });
                continue;
            }
            this.path.posAt(e.dist, tmp);
            e.x = tmp.x;
            e.z = tmp.z;
        }
    }

    private fireUnits(dt: number): void {
        for (const u of this.units) {
            u.cooldown -= dt;
            if (u.cooldown > 0) continue;
            const target = this.pickTarget(u);
            if (!target) continue;

            u.cooldown = u.stats.attackInterval;
            u.aimX = target.x;
            u.aimZ = target.z;

            if (u.stats.attack === 'hitscan') {
                // молния мага: ни времени полёта, ни промаха по движущейся цели
                this.events.push({
                    t: 'beam',
                    slot: u.slot,
                    fromX: u.x,
                    fromZ: u.z,
                    toX: target.x,
                    toZ: target.z,
                    kind: u.kind,
                });
                this.applyDamageAt(
                    target.x,
                    target.z,
                    u.stats.damage * this.damageMul,
                    u.stats.splashRadius,
                    u.stats.slowFactor,
                    u.stats.slowDuration,
                    target.id
                );
                continue;
            }

            const p: SimProjectile = {
                id: this.nextProjId++,
                x: u.x,
                z: u.z,
                ox: u.x,
                oz: u.z,
                arc: u.stats.arc,
                targetId: target.id,
                tx: target.x,
                tz: target.z,
                speed: u.stats.projectileSpeed,
                damage: u.stats.damage * this.damageMul,
                splash: u.stats.splashRadius,
                slowFactor: u.stats.slowFactor,
                slowDuration: u.stats.slowDuration,
                kind: u.kind,
                dead: false,
            };
            this.projectiles.push(p);
            this.events.push({ t: 'shot', slot: u.slot, projId: p.id, targetId: target.id, kind: u.kind });
        }
    }

    /** Классика TD: бьём того, кто ближе всех к базе из тех, кто в радиусе. */
    private pickTarget(u: SimUnit): SimEnemy | null {
        let best: SimEnemy | null = null;
        const r2 = u.stats.range * u.stats.range;
        for (const e of this.enemies) {
            if (!e.alive) continue;
            if (dist2(e.x, e.z, u.x, u.z) > r2) continue;
            if (!best || e.dist > best.dist) best = e;
        }
        return best;
    }

    private moveProjectiles(dt: number): void {
        for (const p of this.projectiles) {
            if (p.dead) continue;
            const target = this.findEnemy(p.targetId);
            // цель жива — доводим снаряд, умерла — летим в последнюю известную точку
            if (target && target.alive) {
                p.tx = target.x;
                p.tz = target.z;
            }
            const dx = p.tx - p.x;
            const dz = p.tz - p.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            const stepLen = p.speed * dt;
            if (len <= stepLen || len < 0.001) {
                p.x = p.tx;
                p.z = p.tz;
                this.explode(p);
                continue;
            }
            p.x += (dx / len) * stepLen;
            p.z += (dz / len) * stepLen;
        }
    }

    private explode(p: SimProjectile): void {
        p.dead = true;
        this.events.push({ t: 'hit', projId: p.id, x: p.x, z: p.z, splash: p.splash, kind: p.kind });
        this.applyDamageAt(p.x, p.z, p.damage, p.splash, p.slowFactor, p.slowDuration, p.targetId);
    }

    /** Попадание в точку: по площади, либо строго по цели. */
    private applyDamageAt(
        x: number,
        z: number,
        damage: number,
        splash: number,
        slowFactor: number,
        slowDuration: number,
        targetId: number
    ): void {
        if (splash > 0) {
            const r2 = splash * splash;
            for (const e of this.enemies) {
                if (!e.alive) continue;
                if (dist2(e.x, e.z, x, z) > r2) continue;
                this.damage(e, damage, slowFactor, slowDuration);
            }
        } else {
            const target = this.findEnemy(targetId);
            if (target && target.alive) this.damage(target, damage, slowFactor, slowDuration);
        }
    }

    private damage(e: SimEnemy, amount: number, slowFactor: number, slowDuration: number): void {
        this.damageDealt += Math.min(amount, e.hp);
        e.hp -= amount;
        this.events.push({ t: 'damage', id: e.id, amount, x: e.x, z: e.z });
        if (slowFactor > 0) {
            // замедление не складывается, а обновляется: два мага не должны стопить волну намертво
            e.slowFactor = Math.max(e.slowFactor, slowFactor);
            e.slowLeft = Math.max(e.slowLeft, slowDuration);
        }
        if (e.hp <= 0) {
            e.alive = false;
            this.killed++;
            this.coinsEarned += e.stats.bounty;
            this.events.push({ t: 'kill', id: e.id, x: e.x, z: e.z, bounty: e.stats.bounty });
        }
    }

    private cleanup(): void {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
        }
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            if (!this.enemies[i].alive) this.enemies.splice(i, 1);
        }
    }

    private checkEnd(): void {
        if (this.baseHp <= 0) {
            this.baseHp = 0;
            this.outcome = 'lost';
            this.events.push({ t: 'waveEnd', won: false });
            return;
        }
        if (this.spawnCursor < this.schedule.length) return;
        for (const e of this.enemies) if (e.alive) return;
        this.outcome = 'won';
        this.coinsEarned += this.wave.clearBonus;
        this.events.push({ t: 'waveEnd', won: true });
    }

    // -- резиновый босс ------------------------------------------------------

    private applyBossScaling(): void {
        const hasBoss = this.wave.groups.some((g) => g.kind === 'boss');
        if (!hasBoss || !BOSS.rubberBand) return;
        const potential = potentialDamageAgainst(this.units, 'boss', this.path) * this.damageMul;
        this.bossHp = clamp(potential * BOSS.killAtPathFraction, BOSS.minHp, BOSS.maxHp);
    }
}

/** Множитель урона за разнообразие классов в армии. */
export function synergyMultiplier(units: PlacedUnit[]): number {
    const kinds = new Set<UnitKind>();
    for (const u of units) kinds.add(u.kind);
    return 1 + SYNERGY.diversityBonus * Math.max(0, kinds.size - 1);
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Длина участка дороги, простреливаемая из точки. */
export function coveredLength(path: PathLine, x: number, z: number, range: number): number {
    const stepLen = 0.1;
    const r2 = range * range;
    let covered = 0;
    for (let d = 0; d < path.total; d += stepLen) {
        const p = path.posAt(d);
        if (dist2(p.x, p.z, x, z) <= r2) covered += stepLen;
    }
    return covered;
}

/**
 * Сколько урона расставленные юниты теоретически успеют влить в одного врага
 * данного типа за его проход. Отсюда берётся резиновое HP босса.
 */
export function potentialDamageAgainst(units: SimUnit[], kind: EnemyKind, path: PathLine): number {
    const speed = ENEMIES[kind].speed;
    let total = 0;
    for (const u of units) {
        const covered = coveredLength(path, u.x, u.z, u.stats.range);
        const seconds = covered / speed;
        const dps = u.stats.damage / u.stats.attackInterval;
        total += seconds * dps;
    }
    return total;
}
