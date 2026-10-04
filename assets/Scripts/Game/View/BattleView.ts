import { Node, Vec3, math } from 'cc';
import type { BattleSim } from '../../Sim/BattleSim';
import type { EnemyKind, SimEvent, UnitKind } from '../../Sim/SimTypes';
import { ENEMIES, UNITS } from '../../Sim/Balance';
import { ANIM, ENEMY_VIEW, FX, JUICE, PALETTE, RIG, TILE, UNIT_VIEW } from '../ViewConfig';
import { ENEMY_MODELS, UNIT_MODELS, instantiateModel } from '../AssetSlots';
import { boxMesh, coneMesh, cylinderMesh, makeShape, sphereMesh } from './Prims';
import { Audio } from '../Services/Audio';
import { RigAnimator } from './RigAnimator';

interface EnemyVisual {
    node: Node;
    /** отдельный узел под модель: анимируем его, чтобы полоска HP не прыгала */
    body: Node;
    hpFill: Node;
    maxHp: number;
    kind: EnemyKind;
    /** сколько осталось от «сплющивания» после удара, сек */
    punch: number;
}

/** Куда бой сообщает о событиях, которые видны вне арены (камера, интерфейс). */
export interface BattleHooks {
    shake?(strength: number): void;
    /** враг убит: показать «+N» и пустить монеты в счётчик */
    coins?(x: number, z: number, amount: number): void;
    /** враг дошёл до замка */
    baseHit?(): void;
}

interface UnitVisual {
    node: Node;
    body: Node;
    /** сколько осталось от анимации отдачи, секунды */
    recoil: number;
    /** анимация по костям, если у модели есть риг */
    rig: RigAnimator | null;
    /** сколько осталось от замаха, секунды */
    attack: number;
}

interface ProjectileVisual {
    node: Node;
    startX: number;
    startZ: number;
    totalDist: number;
    prevX: number;
    prevY: number;
    prevZ: number;
}

type EffectKind =
    /** «шлепок» при установке юнита: узел остаётся жить */
    | 'pop'
    /** вспышка попадания: растёт и исчезает */
    | 'burst'
    /** осколки смерти: разлетаются с гравитацией */
    | 'debris'
    /** молния мага: просто гаснет */
    | 'flash'
    /** искра попадания: летит без гравитации и тает */
    | 'spark'
    /** умирающий враг: подскок и проседание, затем удаление */
    | 'die';

interface Effect {
    kind: EffectKind;
    node: Node;
    life: number;
    maxLife: number;
    vel: Vec3;
    grow: number;
}

/**
 * Рисует то, что насчитал BattleSim.
 *
 * Вью ничего не решает: позиции, урон и смерти приходят из симуляции,
 * здесь только модели, поворот стволов, полоски HP и вспышки попаданий.
 * Благодаря этому бой в игре и бой в балансном прогоне — один и тот же бой.
 */
export class BattleView {
    readonly root: Node;
    /** подписчики на события боя — ставит Bootstrap и GameController */
    readonly hooks: BattleHooks = {};
    private readonly unitsRoot: Node;
    private readonly enemiesRoot: Node;
    private readonly fxRoot: Node;

    private readonly unitNodes = new Map<number, UnitVisual>();
    private readonly enemyVisuals = new Map<number, EnemyVisual>();
    private readonly projectileVisuals = new Map<number, ProjectileVisual>();
    private readonly effects: Effect[] = [];
    private readonly drained: SimEvent[] = [];

    /** наклон камеры — под него разворачиваем полоски HP, чтобы смотрели в объектив */
    private billboardTilt = -54;
    private idleTime = 0;

    constructor(parent: Node) {
        this.root = new Node('Battle');
        this.root.setParent(parent);
        this.unitsRoot = new Node('Units');
        this.unitsRoot.setParent(this.root);
        this.enemiesRoot = new Node('Enemies');
        this.enemiesRoot.setParent(this.root);
        this.fxRoot = new Node('FX');
        this.fxRoot.setParent(this.root);
    }

