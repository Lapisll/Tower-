import { Material, MeshRenderer, Node, Vec3, Vec4, math } from 'cc';
import { ARENA, PATH, SLOT_POSITIONS } from '../../Sim/Balance';

/** Детерминированный шум по координатам тайла. */
function hash2(a: number, b: number): number {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
}
import { DECOR, PALETTE, PORTAL, SLOT_VIEW, TEX_TINT, TILE, UNIT_VIEW, WATER } from '../ViewConfig';
import {
    DECOR_MODELS,
    DecorKind,
    PROP_MODELS,
    TEXTURES,
    getPrefab,
    getTexture,
    instantiateModel,
} from '../AssetSlots';
import {
    blockMesh,
    boxMesh,
    colorOf,
    coneMesh,
    createMaterial,
    cylinderMesh,
    darken,
    makeShape,
    tileMesh,
    tintShape,
} from './Prims';

/**
 * Статика арены: земля, дорога, площадки под юнитов, замок, ворота спавна.
 * Всё строится из примитивов по данным из Balance — если поменять PATH_POINTS
 * или слоты, сцена перестроится сама, руками в редакторе двигать нечего.
 */
export class ArenaView {
    readonly root: Node;
    readonly slotNodes: Node[] = [];
    private readonly slotTaken: boolean[] = [];
    /** части слота: постамент и круг на нём */
    private readonly slotParts: { pedestal: Node; ring: Node }[] = [];
    private ringIdleMat: Material | null = null;
    private ringHotMat: Material | null = null;
    private ringAngle = 0;
    /** сколько площадок открыто — остальные спрятаны до своей волны */
    private unlocked = 0;
    private pulse = 0;
    private pulsing = false;
    /** высота верха травяного блока по ключу "c,r"; у дороги записи нет */
    private readonly grassTop = new Map<string, number>();
    /** тайлы, где уже стоит скала, — декор на них не ставим */
    private readonly blocked = new Set<string>();
    private grid = { cols: 0, rows: 0, centerZ: 0 };

    // анимация окружения
    private time = 0;
    private waterMat: Material | null = null;
    private foamMat: Material | null = null;
    private portalMat: Material | null = null;
    private readonly sparks: { node: Node; phase: number; x: number; z: number }[] = [];

    constructor(parent: Node) {
        this.root = new Node('Arena');
        this.root.setParent(parent);

        this.buildGround();
        this.buildWater();
        this.buildSlots();
        this.buildBase();
        this.buildGate();
        this.buildProps();
        this.buildDecor();
    }

    // -- слоты ---------------------------------------------------------------

    setSlotTaken(index: number, taken: boolean): void {
        this.slotTaken[index] = taken;
        this.paintSlot(index, false);
    }

    /** Открыть первые `count` площадок; новые появляются с подскоком. */
    setUnlockedCount(count: number): number[] {
        const opened: number[] = [];
        for (let i = 0; i < this.slotNodes.length; i++) {
            const open = i < count;
            if (open && !this.slotNodes[i].active) opened.push(i);
            this.slotNodes[i].active = open;
        }
        this.unlocked = count;
        return opened;
    }

    /** Подсветить свободные площадки, когда игрок выбрал юнита в магазине. */
    highlightFree(on: boolean): void {
        this.pulsing = on;
        for (let i = 0; i < this.unlocked; i++) {
            if (!this.slotTaken[i]) this.paintSlot(i, on);
        }
        if (!on) {
            for (const part of this.slotParts) part.ring.setScale(1, 1, 1);
        }
    }

