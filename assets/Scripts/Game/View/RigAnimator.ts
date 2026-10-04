import { MeshRenderer, Node, Quat, SkeletalAnimation, Vec3, instantiate, math } from 'cc';
import type { UnitKind } from '../../Sim/SimTypes';
import { RIG } from '../ViewConfig';
import { WEAPON_MODELS, getPrefab } from '../AssetSlots';

/**
 * Процедурная анимация по костям для моделей с ригом Mixamo (так ригует Tripo).
 *
 * Модели приходят в T-позе и без клипов, поэтому всё делаем кодом:
 *  1) опускаем руки — получаем позу покоя;
 *  2) поверх неё дыхание и лёгкие повороты головы;
 *  3) на выстрел — замах, свой у каждого класса.
 *
 * Повороты задаются в осях МОДЕЛИ (вперёд/вправо/вверх), а не костей:
 * локальные оси костей у Tripo непредсказуемы, а «поднять руку вперёд»
 * в осях модели одинаково для любого рига.
 */

/** Кость в позе покоя: её локальный поворот после опускания рук. */
interface Joint {
    node: Node;
    rest: Quat;
}

type Pose = Partial<Record<'spine' | 'head' | 'leftArm' | 'rightArm' | 'leftFore' | 'rightFore', Vec3>>;

const BONES = {
    spine: 'Spine1',
    head: 'Head',
    leftArm: 'LeftArm',
    rightArm: 'RightArm',
    leftFore: 'LeftForeArm',
    rightFore: 'RightForeArm',
} as const;
type BoneKey = keyof typeof BONES;

const tmpQ = new Quat();
const tmpQ2 = new Quat();
const parentQ = new Quat();
const modelQ = new Quat();
const a = new Vec3();
const b = new Vec3();

export class RigAnimator {
    private readonly joints: Partial<Record<BoneKey, Joint>> = {};
    /** оружие в руке и кости, по которым считается ладонь */
    private weapon: { node: Node; hand: Node; finger: Node | null } | null = null;

    private constructor(
        private readonly model: Node,
        private readonly kind: UnitKind
    ) {}

    /** Найти скелет и опустить руки. Нет нужных костей — вернёт null, юнит останется как есть. */
    static tryCreate(model: Node, kind: UnitKind): RigAnimator | null {
        const rig = new RigAnimator(model, kind);
        const keys = Object.keys(BONES) as BoneKey[];
        for (const key of keys) {
            const node = findBone(model, BONES[key]);
            if (node) rig.joints[key] = { node, rest: new Quat() };
        }
        if (!rig.joints.leftArm || !rig.joints.rightArm) return null;

        // Импорт кладёт в префаб SkeletalAnimation даже без клипов, и по умолчанию
        // он в «запечённом» режиме: меш берёт позу из текстуры клипов и ИГНОРИРУЕТ
        // повороты костей — модель навсегда в T-позе. Переводим скиннинг в реалтайм,
        // тогда меш следует за узлами костей.
        for (const anim of model.getComponentsInChildren(SkeletalAnimation)) {
            anim.useBakedAnimation = false;
        }

        rig.lowerArm(rig.joints.leftArm.node, rig.joints.leftFore?.node);
        rig.lowerArm(rig.joints.rightArm.node, rig.joints.rightFore?.node);
        for (const key of keys) {
            const j = rig.joints[key];
            if (j) Quat.copy(j.rest, j.node.rotation);
        }
        rig.attachWeapon();
        return rig;
    }