    setBillboardTilt(tiltDeg: number): void {
        this.billboardTilt = -tiltDeg;
        this.enemyVisuals.forEach((v) => {
            const bar = v.hpFill.parent;
            if (bar) bar.setRotationFromEuler(this.billboardTilt, 0, 0);
        });
    }

    // -- юниты ---------------------------------------------------------------

    /** Поставить юнита на площадку. Живёт между волнами, пересоздаётся только при рестарте. */
    spawnUnit(slot: number, kind: UnitKind, x: number, z: number): Node {
        const existing = this.unitNodes.get(slot);
        if (existing) existing.node.destroy();

        const node = new Node(`Unit_${kind}_${slot}`);
        node.setParent(this.unitsRoot);
        node.setPosition(x, TILE.grassY + UNIT_VIEW.padHeight, z);

        // тело отдельным узлом: его качает анимация, а сам юнит стоит на месте
        const body = new Node('Body');
        body.setParent(node);

        const custom = instantiateModel(UNIT_MODELS[kind]);
        let rig: RigAnimator | null = null;
        if (custom) {
            custom.setParent(body);
            rig = RigAnimator.tryCreate(custom, kind);
        } else {
            this.buildUnitPrimitive(body, kind);
        }

        this.unitNodes.set(slot, { node, body, recoil: 0, rig, attack: 0 });
        // короткий «шлепок» при установке — тап ощущается отзывчивее
        node.setScale(0.4, 1.5, 0.4);
        this.effects.push({
            kind: 'pop',
            node,
            life: 0.18,
            maxLife: 0.18,
            vel: new Vec3(),
            grow: 0,
        });
        return node;
    }

    private buildUnitPrimitive(parent: Node, kind: UnitKind): void {
        const tint = UNITS[kind].tint;
        makeShape(parent, cylinderMesh(UNIT_VIEW.bodyRadius, UNIT_VIEW.bodyHeight), tint, {
            name: 'Body',
            pos: new Vec3(0, UNIT_VIEW.bodyHeight / 2, 0),
            castShadow: true,
        });
        makeShape(parent, sphereMesh(UNIT_VIEW.headRadius), 0xf2d3b0, {
            name: 'Head',
            pos: new Vec3(0, UNIT_VIEW.bodyHeight + UNIT_VIEW.headRadius * 0.7, 0),
            castShadow: true,
        });

        // по силуэту видно класс: посох, лук, бочка
        if (kind === 'mage') {
            makeShape(parent, coneMesh(UNIT_VIEW.headRadius * 1.2, 0.5), tint, {
                name: 'Hat',
                pos: new Vec3(0, UNIT_VIEW.bodyHeight + UNIT_VIEW.headRadius * 1.6, 0),
            });
            makeShape(parent, cylinderMesh(0.06, 1.5), 0x8a6b45, {
                name: 'Staff',
                pos: new Vec3(0.45, 0.75, 0.1),
            });
            makeShape(parent, sphereMesh(0.16), PALETTE.projectile, {
                name: 'Orb',
                pos: new Vec3(0.45, 1.55, 0.1),
                unlit: true,
            });
        } else if (kind === 'archer') {
            makeShape(parent, boxMesh(0.08, 0.9, 0.12), 0x8a6b45, {
                name: 'Bow',
                pos: new Vec3(0.42, 0.95, 0.15),
            });
        } else {
            makeShape(parent, sphereMesh(0.26), 0x4a3b2a, {
                name: 'Bomb',
                pos: new Vec3(0.4, 0.95, 0.2),
            });
        }
    }

    clearUnits(): void {
        this.unitNodes.forEach((u) => u.node.destroy());
        this.unitNodes.clear();
    }

    // -- синхронизация с симуляцией -----------------------------------------