    /** Пульсация подсвеченных площадок: статичную плиту на пёстром поле не видно. */
    tick(dt: number): void {
        this.tickEnvironment(dt);

        // круги всегда медленно крутятся; когда герой выбран — быстрее и с пульсом
        this.ringAngle += dt * (this.pulsing ? SLOT_VIEW.ringHotSpin : SLOT_VIEW.ringIdleSpin);
        if (this.pulsing) this.pulse += dt * SLOT_VIEW.ringHotSpeed;
        const k = this.pulsing ? 1 + Math.sin(this.pulse) * SLOT_VIEW.ringHotPulse : 1;
        for (let i = 0; i < this.unlocked; i++) {
            const ring = this.slotParts[i]?.ring;
            if (!ring || !ring.active) continue;
            ring.setRotationFromEuler(0, this.ringAngle, 0);
            ring.setScale(k, 1, k);
        }
    }

    private paintSlot(index: number, hot: boolean): void {
        const part = this.slotParts[index];
        if (!part) return;
        const taken = this.slotTaken[index];
        tintShape(part.pedestal, taken ? SLOT_VIEW.pedestalTaken : SLOT_VIEW.pedestalColor);

        const tex = getTexture(TEXTURES.slotRing);
        if (tex) {
            // занятый слот без круга: место уже не предлагается
            part.ring.active = !taken;
            const mat = hot ? this.ringHotMat : this.ringIdleMat;
            const mr = part.ring.getComponent(MeshRenderer);
            if (mr && mat) mr.material = mat;
        } else {
            // без текстуры — старая подсветка цветом
            part.ring.active = false;
            const hex = taken ? PALETTE.slotTaken : hot ? PALETTE.slotHover : SLOT_VIEW.pedestalColor;
            tintShape(part.pedestal, hex, { unlit: hot });
        }
    }

    /** Ближайший свободный слот к точке на земле, либо -1. */
    pickSlot(worldX: number, worldZ: number, maxDist = 2.2): number {
        let best = -1;
        let bestD = maxDist * maxDist;
        for (let i = 0; i < this.unlocked; i++) {
            if (this.slotTaken[i]) continue;
            const p = SLOT_POSITIONS[i];
            const dx = p.x - worldX;
            const dz = p.z - worldZ;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }

    // -- построение ----------------------------------------------------------

    /**
     * Блочный ландшафт: арена нарезана на тайлы 1x1, тайлы дороги утоплены.
     * Тайлы одного типа склеены в общий меш — вся земля это 3 драукола,
     * а не три сотни нод.
     */
    /**
     * Блочный ландшафт: арена нарезана на кубы 1x1. Травяные блоки подняты,
     * блоки дороги утоплены — получается «лабиринт», по канавам которого идут
     * враги, а юниты стоят сверху на блоках.
     * Блоки одного типа склеены в общий меш: вся земля это 4 драукола.
     */
    private buildGround(): void {
        const size = TILE.size;
        const cols = Math.round(ARENA.width / size);
        const rows = Math.round(ARENA.depth / size);
        const centerZ = (ARENA.spawnPos.z + ARENA.basePos.z) / 2;
        this.grid = { cols, rows, centerZ };

        type Block = { x: number; z: number; size: number; top: number; bottom: number };
        const grass: Block[] = [];
        const grassAlt: Block[] = [];
        const road: Block[] = [];
        const roadAlt: Block[] = [];

        // путь сэмплим один раз — иначе расстояние до дороги считалось бы
        // заново для каждого из трёх сотен блоков
        const samples: { x: number; z: number }[] = [];
        for (let d = 0; d <= PATH.total; d += 0.25) samples.push(PATH.posAt(d));
        const halfRoad = ARENA.roadWidth / 2;

        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                const x = (c - (cols - 1) / 2) * size;
                const z = centerZ + (r - (rows - 1) / 2) * size;

                let near = Infinity;
                for (const p of samples) {
                    const dx = p.x - x;
                    const dz = p.z - z;
                    const dd = dx * dx + dz * dz;
                    if (dd < near) near = dd;
                }
                const onRoad = Math.sqrt(near) <= halfRoad;
                const checker = (c + r) % 2 === 0;

                // ступеньки по высоте: ровная плита выглядит как стол,
                // а воксельный ландшафт должен слегка «дышать»
                const jitter = onRoad
                    ? 0
                    : (hash2(c, r) < 0.34 ? TILE.heightJitter : 0) -
                      (hash2(c + 91, r + 17) < 0.2 ? TILE.heightJitter : 0);

                const block: Block = {
                    x,
                    z,
                    size,
                    top: (onRoad ? TILE.roadY : TILE.grassY) + jitter,
                    bottom: TILE.bottomY,
                };

                if (onRoad) (checker ? road : roadAlt).push(block);
                else {
                    (checker ? grass : grassAlt).push(block);
                    this.grassTop.set(`${c},${r}`, block.top);
                }
            }
        }

