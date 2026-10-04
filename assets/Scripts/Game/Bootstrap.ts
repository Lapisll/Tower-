import {
    Color,
    Component,
    DirectionalLight,
    renderer,
    EventTouch,
    Input,
    Node,
    Vec3,
    Vec4,
    _decorator,
    director,
    input,
    screen,
} from 'cc';
import { CAMERA, LIGHT, UNIT_LEVEL } from './ViewConfig';
import { ARENA } from '../Sim/Balance';
import { preloadModels, preloadTextures, preloadUiImages } from './AssetSlots';
import { ArenaView } from './View/ArenaView';
import { BattleView } from './View/BattleView';
import { CameraRig } from './View/CameraRig';
import { GameUI } from './UI/GameUI';
import { applyResolution } from './UI/UIKit';
import { GameController } from './GameController';
import { CtaService } from './Services/CtaService';
import { Audio } from './Services/Audio';

const { ccclass } = _decorator;

/**
 * Точка входа. Вся сцена собирается кодом — в редакторе достаточно пустого узла
 * с этим компонентом. Так плейбл не зависит от ручной расстановки в сцене
 * и не ломается, когда редактор пересохраняет .scene.
 */
@ccclass('Bootstrap')
export class Bootstrap extends Component {
    private rig!: CameraRig;
    private arena!: ArenaView;
    private view!: BattleView;
    private ui!: GameUI;
    private game!: GameController;

    private lastW = 0;
    private lastH = 0;
    private ready = false;
    private readonly groundPoint = new Vec3();

    onLoad(): void {
        CtaService.notifyReady();
        Audio.init();
        // ассетов может не быть вовсе — тогда колбэки вызовутся сразу
        preloadModels(() => preloadUiImages(() => preloadTextures(() => this.build())));
    }

    private build(): void {
        // ВАЖНО: разрешение до создания UI. Canvas считает свой размер в момент
        // добавления компонента, и если дизайн-разрешение ещё не задано, он берёт
        // размер окна в пикселях — вёрстка под 750 разъезжается.
        const size0 = screen.windowSize;
        applyResolution(Math.max(1, size0.width), Math.max(1, size0.height));

        this.buildLight();

        this.rig = new CameraRig(this.node);
        this.arena = new ArenaView(this.node);
        this.view = new BattleView(this.node);
        this.ui = new GameUI(this.node, {
            onPickUnit: (kind) => this.game.pickUnit(kind),
            onStartWave: () => this.game.startWave(),
            onCta: () => this.game.fireCta(),
        });

        this.ui.setWorldCamera(this.rig.camera);
        this.game = new GameController(this.arena, this.view, this.ui);

        this.syncLayout(true);
        this.game.start();
        this.ready = true;

        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    private buildLight(): void {
        const node = new Node('Sun');
        node.setParent(this.node);
        // солнце сбоку-сверху: так у блоков видно разные по яркости грани
        // и ландшафт читается объёмным, а не плоской заливкой
        node.setRotationFromEuler(-48, -35, 0);
        const light = node.addComponent(DirectionalLight);
        light.illuminance = LIGHT.sunIlluminance;
        const sun = LIGHT.sunColor;
        light.color = new Color((sun >> 16) & 0xff, (sun >> 8) & 0xff, sun & 0xff);
        light.shadowEnabled = LIGHT.shadows;

        if (LIGHT.shadows) {
            // фиксированная область теней вокруг арены: камера не двигается,
            // и каскады (CSM) тут только тратили бы кадр на мобилках
            light.shadowFixedArea = true;
            light.shadowOrthoSize = LIGHT.shadowOrthoSize;
            light.shadowNear = 0.1;
            light.shadowFar = 80;
            light.shadowPcf = renderer.scene.PCFType.SOFT;
            light.shadowSaturation = LIGHT.shadowSaturation;
            light.shadowBias = 0.0008;
            light.shadowNormalBias = 0.02;
            // при фиксированной области тень снимается из позиции самого света:
            // ставим его над центром арены, отступив назад вдоль луча
            const centerZ = (ARENA.spawnPos.z + ARENA.basePos.z) / 2;
            const fwd = node.forward;
            node.setPosition(-fwd.x * 30, -fwd.y * 30, centerZ - fwd.z * 30);
        }

        // без заметного ambient теневые грани блоков уходят в чёрный
        const globals = director.getScene()?.globals;
        if (globals && LIGHT.shadows) {
            globals.shadows.enabled = true;
            globals.shadows.type = renderer.scene.ShadowType.ShadowMap;
            globals.shadows.shadowMapSize = LIGHT.shadowMapSize;
        }
        if (globals) {
            // ambient задаётся линейным цветом 0..1, а не 0..255
            globals.ambient.skyColor = new Vec4(0.52, 0.64, 0.85, 1);
            globals.ambient.skyIllum = 32000;
            globals.ambient.groundAlbedo = new Vec4(0.28, 0.34, 0.26, 1);
        }
    }

    onDestroy(): void {
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    update(dt: number): void {
        if (!this.ready) return;
        this.syncLayout(false);
        Audio.tick(dt);
        this.arena.tick(dt);
        this.game.update(dt);
        this.ui.update(dt);
    }

    /** Экран мог повернуться или смениться размером — пересобираем камеру и UI. */
    private syncLayout(force: boolean): void {
        const size = screen.windowSize;
        const w = Math.max(1, Math.round(size.width));
        const h = Math.max(1, Math.round(size.height));
        if (!force && w === this.lastW && h === this.lastH) return;
        this.lastW = w;
        this.lastH = h;

        applyResolution(w, h);
        this.rig.refresh(w, h, true);
        // Canvas должен пересчитаться под новое дизайн-разрешение раньше,
        // чем виджеты начнут по нему выравниваться
        this.ui.syncCanvas();
        this.ui.refreshLayout(w, h);
        this.view.setBillboardTilt(w <= h ? CAMERA.tiltPortrait : CAMERA.tiltLandscape);
    }

    private onTouchEnd(event: EventTouch): void {
        if (!this.ready) return;
        // браузер пускает звук только после жеста пользователя
        Audio.unlock();
        Audio.playMusic();
        const loc = event.getLocation();
        if (this.ui.isPointOverUI(loc.x, loc.y)) return;
        if (!this.rig.screenToGround(loc.x, loc.y, this.groundPoint, UNIT_LEVEL)) return;
        this.game.tapWorld(this.groundPoint.x, this.groundPoint.z);
    }
}