    /**
     * Кадр вне боя (магазин, расстановка). Без этого «шлепок» установки замирал
     * на первом кадре — юнит стоял вытянутым и тёмным до начала волны.
     */
    tickIdle(dt: number): void {
        this.idleTime += dt;
        this.unitNodes.forEach((vis, slot) => {
            if (vis.rig) {
                vis.rig.update(this.idleTime + slot * 1.7, 0);
                vis.body.setPosition(0, 0, 0);
            } else {
                const idle = Math.sin(this.idleTime * ANIM.idleSpeed + slot) * ANIM.idleAmplitude;
                vis.body.setPosition(0, idle, 0);
            }
        });
        this.updateEffects(dt);
    }

    /** Вызывается каждый кадр после sim.update(dt). */
    sync(sim: BattleSim, dt: number): void {
        this.drained.length = 0;
        sim.drainEvents(this.drained);
        for (const e of this.drained) this.handleEvent(e, sim);

        // враги
        for (const e of sim.enemies) {
            const v = this.enemyVisuals.get(e.id);
            if (!v) continue;
            v.node.setPosition(e.x, TILE.roadY, e.z);
            const dir = sim.path.dirAt(e.dist);
            v.node.setRotationFromEuler(0, math.toDegree(Math.atan2(dir.x, dir.z)), 0);
            // фаза шага берётся из пройденного пути: походка всегда совпадает
            // со скоростью и не «плывёт», когда врага замедлил маг
            const heavy = e.kind === 'grunt' ? 1 : ANIM.heavyScale;
            const phase = e.dist * ANIM.walkFrequency * heavy;
            v.body.setPosition(0, Math.abs(Math.sin(phase)) * ANIM.walkBob * heavy, 0);
            v.body.setRotationFromEuler(Math.sin(phase * 2) * ANIM.walkLean * heavy, 0, 0);

            // удар: короткое сплющивание — попадание видно, даже если полоска HP мелкая
            if (v.punch > 0) {
                v.punch = Math.max(0, v.punch - dt);
                const k = Math.sin((v.punch / JUICE.hitPunchTime) * Math.PI) * JUICE.hitSquash;
                v.body.setScale(1 + k * 0.6, 1 - k, 1 + k * 0.6);
            } else {
                v.body.setScale(1, 1, 1);
            }

            const ratio = Math.max(0, e.hp / v.maxHp);
            v.hpFill.setScale(ratio, 1, 1);
            v.hpFill.setPosition(-ENEMY_VIEW.hpBarWidth * (1 - ratio) * 0.5, 0, 0.01);
        }
        this.enemyVisuals.forEach((v, id) => {
            if (!sim.findEnemy(id)) {
                v.node.destroy();
                this.enemyVisuals.delete(id);
            }
        });

        // снаряды: летят по дуге, чтобы читался тип атаки
        for (const p of sim.projectiles) {
            let v = this.projectileVisuals.get(p.id);
            if (!v) {
                const node = this.buildProjectile(p.kind);
                v = {
                    node,
                    startX: p.ox,
                    startZ: p.oz,
                    totalDist: Math.max(0.001, Math.hypot(p.tx - p.ox, p.tz - p.oz)),
                    prevX: p.x,
                    prevY: FX.launchHeight,
                    prevZ: p.z,
                };
                this.projectileVisuals.set(p.id, v);
            }
            const travelled = Math.hypot(p.x - v.startX, p.z - v.startZ);
            const t = math.clamp01(travelled / v.totalDist);
            // навес тем выше, чем тяжелее снаряд: стрела идёт настильно, камень — дугой
            const y = FX.launchHeight + Math.sin(t * Math.PI) * FX.projectileArc * p.arc;
            v.node.setPosition(p.x, y, p.z);

            // разворачиваем по фактическому вектору полёта, включая наклон дуги
            const dx = p.x - v.prevX;
            const dy = y - v.prevY;
            const dz = p.z - v.prevZ;
            const flat = Math.hypot(dx, dz);
            if (flat > 0.0001) {
                v.node.setRotationFromEuler(
                    math.toDegree(Math.atan2(dy, flat)),
                    math.toDegree(Math.atan2(dx, dz)),
                    0
                );
            }
            v.prevX = p.x;
            v.prevY = y;
            v.prevZ = p.z;
        }
        this.projectileVisuals.forEach((v, id) => {
            if (!sim.projectiles.some((p) => p.id === id)) {
                v.node.destroy();
                this.projectileVisuals.delete(id);
            }
        });

        // юниты доворачиваются к тому, по кому стреляют
        this.idleTime += dt;
        for (const u of sim.units) {
            const vis = this.unitNodes.get(u.slot);
            if (!vis) continue;
            const dx = u.aimX - u.x;
            const dz = u.aimZ - u.z;
            if (dx * dx + dz * dz > 0.01) {
                vis.node.setRotationFromEuler(0, math.toDegree(Math.atan2(dx, dz)), 0);
            }

            // отдача после выстрела плюс лёгкое покачивание в покое
            let offset = 0;
            if (vis.recoil > 0) {
                vis.recoil = Math.max(0, vis.recoil - dt);
                const t = vis.recoil / ANIM.recoilTime;
                offset = -Math.sin(t * Math.PI) * ANIM.recoilDistance;
            }
            const idle = Math.sin(this.idleTime * ANIM.idleSpeed + u.slot) * ANIM.idleAmplitude;
            if (vis.rig) {
                // скелет сам дышит и замахивается; подпрыгивание телом тогда лишнее
                vis.attack = Math.max(0, vis.attack - dt);
                const phase = vis.attack > 0 ? 1 - vis.attack / RIG.attackTime : 0;
                vis.rig.update(this.idleTime + u.slot * 1.7, phase);
                vis.body.setPosition(0, 0, offset * 0.4);
            } else {
                vis.body.setPosition(0, idle, offset);
            }
        }

        this.updateEffects(dt);
    }