        const ground = new Node('Ground');
        ground.setParent(this.root);
        // верх и бока — разными мешами: бока темнее, и блоки читаются кубами
        // разброс яркости по блокам: детерминированный, по координатам
        const shade = (b: { x: number; z: number }) =>
            1 - hash2(b.x * 3.1 + 7, b.z * 1.7 + 3) * TEX_TINT.shadeJitter;
        type Skin = { tex: string; tint: number };
        const layer = (blocks: Block[], hex: number, name: string, top: Skin, side: Skin) => {
            if (blocks.length === 0) return;
            const topTex = getTexture(top.tex);
            const sideTex = getTexture(side.tex);
            // нет текстуры — старый плоский цвет, чтобы сцена не развалилась
            makeShape(ground, blockMesh(blocks, 'top', { shade }), topTex ? top.tint : hex, {
                name,
                receiveShadow: true,
                texture: topTex,
                vertexColor: true,
            });
            makeShape(
                ground,
                blockMesh(blocks, 'side', { shade, sideSpan: TEX_TINT.sideSpan }),
                sideTex ? side.tint : darken(hex, TILE.sideDarken),
                { name: `${name}Side`, receiveShadow: true, texture: sideTex, vertexColor: true }
            );
        };
        const grassTop = (tint: number): Skin => ({ tex: TEXTURES.grassTop, tint });
        const roadTop = (tint: number): Skin => ({ tex: TEXTURES.roadTop, tint });
        const grassSide: Skin = { tex: TEXTURES.grassSide, tint: TEX_TINT.grassSide };
        const roadSide: Skin = { tex: TEXTURES.dirt, tint: TEX_TINT.roadSide };
        layer(grass, PALETTE.ground, 'Grass', grassTop(TEX_TINT.grass), grassSide);
        layer(grassAlt, PALETTE.groundAlt, 'GrassAlt', grassTop(TEX_TINT.grassAlt), grassSide);
        layer(road, PALETTE.road, 'Road', roadTop(TEX_TINT.road), roadSide);
        layer(roadAlt, PALETTE.roadAlt, 'RoadAlt', roadTop(TEX_TINT.roadAlt), roadSide);