    /**
     * Вложить оружие в ладонь. Делается после опускания рук: ориентация оружия
     * задаётся в осях модели героя, а не кости — у Tripo оси костей непредсказуемы.
     */
    private attachWeapon(): void {
        const spec = WEAPON_MODELS[this.kind];
        const prefab = spec ? getPrefab({ prefab: spec.prefab, approxHeight: 0 }) : null;
        if (!spec || !prefab) return;
        const hand = findBone(this.model, spec.hand);
        if (!hand) return;
        const finger = findBone(this.model, `${spec.hand}Middle1`);

        const node = new Node('Weapon');
        const mesh = instantiate(prefab);
        mesh.setParent(node);
        for (const mr of mesh.getComponentsInChildren(MeshRenderer)) {
            mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        }
        // оружие живёт в узле модели: так оно в тех же единицах и масштабе, что и герой
        const space = this.model.children[0] ?? this.model;
        node.setParent(space);
        this.weapon = { node, hand, finger };
        this.placeWeapon(0);
    }

    /** Поставить оружие в ладонь на текущем кадре. */
    private placeWeapon(attack: number): void {
        const w = this.weapon;
        if (!w) return;
        const spec = WEAPON_MODELS[this.kind];

        // ладонь — между запястьем и основанием среднего пальца
        Vec3.copy(a, w.hand.worldPosition);
        if (w.finger) Vec3.lerp(a, a, w.finger.worldPosition, RIG.gripAlongHand);
        w.node.setWorldPosition(a);

        const space = w.node.parent!;
        Quat.fromEuler(tmpQ, spec.euler[0], spec.euler[1], spec.euler[2]);
        if (spec.follow === 'full') {
            // вместе с кистью: доворот модели поверх поворота кисти относительно покоя
            Quat.multiply(tmpQ, w.hand.worldRotation, tmpQ);
            Quat.invert(tmpQ2, space.worldRotation);
            Quat.multiply(tmpQ, tmpQ2, tmpQ);
        }
        w.node.setRotation(tmpQ);

        // валун улетает снарядом — в момент броска рука пустеет до конца замаха
        if (spec.hideOnRelease) w.node.active = !(attack > RIG.windup && attack < 1);
    }

    /**
     * @param time  общее время, со сдвигом на юнита, чтобы не дышали хором
     * @param attack фаза замаха 0..1 (0 — не атакует)
     */
    update(time: number, attack: number): void {
        const pose: Pose = {};
        const breath = Math.sin(time * RIG.breathSpeed);
        pose.spine = new Vec3(breath * RIG.breathPitch, 0, 0);
        pose.head = new Vec3(-breath * RIG.breathPitch * 0.5, Math.sin(time * 0.7) * RIG.headYaw, 0);
        // руки чуть отстают от дыхания — так поза не выглядит замороженной
        const sway = Math.sin(time * RIG.breathSpeed - 0.6) * RIG.armSway;
        pose.leftArm = new Vec3(sway, 0, 0);
        pose.rightArm = new Vec3(-sway, 0, 0);

        if (attack > 0) this.attackPose(pose, attack);

        // от корня к листьям: поворот ребёнка считается от уже повёрнутого родителя
        const order: BoneKey[] = ['spine', 'head', 'leftArm', 'rightArm', 'leftFore', 'rightFore'];
        for (const key of order) this.apply(key, pose[key]);
        this.placeWeapon(attack);
    }