    /** Стрела — вытянутая щепка, камень — грубый кубик. */
    private buildProjectile(kind: UnitKind): Node {
        const tint = UNITS[kind].tint;
        if (kind === 'archer') {
            const node = new Node('Arrow');
            node.setParent(this.fxRoot);
            makeShape(node, boxMesh(0.07, 0.07, 0.62), 0xe8dcc0, { name: 'Shaft', unlit: true });
            makeShape(node, coneMesh(0.1, 0.22), tint, {
                name: 'Tip',
                pos: new Vec3(0, 0, 0.4),
                unlit: true,
            });
            return node;
        }
        if (kind === 'bomber') {
            return makeShape(this.fxRoot, boxMesh(0.34, 0.3, 0.32), 0x6b6259, {
                name: 'Rock',
                unlit: false,
            });
        }
        return makeShape(this.fxRoot, sphereMesh(FX.projectileRadius), tint, {
            name: 'Proj',
            unlit: true,
        });
    }

    /**
     * Молния мага: бьёт мгновенно, поэтому снаряда нет — рисуем ломаный разряд
     * от посоха до цели и гасим за пару кадров.
     */
    private spawnBeam(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
        const beam = new Node('Beam');
        beam.setParent(this.fxRoot);

        const segments = FX.beamSegments;
        const y0 = FX.beamHeight;
        let px = fromX;
        let pz = fromZ;
        let py = y0;

        for (let i = 1; i <= segments; i++) {
            const t = i / segments;
            // зигзаг затухает к цели, чтобы попадание читалось точно
            const jitter = (1 - t) * FX.beamJitter;
            const nx = fromX + (toX - fromX) * t + (Math.sin(i * 12.9898) * jitter);
            const nz = fromZ + (toZ - fromZ) * t + (Math.cos(i * 78.233) * jitter);
            const ny = y0 * (1 - t) + 0.7 * t;

            const dx = nx - px;
            const dy = ny - py;
            const dz = nz - pz;
            const len = Math.hypot(dx, dy, dz);
            const seg = makeShape(beam, boxMesh(FX.beamWidth, FX.beamWidth, len), hex, {
                name: 'Bolt',
                pos: new Vec3((px + nx) / 2, (py + ny) / 2, (pz + nz) / 2),
                unlit: true,
            });
            const flat = Math.hypot(dx, dz);
            seg.setRotationFromEuler(
                math.toDegree(Math.atan2(dy, flat)),
                math.toDegree(Math.atan2(dx, dz)),
                0
            );
            px = nx;
            py = ny;
            pz = nz;
        }

        this.effects.push({
            kind: 'flash',
            node: beam,
            life: FX.beamLife,
            maxLife: FX.beamLife,
            vel: new Vec3(),
            grow: 0,
        });
    }

