import {
    AnimationClip,
    AnimationState,
    Material,
    Mesh,
    Node,
    SkeletalAnimation,
    Vec3,
    instantiate,
    math,
    utils,
} from 'cc';
import type { BattleSim } from '../../Sim/BattleSim';
import type { EnemyKind, SimEvent, UnitKind } from '../../Sim/SimTypes';
import { ENEMIES, UNITS } from '../../Sim/Balance';
import { ANIM, ENEMY_VIEW, FX, HIT_FX, JUICE, PALETTE, RIG, TILE, UNIT_VIEW } from '../ViewConfig';
import {
    ENEMY_MODELS,
    TEXTURES,
    UNIT_MODELS,
    WEAPON_MODELS,
    getPrefab,
    getTexture,
    instantiateModel,
} from '../AssetSlots';
import {
    boxMesh,
    colorOf,
    coneMesh,
    createMaterial,
    cylinderMesh,
    getMaterial,
    makeShape,
    quadMesh,
    sphereMesh,
    tileMesh,
} from './Prims';
import { Audio } from '../Services/Audio';
import { RigAnimator } from './RigAnimator';

interface EnemyVisual {
    node: Node;
    /** отдельный узел под модель: анимируем его, чтобы полоска HP не прыгала */
    body: Node;
    hpFill: Node;
    /** ширина заливки при полном HP — от неё считается сдвиг при убывании */
    hpWidth: number;
    maxHp: number;
    kind: EnemyKind;
    /** сколько осталось от «сплющивания» после удара, сек */
    punch: number;
    /** шаг по костям, если у модели есть риг, но нет клипа */
    rig: RigAnimator | null;
    /** готовый клип ходьбы/бега из Mixamo — у гоблина и голема */
    clip: AnimationState | null;
    /** пройденный путь в прошлом кадре — по нему считаем реальную скорость */
    lastDist: number;
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
    /** боевая стойка 0..1: плавно растёт, пока у юнита есть цель */
    aim: number;
    /** длительность цикла атаки этого юнита, сек */
    attackDur: number;
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
    | 'die'
    /** спрайт-вспышка: растёт и гаснет (стрела, пыль, разряд) */
    | 'sprite'
    /** молния: мерцает вариантами и гаснет */
    | 'bolt';

interface Effect {
    kind: EffectKind;
    node: Node;
    life: number;
    maxLife: number;
    vel: Vec3;
    grow: number;
    /** свой материал эффекта — им гасим прозрачность */
    mat?: Material;
    hex?: number;
    size?: number;
    /** что освободить в конце (динамические меши молнии) */
    meshes?: Mesh[];
    flicker?: number;
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