        this.buildRocks(ground, cols, rows, centerZ, samples);
    }

    private buildRocks(
        parent: Node,
        cols: number,
        rows: number,
        centerZ: number,
        samples: { x: number; z: number }[]
    ): void {
        const size = TILE.size;
        // детерминированный псевдослучай: картинка не должна меняться между запусками
        let seed = 1337;
        const rnd = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        };

        for (let i = 0; i < TILE.rockCount; i++) {
            const edge = Math.floor(rnd() * 4);
            let c = Math.floor(rnd() * cols);
            let r = Math.floor(rnd() * rows);
            if (edge === 0) r = 0;
            else if (edge === 1) r = rows - 1;
            else if (edge === 2) c = 0;
            else c = cols - 1;

            const x = (c - (cols - 1) / 2) * size;
            const z = centerZ + (r - (rows - 1) / 2) * size;

            // на дорогу и на площадки камни не ставим
            let near = Infinity;
            for (const p of samples) {
                const dx = p.x - x;
                const dz = p.z - z;
                near = Math.min(near, dx * dx + dz * dz);
            }
            if (Math.sqrt(near) < ARENA.roadWidth) continue;
            if (SLOT_POSITIONS.some((sp) => Math.hypot(sp.x - x, sp.z - z) < 2)) continue;

            this.blocked.add(`${c},${r}`);

            // есть модель камня — ставим крупный валун вместо столба из блоков:
            // тёмные столбы на скрине читались как надгробия
            if (getPrefab(DECOR_MODELS.stone)) {
                const stone = instantiateModel(DECOR_MODELS.stone);
                if (stone) {
                    const holder = new Node('Boulder');
                    holder.setParent(parent);
                    const k = TILE.boulderScale * (0.8 + rnd() * 0.4);
                    holder.setPosition(x, this.grassTop.get(`${c},${r}`) ?? TILE.grassY, z);
                    holder.setRotationFromEuler(0, rnd() * 360, 0);
                    holder.setScale(k, k, k);
                    stone.setParent(holder);
                    continue;
                }
            }

            // камни строим теми же блоками, чтобы стиль не расходился
            const h = size * (rnd() < 0.5 ? 1 : 2);
            const rock = [{ x, z, size, top: TILE.grassY + h, bottom: TILE.grassY - 0.1 }];
            makeShape(parent, blockMesh(rock, 'top'), PALETTE.rock, { name: 'RockTop' });
            makeShape(parent, blockMesh(rock, 'side'), darken(PALETTE.rock, TILE.sideDarken), {
                name: 'RockSide',
                castShadow: true,
            });
        }
    }

    private buildSlots(): void {
        const holder = new Node('Slots');
        holder.setParent(this.root);

        const tex = getTexture(TEXTURES.slotRing);
        if (tex) {
            // два общих материала на все круги: тусклый и яркий (alpha 254 — уже «прозрачный» режим)
            this.ringIdleMat = createMaterial(0xffffff, { unlit: true, texture: tex, alpha: SLOT_VIEW.ringIdleAlpha });
            this.ringHotMat = createMaterial(0xffffff, { unlit: true, texture: tex, alpha: 254 });
        }

        SLOT_POSITIONS.forEach((p, i) => {
            // юнит стоит на верхе постамента — та же высота, что и раньше у плиты,
            // поэтому UNIT_LEVEL и попадание тапа не меняются
            const slot = new Node(`Slot${i}`);
            slot.setParent(holder);
            slot.setPosition(p.x, TILE.grassY, p.z);

            const pedestal = makeShape(
                slot,
                cylinderMesh(SLOT_VIEW.pedestalRadius, UNIT_VIEW.padHeight, 20),
                SLOT_VIEW.pedestalColor,
                {
                    name: 'Pedestal',
                    pos: new Vec3(0, UNIT_VIEW.padHeight / 2, 0),
                    castShadow: true,
                    receiveShadow: true,
                }
            );

            const ring = makeShape(
                slot,
                tileMesh([{ x: 0, z: 0, y: 0, size: SLOT_VIEW.ringSize }]),
                0xffffff,
                {
                    name: 'Ring',
                    pos: new Vec3(0, UNIT_VIEW.padHeight + 0.015, 0),
                    material: this.ringIdleMat ?? undefined,
                }
            );
            ring.active = !!this.ringIdleMat;

            slot.active = false;
            this.slotNodes.push(slot);
            this.slotParts.push({ pedestal, ring });
            this.slotTaken.push(false);
        });
    }

    private buildBase(): void {
        const base = new Node('Base');
        base.setParent(this.root);
        const p = ARENA.basePos;
        base.setPosition(p.x, TILE.grassY, p.z + 1.4);

        const custom = instantiateModel(PROP_MODELS.base);
        if (custom) {
            custom.setParent(base);
            return;
        }

        makeShape(base, boxMesh(3.6, 0.5, 3.6), PALETTE.baseRoof, {
            name: 'Foundation',
            pos: new Vec3(0, 0.25, 0),
            receiveShadow: true,
        });
        makeShape(base, boxMesh(2.6, 2.4, 2.6), PALETTE.base, {
            name: 'Keep',
            pos: new Vec3(0, 1.7, 0),
            castShadow: true,
        });
        makeShape(base, coneMesh(2.0, 1.5), PALETTE.baseRoof, {
            name: 'Roof',
            pos: new Vec3(0, 3.6, 0),
            castShadow: true,
        });
        // угловые башенки
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                makeShape(base, cylinderMesh(0.42, 2.0), PALETTE.base, {
                    name: 'Tower',
                    pos: new Vec3(sx * 1.5, 1.2, sz * 1.5),
                    castShadow: true,
                });
            }
        }
    }

    private buildGate(): void {
        const gate = new Node('SpawnGate');
        gate.setParent(this.root);
        const p = ARENA.spawnPos;
        gate.setPosition(p.x, TILE.grassY, p.z - 0.6);

        this.buildPortalGlow(gate);

        const custom = instantiateModel(PROP_MODELS.spawnGate);
        if (custom) {
            custom.setParent(gate);
            return;
        }

        for (const sx of [-1, 1]) {
            makeShape(gate, boxMesh(0.5, 2.4, 0.5), PALETTE.gate, {
                name: 'Pillar',
                pos: new Vec3(sx * (ARENA.roadWidth / 2 + 0.35), 1.2, 0),
                castShadow: true,
            });
        }
        makeShape(gate, boxMesh(ARENA.roadWidth + 1.4, 0.45, 0.5), PALETTE.gate, {
            name: 'Lintel',
            pos: new Vec3(0, 2.6, 0),
        });
    }

    /** Деревья по краям — детерминированно, чтобы картинка не «дышала» между запусками. */
    private buildProps(): void {
        const props = new Node('Props');
        props.setParent(this.root);

        const spots: Array<[number, number, number]> = [
            [-7.4, -12.0, 1.0],
            [7.2, -11.2, 0.85],
            [-7.6, -5.0, 0.9],
            [7.6, -6.6, 1.05],
            [-7.2, 1.2, 0.95],
            [7.4, 0.4, 0.9],
            [-6.8, 6.4, 1.1],
            [6.9, 5.6, 0.95],
            [-3.4, 9.6, 0.8],
            [3.6, 9.4, 0.85],
        ];

        const { cols, rows, centerZ } = this.grid;
        for (const [sx, sz, scale] of spots) {
            // точки задавались «на глаз», и часть уехала за край острова —
            // ёлки висели над пустотой. Притягиваем к ближайшему блоку суши
            // и ставим на его реальную высоту.
            const c = math.clamp(Math.round(sx / TILE.size + (cols - 1) / 2), 0, cols - 1);
            const r = math.clamp(Math.round((sz - centerZ) / TILE.size + (rows - 1) / 2), 0, rows - 1);
            const key = `${c},${r}`;
            const top = this.grassTop.get(key);
            if (top === undefined || this.blocked.has(key)) continue;
            const x = (c - (cols - 1) / 2) * TILE.size;
            const z = centerZ + (r - (rows - 1) / 2) * TILE.size;
            // не ставим декор на дорогу, даже если руками подвинули точки
            if (this.distanceToRoad(x, z) < ARENA.roadWidth) continue;
            this.blocked.add(key);
            const tree = new Node('Tree');
            tree.setParent(props);
            tree.setPosition(x, top, z);
            tree.setScale(scale, scale, scale);

            const model = instantiateModel(PROP_MODELS.tree);
            if (model) {
                // случайный поворот вокруг оси: одинаковые ёлки не стоят строем
                model.setRotationFromEuler(0, hash2(c, r) * 360, 0);
                model.setParent(tree);
                continue;
            }
            makeShape(tree, cylinderMesh(0.16, 1.0), 0x5a4632, {
                name: 'Trunk',
                pos: new Vec3(0, 0.5, 0),
            });
            makeShape(tree, coneMesh(0.85, 1.8), PALETTE.prop, {
                name: 'Crown',
                pos: new Vec3(0, 1.85, 0),
                castShadow: true,
            });
        }
    }

    /**
     * Цветы, камни и кристаллы на травяных блоках. Ставим по центру тайла и
     * на его реальную высоту: у блоков разброс по высоте, и на общей grassY
     * декор то тонул бы, то висел. Раскладка детерминированная.
     */
    private buildDecor(): void {
        const kinds = Object.keys(DECOR_MODELS) as DecorKind[];
        const totalWeight = kinds.reduce((sum, k) => sum + DECOR.weights[k], 0);
        if (totalWeight <= 0 || DECOR.count <= 0) return;

        const decor = new Node('Decor');
        decor.setParent(this.root);

        let seed = 4242;
        const rnd = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        };
        const pickKind = (): DecorKind => {
            let t = rnd() * totalWeight;
            for (const k of kinds) {
                t -= DECOR.weights[k];
                if (t <= 0) return k;
            }
            return kinds[kinds.length - 1];
        };

        const { cols, rows, centerZ } = this.grid;
        const size = TILE.size;
        const used = new Set<string>();
        const landmarks = [ARENA.basePos, ARENA.spawnPos];

        let placed = 0;
        for (let attempt = 0; attempt < DECOR.count * 30 && placed < DECOR.count; attempt++) {
            const c = Math.floor(rnd() * cols);
            const r = Math.floor(rnd() * rows);
            const key = `${c},${r}`;
            const top = this.grassTop.get(key);
            if (top === undefined || used.has(key) || this.blocked.has(key)) continue;

            const x = (c - (cols - 1) / 2) * size;
            const z = centerZ + (r - (rows - 1) / 2) * size;
            if (this.distanceToRoad(x, z) < ARENA.roadWidth / 2 + DECOR.roadGap) continue;
            if (SLOT_POSITIONS.some((p) => Math.hypot(p.x - x, p.z - z) < DECOR.slotGap)) continue;
            if (landmarks.some((p) => Math.hypot(p.x - x, p.z - z) < DECOR.landmarkGap)) continue;

            const model = instantiateModel(DECOR_MODELS[pickKind()]);
            if (!model) continue;
            used.add(key);

            // небольшой сдвиг внутри тайла, чтобы не стояло строем по сетке
            const jx = (rnd() - 0.5) * size * 0.3;
            const jz = (rnd() - 0.5) * size * 0.3;
            const k = 1 + (rnd() * 2 - 1) * DECOR.scaleJitter;

            const holder = new Node('DecorItem');
            holder.setParent(decor);
            holder.setPosition(x + jx, top, z + jz);
            holder.setRotationFromEuler(0, rnd() * 360, 0);
            holder.setScale(k, k, k);
            model.setParent(holder);
            placed++;
        }
    }

    /**
     * Вода вокруг острова и пена у берега. Плоскость огромная: камера наклонена,
     * и край воды не должен попасть в кадр ни в портрете, ни в ландшафте.
     */
    private buildWater(): void {
        const water = new Node('Water');
        water.setParent(this.root);
        const { cols, rows, centerZ } = this.grid;

        const tex = getTexture(TEXTURES.water);
        this.waterMat = createMaterial(tex ? WATER.tint : PALETTE.sky, { texture: tex });
        // вода чуть глаже земли — солнце даёт на ней мягкий блик
        this.waterMat.setProperty('roughness', 0.45);
        makeShape(water, tileMesh([{ x: 0, z: centerZ, y: WATER.level, size: WATER.size }]), 0, {
            name: 'Surface',
            receiveShadow: true,
            material: this.waterMat,
        });

        // пена: кольцо квадратиков по периметру острова, чуть выше воды
        const half = TILE.size / 2;
        const maxX = ((cols - 1) / 2) * TILE.size + half;
        const minZ = centerZ - ((rows - 1) / 2) * TILE.size - half;
        const maxZ = centerZ + ((rows - 1) / 2) * TILE.size + half;
        const w = WATER.foamWidth;
        const y = WATER.level + 0.02;
        const strips: { x: number; z: number; y: number; size: number }[] = [];
        for (let x = -maxX - w / 2; x <= maxX + w / 2 + 0.001; x += w) {
            strips.push({ x, z: minZ - w / 2, y, size: w });
            strips.push({ x, z: maxZ + w / 2, y, size: w });
        }
        for (let z = minZ + w / 2; z <= maxZ - w / 2 + 0.001; z += w) {
            strips.push({ x: -maxX - w / 2, z, y, size: w });
            strips.push({ x: maxX + w / 2, z, y, size: w });
        }
        this.foamMat = createMaterial(0xffffff, { unlit: true, alpha: WATER.foamAlpha });
        makeShape(water, tileMesh(strips), 0, { name: 'Foam', material: this.foamMat });
        this.tickEnvironment(0);
    }

    /** Светящаяся «плёнка» в проёме портала и всплывающие искры. */
    private buildPortalGlow(gate: Node): void {
        // гейт стоит на уровне травы, а дорога под ним ниже — свечение от дороги
        const floor = TILE.roadY - TILE.grassY;
        this.portalMat = createMaterial(PORTAL.color, { unlit: true, alpha: PORTAL.alphaMax });
        // тонкий бокс, а не плоскость: виден с обеих сторон при любом ракурсе
        makeShape(gate, boxMesh(PORTAL.width, PORTAL.height, 0.04), 0, {
            name: 'PortalGlow',
            pos: new Vec3(0, floor + PORTAL.height / 2, 0),
            material: this.portalMat,
        });

        for (let i = 0; i < PORTAL.sparks; i++) {
            const spark = makeShape(gate, boxMesh(0.09, 0.09, 0.09), PORTAL.sparkColor, {
                name: 'Spark',
                unlit: true,
            });
            this.sparks.push({
                node: spark,
                phase: i / PORTAL.sparks,
                x: (hash2(i, 3) - 0.5) * PORTAL.width,
                z: (hash2(i, 9) - 0.5) * 0.5,
            });
        }
    }

    /** Течение воды, мерцание пены, пульс портала, искры. */
    private tickEnvironment(dt: number): void {
        this.time += dt;
        const t = this.time;

        if (this.waterMat && getTexture(TEXTURES.water)) {
            const reps = WATER.size / WATER.tileWorld;
            this.waterMat.setProperty(
                'tilingOffset',
                new Vec4(reps, reps, (t * WATER.flow.x) % 1, (t * WATER.flow.z) % 1)
            );
        }
        if (this.foamMat) {
            const a = WATER.foamAlpha * (0.7 + 0.3 * Math.sin(t * WATER.foamPulse));
            this.foamMat.setProperty('mainColor', colorOf(0xffffff, Math.round(a)));
        }
        if (this.portalMat) {
            const k = 0.5 + 0.5 * Math.sin(t * PORTAL.pulseSpeed);
            const a = PORTAL.alphaMin + (PORTAL.alphaMax - PORTAL.alphaMin) * k;
            this.portalMat.setProperty('mainColor', colorOf(PORTAL.color, Math.round(a)));
        }

        const floor = TILE.roadY - TILE.grassY;
        for (const s of this.sparks) {
            // каждая искра живёт по кругу: всплывает и тает, фазы разнесены
            const life = (t * 0.45 + s.phase) % 1;
            const size = Math.sin(life * Math.PI);
            const sway = Math.sin(t * 2 + s.phase * 6) * 0.08;
            s.node.setPosition(s.x + sway, floor + 0.2 + life * PORTAL.height * PORTAL.sparkRise, s.z);
            s.node.setScale(size, size, size);
        }
    }

    private distanceToRoad(x: number, z: number): number {
        let best = Infinity;
        for (let d = 0; d <= PATH.total; d += 0.5) {
            const p = PATH.posAt(d);
            const dx = p.x - x;
            const dz = p.z - z;
            best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
        }
        return best;
    }
}