    private handleEvent(e: SimEvent, sim: BattleSim): void {
        switch (e.t) {
            case 'spawn': {
                const enemy = sim.findEnemy(e.id);
                if (enemy) this.spawnEnemy(e.id, e.kind, enemy.hp, enemy.x, enemy.z);
                if (e.kind === 'boss') this.hooks.shake?.(JUICE.shakeBossSpawn);
                break;
            }
            case 'damage': {
                const v = this.enemyVisuals.get(e.id);
                if (v) v.punch = JUICE.hitPunchTime;
                break;
            }
            case 'shot': {
                Audio.play(e.kind === 'archer' ? 'arrow' : 'rock');
                const shooter = this.unitNodes.get(e.slot);
                if (shooter) {
                    shooter.recoil = ANIM.recoilTime;
                    shooter.attack = RIG.attackTime;
                }
                break;
            }
            case 'hit':
                this.burst(e.x, e.z, e.splash > 0 ? e.splash : FX.hitRadius, UNITS[e.kind].tint);
                this.sparks(e.x, e.z, UNITS[e.kind].tint);
                // камень метателя бьёт по площади — пусть это чувствуется
                if (e.splash > 0) this.hooks.shake?.(JUICE.shakeSplash);
                Audio.play('hit');
                break;
            case 'beam': {
                const caster = this.unitNodes.get(e.slot);
                if (caster) {
                    caster.recoil = ANIM.recoilTime;
                    caster.attack = RIG.attackTime;
                }
                this.spawnBeam(e.fromX, e.fromZ, e.toX, e.toZ, UNITS[e.kind].tint);
                this.burst(e.toX, e.toZ, UNITS[e.kind].splashRadius, UNITS[e.kind].tint);
                this.sparks(e.toX, e.toZ, UNITS[e.kind].tint);
                Audio.play('bolt');
                break;
            }
            case 'kill': {
                const v = this.enemyVisuals.get(e.id);
                const tint = v ? ENEMIES[v.kind].tint : 0xe8e2d6;
                if (v) this.startDeath(e.id, v);
                this.deathPuff(e.x, e.z, tint);
                if (e.bounty > 0) this.hooks.coins?.(e.x, e.z, e.bounty);
                Audio.play('enemyDie');
                break;
            }
            case 'leak':
                this.hooks.shake?.(JUICE.shakeLeak);
                this.hooks.baseHit?.();
                Audio.play('leak');
                break;
            default:
                break;
        }
    }

