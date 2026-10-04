import {
    Mat4,
    MeshRenderer,
    Node,
    Prefab,
    SpriteFrame,
    Texture2D,
    Vec3,
    instantiate,
    resources,
} from 'cc';
import type { EnemyKind, UnitKind } from '../Sim/SimTypes';

/**
 * Точки подмены моделей.
 *
 * Пока моделей нет, вся сцена рисуется примитивами из Prims.ts — играть можно
 * уже сейчас. Когда приедут модели из Tripo: кладём префабы в
 * assets/resources/Models/<имя> и прописываем имя сюда. Код менять не нужно,
 * вью сам подставит префаб вместо примитива.
 *
 * Требования к префабу: модель смотрит в +Z, стоит на нуле (pivot в ногах),
 * высота примерно как `approxHeight` ниже — иначе поплывёт масштаб.
 */
export interface ModelSlot {
    /** путь внутри assets/resources, без расширения. Пустая строка = рисуем примитив */
    prefab: string;
    /** ожидаемая высота модели в юнитах мира — по ней вью отмасштабирует префаб */
    approxHeight: number;
    /**
     * Доворот вокруг вертикали, градусы. Модель должна смотреть в +Z;
     * если после автоповорота стоит спиной — прибавь сюда 180.
     */
    yaw?: number;
    /** отключить автоподъём/авторазворот, если модель уже правильная */
    autoOrient?: boolean;
}

export const UNIT_MODELS: Record<UnitKind, ModelSlot> = {
    archer: { prefab: 'Models/archer', approxHeight: 1.6 },
    bomber: { prefab: 'Models/bomber', approxHeight: 1.7 },
    mage: { prefab: 'Models/mage', approxHeight: 1.8 },
};

export const ENEMY_MODELS: Record<EnemyKind, ModelSlot> = {
    grunt: { prefab: 'Models/grunt', approxHeight: 1.3 },
    tank: { prefab: 'Models/tank', approxHeight: 1.9 },
    boss: { prefab: 'Models/boss', approxHeight: 3.4 },
};

export const PROP_MODELS = {
    base: { prefab: 'Models/base', approxHeight: 4.0 } as ModelSlot,
    spawnGate: { prefab: 'Models/spawnGate', approxHeight: 2.6 } as ModelSlot,
    /** ёлка по краям арены; уже стоит вертикально, автоповорот не нужен */
    tree: { prefab: 'Models/tree', approxHeight: 2.7, autoOrient: false } as ModelSlot,
};

/**
 * Оружие героев — отдельные модели, вырезанные из героя `npm run split-weapon`.
 * Центр модели — точка хвата; RigAnimator вкладывает её в ладонь.
 *
 * follow: 'full' — оружие поворачивается вместе с кистью (валун);
 *         'position' — идёт за ладонью, но держит свою ориентацию (лук и посох
 *         так и остаются вертикальными, даже когда рука поднята для выстрела).
 * euler — доворот в осях модели героя, градусы: им подгоняется наклон.
 */
export interface WeaponSlot {
    prefab: string;
    hand: 'LeftHand' | 'RightHand';
    follow: 'full' | 'position';
    euler: [number, number, number];
    /** спрятать в момент броска: снаряд полетел, в руке пусто */
    hideOnRelease?: boolean;
}

export const WEAPON_MODELS: Record<UnitKind, WeaponSlot> = {
    archer: { prefab: 'Models/archer_weapon', hand: 'LeftHand', follow: 'position', euler: [0, 0, -8] },
    bomber: {
        prefab: 'Models/bomber_weapon',
        hand: 'RightHand',
        follow: 'full',
        euler: [0, 0, 0],
        hideOnRelease: true,
    },
    mage: { prefab: 'Models/mage_weapon', hand: 'RightHand', follow: 'position', euler: [0, 0, 6] },
};

/**
 * Мелкий декор на травяных блоках. Модели из Tripo уже стоят вертикально
 * с пивотом на земле, поэтому автоповорот выключен — эвристика «плечи шире
 * груди» для камня и цветка бессмысленна.
 */