    /**
     * Замахи. Углы в градусах вокруг осей модели:
     * x — вокруг «вправо» (минус = рука идёт вперёд и вверх), y — вокруг вертикали.
     */
    private attackPose(pose: Pose, t: number): void {
        // быстрый замах, затем удар и плавный возврат
        const wind = t < RIG.windup ? t / RIG.windup : 1;
        const strike = t < RIG.windup ? 0 : (t - RIG.windup) / (1 - RIG.windup);
        const ease = (k: number) => k * k * (3 - 2 * k);

        if (this.kind === 'bomber') {
            // бросок из-за головы: рука уходит назад-вверх, корпус откидывается,
            // затем рука хлёстко идёт вперёд-вниз, корпус наклоняется за ней
            const raise = ease(wind) * (1 - ease(strike));
            const swing = Math.sin(strike * Math.PI);
            pose.rightArm = new Vec3(-RIG.throwRaise * raise - RIG.throwFollow * swing, 0, 0);
            pose.rightFore = new Vec3(-40 * raise, 0, 0);
            pose.spine = new Vec3(-8 * raise + 14 * swing, 10 * raise - 10 * swing, 0);
        } else if (this.kind === 'archer') {
            // лук: левая рука вытягивается вперёд, правая тянет тетиву и отпускает
            const hold = ease(wind) * (1 - ease(strike) * 0.8);
            pose.leftArm = new Vec3(-RIG.bowRaise * hold, 0, 0);
            pose.rightArm = new Vec3(-RIG.bowRaise * hold * 0.9, 0, 0);
            pose.rightFore = new Vec3(-RIG.bowDraw * hold, 0, 0);
            pose.spine = new Vec3(0, -12 * hold, 0);
        } else {
            // маг: посох взлетает вверх, на ударе резко опускается вперёд
            const raise = ease(wind) * (1 - ease(strike));
            const cast = Math.sin(strike * Math.PI);
            pose.rightArm = new Vec3(-RIG.castRaise * raise - 60 * cast, 0, 0);
            pose.leftArm = new Vec3(-50 * cast, 0, 0);
            pose.spine = new Vec3(-6 * raise + 10 * cast, 0, 0);
        }
    }

    /** Поставить кость в позу покоя и довернуть на углы в осях модели. */
    private apply(key: BoneKey, euler?: Vec3): void {
        const j = this.joints[key];
        if (!j) return;
        j.node.setRotation(j.rest);
        if (!euler || (euler.x === 0 && euler.y === 0 && euler.z === 0)) return;

        // доворот в мире = поворот модели * доворот в осях модели * обратный поворот модели
        Quat.fromEuler(tmpQ, euler.x, euler.y, euler.z);
        Quat.copy(modelQ, this.model.worldRotation);
        Quat.multiply(tmpQ, modelQ, tmpQ);
        Quat.invert(tmpQ2, modelQ);
        Quat.multiply(tmpQ, tmpQ, tmpQ2);

        // мировой поворот кости с доворотом, переведённый обратно в локальный
        Quat.multiply(tmpQ, tmpQ, j.node.worldRotation);
        const parent = j.node.parent;
        if (parent) {
            Quat.invert(parentQ, parent.worldRotation);
            Quat.multiply(tmpQ, parentQ, tmpQ);
        }
        j.node.setRotation(tmpQ);
    }

    /**
     * Опустить руку из T-позы: доворачиваем плечо так, чтобы направление
     * «плечо → локоть» смотрело вниз с небольшим разворотом наружу.
     */
    private lowerArm(arm: Node, fore?: Node): void {
        if (!fore) return;
        Vec3.subtract(a, fore.worldPosition, arm.worldPosition);
        if (a.lengthSqr() < 1e-8) return;
        a.normalize();

        // «вниз» и «наружу» берём в осях модели, чтобы не зависеть от её разворота
        const modelRot = this.model.worldRotation;
        const down = Vec3.transformQuat(new Vec3(), new Vec3(0, -1, 0), modelRot);
        // наружу — горизонтальная часть текущего направления руки
        Vec3.scaleAndAdd(b, a, down, -Vec3.dot(a, down));
        if (b.lengthSqr() < 1e-8) return;
        b.normalize();
        const spread = math.toRadian(RIG.armSpread);
        Vec3.multiplyScalar(b, b, Math.sin(spread));
        Vec3.scaleAndAdd(b, b, down, Math.cos(spread));
        b.normalize();

        Quat.rotationTo(tmpQ, a, b);
        Quat.multiply(tmpQ, tmpQ, arm.worldRotation);
        arm.setWorldRotation(tmpQ);
    }
}

/** Кость по имени без префикса: импорт может отдать «mixamorig:Head» или «mixamorig_Head». */
function findBone(root: Node, name: string): Node | null {
    const re = new RegExp(`(^|[:_])${name}$`);
    const stack: Node[] = [root];
    while (stack.length > 0) {
        const n = stack.pop()!;
        if (re.test(n.name)) return n;
        for (const c of n.children) stack.push(c);
    }
    return null;
}