    private spawnEnemy(id: number, kind: EnemyKind, hp: number, x: number, z: number): void {
        const stats = ENEMIES[kind];
        const node = new Node(`Enemy_${kind}_${id}`);
        node.setParent(this.enemiesRoot);
        node.setPosition(x, TILE.roadY, z);

        const body = new Node('Body');
        body.setParent(node);

        const custom = instantiateModel(ENEMY_MODELS[kind]);
        if (custom) {
            custom.setParent(body);
        } else {
            const h = stats.radius * ENEMY_VIEW.heightPerRadius;
            makeShape(body, cylinderMesh(stats.radius, h), stats.tint, {
                name: 'Body',
                pos: new Vec3(0, h / 2, 0),
                castShadow: true,
            });
            makeShape(body, sphereMesh(stats.radius * 0.72), stats.tint, {
                name: 'Head',
                pos: new Vec3(0, h + stats.radius * 0.4, 0),
                castShadow: true,
            });
            if (kind !== 'grunt') {
                // рога — чтобы жирные враги читались мгновенно
                for (const sx of [-1, 1]) {
                    makeShape(body, coneMesh(stats.radius * 0.28, stats.radius * 1.1), 0xf0e6d2, {
                        name: 'Horn',
                        pos: new Vec3(sx * stats.radius * 0.55, h + stats.radius * 0.9, 0),
                    });
                }
            }
        }

        const barHeight = stats.radius * ENEMY_VIEW.heightPerRadius + ENEMY_VIEW.hpBarOffset;
        const bar = new Node('HpBar');
        bar.setParent(node);
        bar.setPosition(0, barHeight, 0);
        bar.setRotationFromEuler(this.billboardTilt, 0, 0);

        makeShape(bar, boxMesh(ENEMY_VIEW.hpBarWidth, ENEMY_VIEW.hpBarHeight, 0.02), PALETTE.hpBack, {
            name: 'Back',
            unlit: true,
        });
        const fill = makeShape(
            bar,
            boxMesh(ENEMY_VIEW.hpBarWidth, ENEMY_VIEW.hpBarHeight, 0.02),
            kind === 'boss' ? PALETTE.hpBoss : PALETTE.hpFill,
            { name: 'Fill', pos: new Vec3(0, 0, 0.01), unlit: true }
        );

        this.enemyVisuals.set(id, { node, body, hpFill: fill, maxHp: hp, kind, punch: 0 });
    }

    // -- эффекты -------------------------------------------------------------

    private burst(x: number, z: number, radius: number, hex: number): void {
        const node = makeShape(this.fxRoot, sphereMesh(Math.max(0.2, radius * 0.6)), hex, {
            name: 'Burst',
            pos: new Vec3(x, TILE.roadY + 0.7, z),
            unlit: true,
        });
        node.setScale(0.4, 0.4, 0.4);
        this.effects.push({
            kind: 'burst',
            node,
            life: FX.hitLife,
            maxLife: FX.hitLife,
            vel: new Vec3(),
            grow: 1.8,
        });
    }

    /**
     * Враг не исчезает в тот же кадр, а «лопается»: узел забираем из списка
     * живых (симуляция его уже удалила) и доигрываем смерть эффектом.
     */
    private startDeath(id: number, v: EnemyVisual): void {
        this.enemyVisuals.delete(id);
        const bar = v.hpFill.parent;
        if (bar) bar.active = false;
        v.body.setScale(1, 1, 1);
        this.effects.push({
            kind: 'die',
            node: v.node,
            life: JUICE.dieTime,
            maxLife: JUICE.dieTime,
            vel: new Vec3(),
            grow: 0,
        });
    }

    /** Кубики-искры цвета атакующего: читается, кто попал. */
    private sparks(x: number, z: number, hex: number): void {
        for (let i = 0; i < JUICE.sparkCount; i++) {
            const angle = (i / JUICE.sparkCount) * Math.PI * 2 + Math.random() * 0.6;
            const up = 0.6 + Math.random() * 0.8;
            const node = makeShape(this.fxRoot, boxMesh(JUICE.sparkSize, JUICE.sparkSize, JUICE.sparkSize), hex, {
                name: 'Spark',
                pos: new Vec3(x, TILE.roadY + 0.7, z),
                unlit: true,
            });
            this.effects.push({
                kind: 'spark',
                node,
                life: JUICE.sparkLife,
                maxLife: JUICE.sparkLife,
                vel: new Vec3(
                    Math.cos(angle) * JUICE.sparkSpeed,
                    up * JUICE.sparkSpeed * 0.5,
                    Math.sin(angle) * JUICE.sparkSpeed
                ),
                grow: 0,
            });
        }
    }