export const DECOR_MODELS = {
    flower: { prefab: 'Models/flower', approxHeight: 0.55, autoOrient: false } as ModelSlot,
    stone: { prefab: 'Models/stone', approxHeight: 0.45, autoOrient: false } as ModelSlot,
    crystal: { prefab: 'Models/crystal', approxHeight: 0.85, autoOrient: false } as ModelSlot,
};
export type DecorKind = keyof typeof DECOR_MODELS;

/**
 * Картинки интерфейса. Пока путь пустой, логотип рисуется текстом, а кнопка CTA —
 * векторно через Graphics. Положишь PNG в assets/resources/UI/ и пропишешь имя —
 * подставится картинка.
 */
export const UI_IMAGES = {
    /** декоративная плашка под надписью EVIL TOWER; текст рисуется поверх кодом */
    logo: 'UI/logo_plate',
    /** плашка кнопки CTA, натягивается как 9-slice */
    ctaButton: 'UI/cta_button',
    /** рамка магазина, тоже 9-slice */
    panelFrame: 'UI/panel_frame',
    /** иконки классов в карточках магазина */
    iconArcher: 'UI/icon_archer',
    iconBomber: 'UI/icon_bomber',
    iconMage: 'UI/icon_mage',
    /** фон карточки героя в магазине, 9-slice */
    cardFrame: 'UI/card_frame',
    /** портреты героев в карточках; если нет — берётся иконка класса */
    heroArcher: 'UI/hero_archer',
    heroBomber: 'UI/hero_bomber',
    heroMage: 'UI/hero_mage',
    /** монетка рядом с ценой */
    coin: 'UI/coin',
    /** плашка верхнего HUD, 9-slice */
    hudPlate: 'UI/hud_plate',
    /** рука-подсказка туториала: палец смотрит вверх, на цель */
    tutorialHand: 'UI/tutorial_hand',
};

/**
 * Текстуры ландшафта и воды. Бесшовные, генерятся `npm run ui-art -- gen texGrass`
 * и т.д. Нет файла — блоки рисуются плоским цветом из PALETTE, как раньше.
 */
export const TEXTURES = {
    grassTop: 'Textures/grass_top',
    /** бок травяного блока: сверху полоса травы, ниже земля — «майнкрафтовый» срез */
    grassSide: 'Textures/grass_side',
    roadTop: 'Textures/road_top',
    dirt: 'Textures/dirt',
    water: 'Textures/water',
    /** рунический круг на слоте, с альфой */
    slotRing: 'Textures/slot_ring',
};

/** Портрет героя для карточки магазина. */
export function heroPortraitPath(kind: UnitKind): string {
    if (kind === 'archer') return UI_IMAGES.heroArcher;
    if (kind === 'bomber') return UI_IMAGES.heroBomber;
    return UI_IMAGES.heroMage;
}

/** Картинка класса по типу юнита; пусто — рисуем векторный глиф. */
export function unitIconPath(kind: UnitKind): string {
    if (kind === 'archer') return UI_IMAGES.iconArcher;
    if (kind === 'bomber') return UI_IMAGES.iconBomber;
    return UI_IMAGES.iconMage;
}

const cache = new Map<string, Prefab | null>();
const spriteCache = new Map<string, SpriteFrame | null>();
const textureCache = new Map<string, Texture2D | null>();

/** Асинхронная предзагрузка всех заданных префабов. Вызывается на старте. */
export function preloadModels(onDone: () => void): void {
    const slots: ModelSlot[] = [
        UNIT_MODELS.archer,
        UNIT_MODELS.bomber,
        UNIT_MODELS.mage,
        ENEMY_MODELS.grunt,
        ENEMY_MODELS.tank,
        ENEMY_MODELS.boss,
        PROP_MODELS.base,
        PROP_MODELS.spawnGate,
        PROP_MODELS.tree,
        DECOR_MODELS.flower,
        DECOR_MODELS.stone,
        DECOR_MODELS.crystal,
        // у оружия масштаб не подгоняется: оно в тех же единицах, что и герой
        { prefab: WEAPON_MODELS.archer.prefab, approxHeight: 0 },
        { prefab: WEAPON_MODELS.bomber.prefab, approxHeight: 0 },
        { prefab: WEAPON_MODELS.mage.prefab, approxHeight: 0 },
    ];
    const paths = slots.map((s) => s.prefab).filter((p) => p.length > 0);

    if (paths.length === 0) {
        onDone();
        return;
    }

    let left = paths.length;
    for (const path of paths) {
        loadPrefabFlexible(path, (prefab) => {
            cache.set(path, prefab);
            if (--left === 0) onDone();
        });
    }
}

