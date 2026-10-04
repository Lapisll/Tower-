import { Camera, Color, Node, Vec3, geometry, math } from 'cc';
import { ARENA } from '../../Sim/Balance';
import { CAMERA, PALETTE } from '../ViewConfig';

/**
 * Адаптивная камера.
 *
 * Плейбл крутится и в портрете, и в ландшафте, поэтому дистанция камеры не
 * забита константой, а считается из габаритов арены и текущего соотношения
 * сторон: арена всегда влезает целиком, с одинаковыми полями по краям.
 */
export class CameraRig {
    readonly node: Node;
    readonly camera: Camera;
    private lastAspect = -1;

    constructor(parent: Node) {
        this.node = new Node('MainCamera');
        this.node.setParent(parent);

        this.camera = this.node.addComponent(Camera);
        this.camera.projection = Camera.ProjectionType.PERSPECTIVE;
        this.camera.fov = CAMERA.fov;
        this.camera.near = CAMERA.near;
        this.camera.far = CAMERA.far;
        this.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        this.camera.clearColor = new Color(
            (PALETTE.sky >> 16) & 0xff,
            (PALETTE.sky >> 8) & 0xff,
            PALETTE.sky & 0xff,
            255
        );
        this.camera.priority = 0;
    }

    /** Пересчитать позицию, если сменились размеры окна. Дёргается каждый кадр — внутри дешёвая проверка. */
    refresh(width: number, height: number, force = false): void {
        const aspect = width / Math.max(1, height);
        if (!force && Math.abs(aspect - this.lastAspect) < 0.001) return;
        this.lastAspect = aspect;

        const portrait = aspect < 1;
        const tiltDeg = portrait ? CAMERA.tiltPortrait : CAMERA.tiltLandscape;
        const tilt = math.toRadian(tiltDeg);

        // сколько мира нужно уместить: ширина арены и её глубина,
        // сплющенная наклоном камеры
        const needW = ARENA.width;
        const needH = ARENA.depth * Math.sin(tilt);

        // интерфейс съедает часть кадра, поэтому арену вписываем в остаток
        const freeV = portrait ? 1 - CAMERA.uiBottomPortrait - CAMERA.uiTopPortrait : 1;
        const freeH = portrait ? 1 : 1 - CAMERA.uiRightLandscape;

        const halfFov = math.toRadian(CAMERA.fov) * 0.5;
        const distForH = needH * 0.5 / (Math.tan(halfFov) * freeV);
        const distForW = needW * 0.5 / (Math.tan(halfFov) * aspect * freeH);
        const dist = Math.max(distForH, distForW) * CAMERA.padding;

        // видимый кусок мира на уровне земли — по нему считаем сдвиг центра,
        // чтобы арена встала в свободную зону, а не под панель магазина
        const visibleH = 2 * Math.tan(halfFov) * dist;
        const visibleW = visibleH * aspect;
        const shiftScreen = portrait
            ? (CAMERA.uiBottomPortrait - CAMERA.uiTopPortrait) * 0.5 * visibleH
            : 0;
        const shiftSide = portrait ? 0 : -CAMERA.uiRightLandscape * 0.5 * visibleW;

        const target = new Vec3(
            CAMERA.lookAtX + shiftSide,
            CAMERA.lookAtY,
            // экранный «верх» при наклонной камере — это движение по -Z в мире
            CAMERA.lookAtZ - shiftScreen / Math.max(0.2, Math.sin(tilt))
        );
        const pos = new Vec3(
            target.x,
            target.y + Math.sin(tilt) * dist,
            target.z - Math.cos(tilt) * dist
        );
        this.node.setPosition(pos);
        this.node.lookAt(target);
    }

    /**
     * Куда ткнул палец, на заданной высоте.
     *
     * Плоскость обязательно на уровне ВЕРХА блоков: площадки подняты почти
     * на метр, и если ловить пересечение с нулевой плоскостью, при наклонной
     * камере тап уезжает почти на целый тайл мимо.
     */
    screenToGround(screenX: number, screenY: number, out: Vec3, planeY = 0): boolean {
        const ray = new geometry.Ray();
        this.camera.screenPointToRay(screenX, screenY, ray);
        if (Math.abs(ray.d.y) < 1e-5) return false;
        const t = (planeY - ray.o.y) / ray.d.y;
        if (t < 0) return false;
        out.set(ray.o.x + ray.d.x * t, planeY, ray.o.z + ray.d.z * t);
        return true;
    }
}