    private deathPuff(x: number, z: number, hex = 0xe8e2d6): void {
        for (let i = 0; i < JUICE.dieDebris; i++) {
            const angle = (i / JUICE.dieDebris) * Math.PI * 2;
            // половина осколков цвета врага, половина светлая — пыль и «куски»
            const color = i % 2 === 0 ? hex : 0xe8e2d6;
            const node = makeShape(this.fxRoot, boxMesh(0.18, 0.18, 0.18), color, {
                name: 'Debris',
                pos: new Vec3(x, TILE.roadY + 0.5, z),
                unlit: true,
            });
            this.effects.push({
                kind: 'debris',
                node,
                life: FX.deathLife,
                maxLife: FX.deathLife,
                vel: new Vec3(Math.cos(angle) * 2.2, 3.0, Math.sin(angle) * 2.2),
                grow: 0,
            });
        }
    }

    private updateEffects(dt: number): void {
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            if (!fx.node.isValid) {
                this.effects.splice(i, 1);
                continue;
            }
            fx.life -= dt;
            const t = Math.max(0, fx.life / fx.maxLife);

            switch (fx.kind) {
                case 'burst': {
                    const s = 0.4 + (1 - t) * fx.grow;
                    fx.node.setScale(s, s, s);
                    break;
                }
                case 'debris': {
                    const p = fx.node.position;
                    fx.vel.y -= 9.8 * dt;
                    fx.node.setPosition(
                        p.x + fx.vel.x * dt,
                        Math.max(0.05, p.y + fx.vel.y * dt),
                        p.z + fx.vel.z * dt
                    );
                    fx.node.setScale(t, t, t);
                    break;
                }
                case 'flash': {
                    fx.node.setScale(1, t, t);
                    break;
                }
                case 'spark': {
                    const p = fx.node.position;
                    fx.vel.y -= 4 * dt;
                    fx.node.setPosition(p.x + fx.vel.x * dt, p.y + fx.vel.y * dt, p.z + fx.vel.z * dt);
                    fx.node.setScale(t, t, t);
                    break;
                }
                case 'die': {
                    // сначала подскок-раздувание, потом проседание в землю
                    const k = 1 - t;
                    const puff = Math.sin(Math.min(1, k * 2.2) * Math.PI) * 0.25;
                    const sink = Math.max(0, k - 0.35) / 0.65;
                    fx.node.setScale(1 + puff, Math.max(0.01, (1 + puff) * (1 - sink)), 1 + puff);
                    break;
                }
                case 'pop': {
                    const k = 1 - t;
                    fx.node.setScale(0.4 + 0.6 * k, 1.5 - 0.5 * k, 0.4 + 0.6 * k);
                    break;
                }
            }

            if (fx.life <= 0) {
                if (fx.kind === 'pop') fx.node.setScale(1, 1, 1);
                else fx.node.destroy();
                this.effects.splice(i, 1);
            }
        }
    }

    /** Полная очистка между попытками. */
    reset(): void {
        this.enemyVisuals.forEach((v) => v.node.destroy());
        this.enemyVisuals.clear();
        this.projectileVisuals.forEach((v) => v.node.destroy());
        this.projectileVisuals.clear();
        // чистим только «одноразовые» эффекты: узлы юнитов тоже сидят в списке
        // (анимация установки) и переживать волну обязаны
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            if (fx.kind === 'pop') continue; // это узлы юнитов, они переживают волну
            if (fx.node.isValid) fx.node.destroy();
            this.effects.splice(i, 1);
        }
    }
}