/**
 * Cocos кладёт префаб импортированного .glb в суб-ассет, и его имя зависит от
 * того, как назван корневой узел внутри файла. Чтобы не угадывать руками,
 * пробуем сам путь, затем типовые варианты суб-ассета, и только потом сдаёмся.
 */
function loadPrefabFlexible(path: string, done: (prefab: Prefab | null) => void): void {
    const base = path.split('/').pop() ?? path;
    const candidates = [path, `${path}/${base}`, `${path}/Scene`, `${path}/RootNode`];

    const tryNext = (i: number): void => {
        if (i >= candidates.length) {
            console.warn(
                `[AssetSlots] не нашёлся префаб для "${path}". ` +
                    `Открой ассет в редакторе и посмотри имя вложенного префаба.`
            );
            done(null);
            return;
        }
        resources.load(candidates[i], Prefab, (err, prefab) => {
            if (err || !prefab) tryNext(i + 1);
            else done(prefab);
        });
    };
    tryNext(0);
}

export function getPrefab(slot: ModelSlot): Prefab | null {
    if (!slot.prefab) return null;
    return cache.get(slot.prefab) ?? null;
}

/** Предзагрузка текстур ландшафта; отсутствующие просто пропускаем. */
export function preloadTextures(onDone: () => void): void {
    const paths = (Object.keys(TEXTURES) as (keyof typeof TEXTURES)[])
        .map((k) => TEXTURES[k])
        .filter((p) => p.length > 0);
    if (paths.length === 0) {
        onDone();
        return;
    }
    let left = paths.length;
    for (const path of paths) {
        resources.load(`${path}/texture`, Texture2D, (err, tex) => {
            if (err || !tex) {
                console.warn(`[AssetSlots] не загрузилась текстура "${path}"`);
                textureCache.set(path, null);
            } else {
                // текстура повторяется на каждом блоке и тянется по воде —
                // без REPEAT за пределами первой плитки шёл бы размазанный край
                tex.setWrapMode(Texture2D.WrapMode.REPEAT, Texture2D.WrapMode.REPEAT);
                textureCache.set(path, tex);
            }
            if (--left === 0) onDone();
        });
    }
}

export function getTexture(path: string): Texture2D | null {
    if (!path) return null;
    return textureCache.get(path) ?? null;
}

/** Предзагрузка картинок интерфейса; отсутствующие просто пропускаем. */
export function preloadUiImages(onDone: () => void): void {
    const paths = [
        UI_IMAGES.logo,
        UI_IMAGES.ctaButton,
        UI_IMAGES.panelFrame,
        UI_IMAGES.iconArcher,
        UI_IMAGES.iconBomber,
        UI_IMAGES.iconMage,
        UI_IMAGES.cardFrame,
        UI_IMAGES.heroArcher,
        UI_IMAGES.heroBomber,
        UI_IMAGES.heroMage,
        UI_IMAGES.coin,
        UI_IMAGES.hudPlate,
        UI_IMAGES.tutorialHand,
    ].filter((p) => p.length > 0);
    if (paths.length === 0) {
        onDone();
        return;
    }
    let left = paths.length;
    for (const path of paths) {
        loadFrame(path, (frame) => {
            spriteCache.set(path, frame);
            if (--left === 0) onDone();
        });
    }
}

/**
 * Достать SpriteFrame независимо от того, как редактор импортировал PNG.
 *
 * По умолчанию Cocos заводит картинку как texture, и суб-ассета spriteFrame
 * у неё просто нет — код молча оставался бы с векторными заглушками. Поэтому
 * сначала пробуем готовый spriteFrame, а если его нет — берём текстуру и
 * собираем кадр сами. Так ассет работает при любых настройках импорта.
 */