        // лучник натягивает тетиву весь промежуток между выстрелами, остальным хватает общего замаха
        const attackDur = kind === 'archer' ? UNITS.archer.attackInterval * 0.85 : RIG.attackTime;
        this.unitNodes.set(slot, { node, body, recoil: 0, rig, attack: 0, aim: 0, attackDur });
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
            // вне боя стойка плавно расслабляется
            vis.aim = Math.max(0, vis.aim - dt * RIG.aimBlendSpeed * 0.5);
            if (vis.rig) {
                vis.rig.update(this.idleTime + slot * 1.7, 0, vis.aim);
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
            if (v.clip) {
                // клип играет со скоростью, пропорциональной реальной скорости врага:
                // замедленный магом и бежит медленнее — ноги не скользят по земле
                const actual = dt > 0 ? Math.max(0, e.dist - v.lastDist) / dt : 0;
                const k = actual / ENEMIES[e.kind].speed;
                const target = math.clamp(k, 0.15, 2.5) * ENEMY_VIEW.clipSpeed;
                // симуляция идёт фиксированными шагами: за кадр бывает 0 или 2 шага,
                // и скорость по одному кадру скачет — сглаживаем, иначе клип дёргается
                v.clip.speed += (target - v.clip.speed) * Math.min(1, dt * 8);
                v.body.setPosition(0, 0, 0);
            } else if (v.rig) {
                // со скелетом шагают ноги; телом только слегка покачиваемся на шаге
                v.rig.walk(phase, e.kind === 'boss' ? 1 : 0);
                v.body.setPosition(0, Math.abs(Math.sin(phase)) * ANIM.walkBob * 0.3, 0);
            } else {
                v.body.setPosition(0, Math.abs(Math.sin(phase)) * ANIM.walkBob * heavy, 0);
                v.body.setRotationFromEuler(Math.sin(phase * 2) * ANIM.walkLean * heavy, 0, 0);
            }

            // удар: короткое сплющивание — попадание видно, даже если полоска HP мелкая
            if (v.punch > 0) {
                v.punch = Math.max(0, v.punch - dt);
                const k = Math.sin((v.punch / JUICE.hitPunchTime) * Math.PI) * JUICE.hitSquash;
                v.body.setScale(1 + k * 0.6, 1 - k, 1 + k * 0.6);
            } else {
                v.body.setScale(1, 1, 1);
            }

            v.lastDist = e.dist;

            const ratio = Math.max(0, e.hp / v.maxHp);
            const fy = v.hpFill.position.y;
            const fz = v.hpFill.position.z;
            v.hpFill.setScale(ratio, 1, 1);
            v.hpFill.setPosition(-v.hpWidth * (1 - ratio) * 0.5, fy, fz);
            // враг разворачивается по ходу, а полоска должна всегда смотреть в камеру:
            // иначе на поперечных участках дороги она видна ребром
            v.hpFill.parent?.setWorldRotationFromEuler(this.billboardTilt, 0, 0);
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
            const hasTarget = dx * dx + dz * dz > 0.01;
            if (hasTarget) {
                vis.node.setRotationFromEuler(0, math.toDegree(Math.atan2(dx, dz)), 0);
            }
            vis.aim += ((hasTarget ? 1 : 0) - vis.aim) * Math.min(1, dt * RIG.aimBlendSpeed);

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
                const phase = vis.attack > 0 ? 1 - vis.attack / vis.attackDur : 0;
                vis.rig.update(this.idleTime + u.slot * 1.7, phase, vis.aim);
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
            // стрела летит вдоль +Z: древко, наконечник по направлению полёта, оперение
            const node = new Node('Arrow');
            node.setParent(this.fxRoot);
            makeShape(node, boxMesh(0.05, 0.05, 0.7), 0x8a5a33, { name: 'Shaft' });
            const tip = makeShape(node, coneMesh(0.075, 0.2, 6), 0xd8dde3, {
                name: 'Tip',
                pos: new Vec3(0, 0, 0.44),
            });
            // конус строится вдоль Y — кладём его остриём вперёд
            tip.setRotationFromEuler(90, 0, 0);
            for (const rz of [0, 90]) {
                const fin = makeShape(node, boxMesh(0.2, 0.012, 0.16), tint, {
                    name: 'Fletch',
                    pos: new Vec3(0, 0, -0.3),
                });
                fin.setRotationFromEuler(0, 0, rz);
            }
            return node;
        }
        if (kind === 'bomber') {
            // летит тот же валун, что был в руке у метателя
            const prefab = getPrefab({ prefab: WEAPON_MODELS.bomber.prefab, approxHeight: 0 });
            if (prefab) {
                const node = new Node('Rock');
                node.setParent(this.fxRoot);
                const rock = instantiate(prefab);
                rock.setParent(node);
                rock.setScale(HIT_FX.rockScale, HIT_FX.rockScale, HIT_FX.rockScale);
                return node;
            }
            return makeShape(this.fxRoot, boxMesh(0.34, 0.3, 0.32), 0x6b6259, { name: 'Rock' });
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
    /**
     * Молния мага: светящаяся лента по ломаной, развёрнутая к камере, плюс ветка.
     * Строим несколько вариантов с разным изломом и переключаем их — молния
     * «дрожит», а не висит застывшей палкой. Нет текстуры — старые палочки.
     */
    private spawnBeam(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
        const tex = getTexture(TEXTURES.fxBolt);
        if (!tex) {
            this.spawnBeamSticks(fromX, fromZ, toX, toZ, hex);
            return;
        }
        const beam = new Node('Bolt');
        beam.setParent(this.fxRoot);
        const mat = createMaterial(HIT_FX.boltColor, { unlit: true, texture: tex, additive: true, doubleSided: true });
        const y0 = TILE.grassY + UNIT_VIEW.padHeight + FX.beamHeight;
        const from = new Vec3(fromX, y0, fromZ);
        const to = new Vec3(toX, 0.8, toZ);
        const meshes: Mesh[] = [];

        for (let v = 0; v < HIT_FX.boltVariants; v++) {
            const seed = Math.random() * 1000;
            const main = this.zigzag(from, to, FX.beamSegments + 2, FX.beamJitter, seed);
            // ветка отходит от середины в сторону и гаснет на полпути
            const mid = main[Math.floor(main.length / 2)];
            const side = new Vec3(
                mid.x + (Math.sin(seed) * 0.9),
                mid.y - 0.4,
                mid.z + (Math.cos(seed) * 0.9)
            );
            const branch = this.zigzag(mid, side, 3, FX.beamJitter * 0.6, seed + 7);
            const mesh = this.ribbon([
                { pts: main, width: HIT_FX.boltWidth },
                { pts: branch, width: HIT_FX.branchWidth },
            ]);
            meshes.push(mesh);
            const node = makeShape(beam, mesh, 0, { name: `Variant${v}`, material: mat });
            node.active = v === 0;
        }

        this.effects.push({
            kind: 'bolt',
            node: beam,
            life: HIT_FX.boltLife,
            maxLife: HIT_FX.boltLife,
            vel: new Vec3(),
            grow: 0,
            mat,
            hex: HIT_FX.boltColor,
            meshes,
            flicker: 0,
        });
    }

    /** Ломаная от a к b: излом сильнее в середине, к концам сходит на нет. */
    private zigzag(a: Vec3, b: Vec3, segments: number, jitter: number, seed: number): Vec3[] {
        const pts: Vec3[] = [a.clone()];
        for (let i = 1; i < segments; i++) {
            const t = i / segments;
            const k = Math.sin(t * Math.PI) * jitter;
            pts.push(
                new Vec3(
                    a.x + (b.x - a.x) * t + Math.sin(seed + i * 12.9898) * k,
                    a.y + (b.y - a.y) * t + Math.sin(seed * 0.7 + i * 4.1) * k * 0.5,
                    a.z + (b.z - a.z) * t + Math.cos(seed + i * 78.233) * k
                )
            );
        }
        pts.push(b.clone());
        return pts;
    }

    /** Лента вдоль ломаных, развёрнутая к камере: ширина — поперёк взгляда. */
    private ribbon(strips: { pts: Vec3[]; width: number }[]): Mesh {
        const tilt = math.toRadian(-this.billboardTilt);
        const view = new Vec3(0, -Math.sin(tilt), Math.cos(tilt));
        const positions: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const dir = new Vec3();
        const side = new Vec3();
        for (const strip of strips) {
            const base = positions.length / 3;
            const n = strip.pts.length;
            strip.pts.forEach((p, i) => {
                const a = strip.pts[Math.max(0, i - 1)];
                const b = strip.pts[Math.min(n - 1, i + 1)];
                Vec3.subtract(dir, b, a);
                Vec3.cross(side, dir, view);
                side.normalize();
                // к концу лента сужается — молния «втыкается» в цель
                const w = strip.width * 0.5 * (0.35 + 0.65 * (1 - i / (n - 1)));
                positions.push(p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
                positions.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
                const u = i / (n - 1);
                uvs.push(u, 0, u, 1);
                if (i > 0) {
                    const q = base + (i - 1) * 2;
                    indices.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
                }
            });
        }
        return utils.MeshUtils.createMesh({ positions, uvs, indices });
    }

    /** Спрайт-вспышка, развёрнутый к камере. */
    private sprite(path: string, x: number, y: number, z: number, size: number, hex: number, life: number): void {
        const tex = getTexture(path);
        if (!tex) return;
        const mat = createMaterial(hex, { unlit: true, texture: tex, additive: true, doubleSided: true });
        // внешний узел смотрит в камеру, квадрат внутри крутится в своей плоскости —
        // вспышки не одинаковые, а разворот к камере не перекашивается
        const node = new Node('Sprite');
        node.setParent(this.fxRoot);
        node.setPosition(x, y, z);
        node.setRotationFromEuler(this.billboardTilt, 0, 0);
        const quad = makeShape(node, quadMesh(1), 0, { name: 'Quad', material: mat });
        quad.setRotationFromEuler(0, 0, Math.random() * 360);
        node.setScale(size * 0.5, size * 0.5, 1);
        this.effects.push({ kind: 'sprite', node, life, maxLife: life, vel: new Vec3(), grow: 0.8, mat, hex, size });
    }

    /** Спрайт, лежащий на земле (кольцо пыли от камня). */
    private groundSprite(path: string, x: number, z: number, size: number, hex: number, life: number): void {
        const tex = getTexture(path);
        if (!tex) return;
        const mat = createMaterial(hex, { unlit: true, texture: tex, alpha: 254, doubleSided: true });
        const node = makeShape(this.fxRoot, tileMesh([{ x: 0, z: 0, y: 0, size: 1 }]), 0, {
            name: 'GroundSprite',
            pos: new Vec3(x, TILE.roadY + 0.05, z),
            material: mat,
        });
        node.setRotationFromEuler(0, Math.random() * 360, 0);
        node.setScale(size * 0.4, 1, size * 0.4);
        this.effects.push({ kind: 'sprite', node, life, maxLife: life, vel: new Vec3(), grow: 0.6, mat, hex, size: -size });
    }

    /** Старая молния из палочек — запасной вариант, если нет текстуры. */
    private spawnBeamSticks(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
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
                    shooter.attack = shooter.attackDur;
                }
                break;
            }
            case 'hit':
                if (e.splash > 0) {
                    // камень: кольцо пыли по земле и короткая вспышка
                    this.groundSprite(TEXTURES.fxDust, e.x, e.z, e.splash * HIT_FX.dustScale, 0xffffff, HIT_FX.dustLife);
                    this.sprite(TEXTURES.fxImpact, e.x, 0.6, e.z, HIT_FX.impactSize * 0.7, 0xffd9a0, HIT_FX.impactLife);
                } else {
                    this.sprite(TEXTURES.fxImpact, e.x, 0.8, e.z, HIT_FX.impactSize, 0xffffff, HIT_FX.impactLife);
                }
                this.sparks(e.x, e.z, UNITS[e.kind].tint);
                // камень метателя бьёт по площади — пусть это чувствуется
                if (e.splash > 0) this.hooks.shake?.(JUICE.shakeSplash);
                Audio.play('hit');
                break;
            case 'beam': {
                const caster = this.unitNodes.get(e.slot);
                if (caster) {
                    caster.recoil = ANIM.recoilTime;
                    caster.attack = caster.attackDur;
                }
                this.spawnBeam(e.fromX, e.fromZ, e.toX, e.toZ, UNITS[e.kind].tint);
                const r = UNITS[e.kind].splashRadius;
                this.sprite(TEXTURES.fxElectric, e.toX, 0.8, e.toZ, r * HIT_FX.electricScale, 0xffffff, HIT_FX.electricLife);
                this.sprite(
                    TEXTURES.fxElectric,
                    e.fromX,
                    TILE.grassY + UNIT_VIEW.padHeight + FX.beamHeight,
                    e.fromZ,
                    HIT_FX.castFlashSize,
                    0xffffff,
                    HIT_FX.electricLife * 0.7
                );
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
        let rig: RigAnimator | null = null;
        let clip: AnimationState | null = null;
        if (custom) {
            custom.setParent(body);
            clip = this.playClip(custom);
            // клипа нет, но есть скелет — шагаем процедурно
            if (!clip) rig = RigAnimator.tryCreate(custom, kind);
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

        const fillHex = kind === 'boss' ? PALETTE.hpBoss : PALETTE.hpFill;
        const frameTex = getTexture(TEXTURES.hpFrame);
        const fillTex = getTexture(TEXTURES.hpFill);
        let fill: Node;
        let hpWidth = ENEMY_VIEW.hpBarWidth;

        if (frameTex && fillTex) {
            const k = kind === 'boss' ? ENEMY_VIEW.bossBarScale : 1;
            const fw = ENEMY_VIEW.hpBarWidth * 1.12 * k;
            const fh = fw / ENEMY_VIEW.frameAspect;
            // рамка — сзади, полупрозрачная; заливка — ближе к камере и непрозрачная,
            // поэтому тёмный паз рамки её не перекрывает
            const frame = makeShape(bar, quadMesh(1), 0, {
                name: 'Frame',
                material: getMaterial(0xffffff, { unlit: true, texture: frameTex, alpha: 254, doubleSided: true }),
            });
            frame.setScale(fw, fh, 1);
            hpWidth = fw * ENEMY_VIEW.slotWidth;
            const fillNode = new Node('Fill');
            fillNode.setParent(bar);
            fillNode.setPosition(0, fh * ENEMY_VIEW.slotOffsetY, -0.01);
            const quad = makeShape(fillNode, quadMesh(1), 0, {
                name: 'Quad',
                material: getMaterial(fillHex, { unlit: true, texture: fillTex, doubleSided: true }),
            });
            quad.setScale(hpWidth, fh * ENEMY_VIEW.slotHeight, 1);
            fill = fillNode;

            const skullTex = kind === 'boss' ? getTexture(TEXTURES.hpSkull) : null;
            if (skullTex) {
                const skull = makeShape(bar, quadMesh(1), 0, {
                    name: 'Skull',
                    pos: new Vec3(-fw * 0.5 - fh * 0.3, 0, -0.02),
                    material: getMaterial(0xffffff, { unlit: true, texture: skullTex, alpha: 254, doubleSided: true }),
                });
                skull.setScale(fh * 1.9, fh * 1.9, 1);
            }
        } else {
            makeShape(bar, boxMesh(ENEMY_VIEW.hpBarWidth, ENEMY_VIEW.hpBarHeight, 0.02), PALETTE.hpBack, {
                name: 'Back',
                unlit: true,
            });
            fill = makeShape(bar, boxMesh(ENEMY_VIEW.hpBarWidth, ENEMY_VIEW.hpBarHeight, 0.02), fillHex, {
                name: 'Fill',
                pos: new Vec3(0, 0, 0.01),
                unlit: true,
            });
        }

        this.enemyVisuals.set(id, {
            node,
            body,
            hpFill: fill,
            hpWidth,
            maxHp: hp,
            kind,
            punch: 0,
            rig,
            clip,
            lastDist: 0,
        });
    }

    /**
     * Запустить клип модели по кругу (ходьба/бег из Mixamo). Клипы «In Place» —
     * без смещения бёдер, двигает врага сама симуляция. Стартовая фаза случайная,
     * иначе толпа гоблинов бежит строго в ногу.
     */
    private playClip(model: Node): AnimationState | null {
        const anim = model.getComponentInChildren(SkeletalAnimation);
        const clip = anim?.clips.find((c) => !!c) ?? null;
        if (!anim || !clip) return null;
        clip.wrapMode = AnimationClip.WrapMode.Loop;
        anim.play(clip.name);
        const state = anim.getState(clip.name);
        if (!state) return null;
        state.wrapMode = AnimationClip.WrapMode.Loop;
        state.time = Math.random() * state.duration;
        return state;
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
                case 'sprite': {
                    // растёт и гаснет; size < 0 — спрайт лежит на земле (масштаб по XZ)
                    const k = 1 - t;
                    const s = Math.abs(fx.size ?? 1) * (0.5 + k * fx.grow);
                    if ((fx.size ?? 1) < 0) fx.node.setScale(s, 1, s);
                    else fx.node.setScale(s, s, 1);
                    fx.mat?.setProperty('mainColor', colorOf(fx.hex ?? 0xffffff, Math.round(255 * Math.min(1, t * 1.6))));
                    break;
                }
                case 'bolt': {
                    // мерцание: каждые boltFlicker секунд показываем другой вариант излома
                    fx.flicker = (fx.flicker ?? 0) + dt;
                    const step = Math.floor(fx.flicker / HIT_FX.boltFlicker);
                    fx.node.children.forEach((c, i) => (c.active = i === step % fx.node.children.length));
                    fx.mat?.setProperty('mainColor', colorOf(fx.hex ?? 0xffffff, Math.round(255 * Math.min(1, t * 1.8))));
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
                // динамические меши молнии держат буферы на GPU — освобождаем явно
                fx.meshes?.forEach((m) => m.destroy());
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