function loadFrame(path: string, done: (frame: SpriteFrame | null) => void): void {
    resources.load(`${path}/spriteFrame`, SpriteFrame, (err, frame) => {
        if (!err && frame) {
            done(frame);
            return;
        }
        resources.load(`${path}/texture`, Texture2D, (texErr, texture) => {
            if (texErr || !texture) {
                console.warn(`[AssetSlots] не загрузилась картинка "${path}"`);
                done(null);
                return;
            }
            const made = new SpriteFrame();
            made.texture = texture;
            done(made);
        });
    });
}

/**
 * Создать инстанс модели, подогнав её под нужный размер.
 *
 * Tripo отдаёт модели, вписанные в единичный объём, поэтому «как есть» юнит
 * оказался бы размером с кубик. Меряем реальные габариты меша и масштабируем
 * под approxHeight, заодно сажая модель на землю: у сгенерённых моделей
 * центр обычно в середине, а не в ногах.
 */
export function instantiateModel(slot: ModelSlot): Node | null {
    const prefab = getPrefab(slot);
    if (!prefab) return null;

    // модель кладём внутрь контейнера: собственный трансформ префаба тогда
    // остаётся нетронутым, а повороты, масштаб и посадку применяем сверху
    const holder = new Node('Model');
    const inst = instantiate(prefab);
    inst.setParent(holder);
    // модели отбрасывают тень — без неё юниты «висят» над блоками
    for (const mr of inst.getComponentsInChildren(MeshRenderer)) {
        mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
    }

    // первый замер — в исходной ориентации, по нему решаем, как модель лежит
    let box = measure(holder);
    if (!box) return holder;

    if (slot.autoOrient !== false) {
        const sx = box.max.x - box.min.x;
        const sy = box.max.y - box.min.y;
        const sz = box.max.z - box.min.z;

        // генераторы часто отдают модель лежащей: тогда вертикаль — не Y
        if (sy < Math.max(sx, sz) * 0.75) {
            inst.setRotationFromEuler(sz > sx ? -90 : 0, 0, sz > sx ? 0 : 90);
        } else if (sz > sx * 1.12) {
            // у гуманоида плечи шире груди; если наоборот — модель развёрнута боком
            inst.setRotationFromEuler(0, -90, 0);
        }
        // после поворота габариты другие — меряем заново
        box = measure(holder) ?? box;
    }

    if (slot.yaw) holder.setRotationFromEuler(0, slot.yaw, 0);

    const height = box.max.y - box.min.y;
    if (height <= 0.0001) return holder;

    const scale = slot.approxHeight / height;
    holder.setScale(scale, scale, scale);
    // ставим на землю и центрируем по горизонтали: у сгенерённых моделей
    // начало координат обычно в середине объёма, а не в ногах
    inst.setPosition(
        inst.position.x - (box.min.x + box.max.x) / 2,
        inst.position.y - box.min.y,
        inst.position.z - (box.min.z + box.max.z) / 2
    );
    return holder;
}

/** Габариты всех мешей узла по восьми углам с учётом вложенных трансформов. */
function measure(root: Node): { min: Vec3; max: Vec3 } | null {
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    const mat = new Mat4();
    const corner = new Vec3();
    let found = false;

    for (const mr of root.getComponentsInChildren(MeshRenderer)) {
        const struct = mr.mesh?.struct;
        if (!struct?.minPosition || !struct.maxPosition) continue;
        // root не прикреплён к сцене, поэтому «мировая» матрица здесь —
        // это трансформ относительно самого root, что нам и нужно
        mr.node.getWorldMatrix(mat);
        const a = struct.minPosition;
        const b = struct.maxPosition;
        for (let i = 0; i < 8; i++) {
            corner.set(i & 1 ? b.x : a.x, i & 2 ? b.y : a.y, i & 4 ? b.z : a.z);
            Vec3.transformMat4(corner, corner, mat);
            Vec3.min(min, min, corner);
            Vec3.max(max, max, corner);
        }
        found = true;
    }
    return found ? { min, max } : null;
}

export function getSprite(path: string): SpriteFrame | null {
    if (!path) return null;
    return spriteCache.get(path) ?? null;
}
