import {
    Camera,
    Canvas,
    Color,
    Graphics,
    Label,
    Node,
    Sprite,
    UIOpacity,
    UITransform,
    Vec3,
    Widget,
    view,
    LabelOutline,
} from 'cc';
import type { UnitKind } from '../../Sim/SimTypes';
import { SYNERGY, UNITS, UNIT_ORDER, WAVES } from '../../Sim/Balance';
import { ENEMY_VIEW, JUICE, UI, UNIT_LEVEL } from '../ViewConfig';
import { STRINGS } from '../Strings';
import { UI_IMAGES, getSprite, heroPortraitPath, unitIconPath } from '../AssetSlots';
import {
    align,
    bar,
    button,
    image,
    slicedImage,
    createCanvas,
    hexColor,
    label,
    panel,
    redrawPanel,
    transform,
    type BarHandle,
    type ButtonHandle,
} from './UIKit';

/** Куда показывает обучающая рука. */
export type TutorialTarget =
    | { at: 'card'; kind: UnitKind }
    | { at: 'world'; x: number; z: number }
    | { at: 'start' }
    | null;

export interface GameUICallbacks {
    onPickUnit(kind: UnitKind): void;
    onStartWave(): void;
    onCta(): void;
}

interface ShopCard {
    kind: UnitKind;
    node: Node;
    graphics: Graphics;
    /** обводка выбора отдельным слоем поверх картинок, иначе рамка её закроет */
    highlight: Graphics;
    /** картинки, которые сереют, когда героя не на что купить */
    tinted: Sprite[];
    /** есть картинка-рамка — тогда фон Graphics не рисуем */
    skinned: boolean;
    priceLabel: Label;
    countLabel: Label;
    selected: boolean;
    affordable: boolean;
}

const CARD_W = 206;
const CARD_H = 218;

/**
 * Все экраны плейбла: HUD, магазин, баннер волны и финальный CTA.
 * Лейаут перестраивается под ориентацию — магазин уезжает вниз в портрете
 * и вбок в ландшафте, чтобы не закрывать арену.
 */
export class GameUI {
    readonly root: Node;
    readonly camera: Camera;
    private readonly canvas: Canvas;

    private readonly cb: GameUICallbacks;

    private hudPanel!: Node;
    private coinsLabel!: Label;
    /** иконка монеты в HUD — сюда летят монеты за убийства */
    private hudCoin: Node | null = null;
    /** число на счётчике; во время боя растёт по прилёту монет */
    private shownCoins = 0;
    /** меняется при setCoins: монеты, вылетевшие до этого, уже ничего не добавят */
    private coinEpoch = 0;
    private coinPunch = 0;
    private fxLayer!: Node;
    private damageFlash!: UIOpacity;
    private damageGraphics: Graphics | null = null;
    private damageTimer = 0;
    private readonly flyers: {
        node: Node;
        from: Vec3;
        to: Vec3;
        t: number;
        dur: number;
        add: number;
        epoch: number;
    }[] = [];
    private readonly popups: { node: Node; fade: UIOpacity; t: number; y0: number }[] = [];
    private waveLabel!: Label;
    private wavePhaseLabel!: Label;
    private baseBar!: BarHandle;
    private baseHpLabel!: Label;

    private shopPanel!: Node;
    private shopGraphics!: Graphics;
    private shopFrame: Node | null = null;
    private hudFrame: Node | null = null;
    private readonly cards: ShopCard[] = [];
    private hintLabel!: Label;
    private synergyLabel!: Label;
    private startButton!: ButtonHandle;

    private bannerNode!: Node;
    private bannerTitle!: Label;
    private bannerSub!: Label;
    private bannerTimer = 0;

    private overlay!: Node;
    private overlayTitle!: Label;
    private overlaySub!: Label;
    private ctaButton!: ButtonHandle;
    private ctaPulse = 0;
    private overlayContent: Node | null = null;
    private raysNode: Node | null = null;
    private readonly packHeroes: Node[] = [];

    private portrait = true;

    private handNode!: Node;
    private handTime = 0;
    private handTarget: TutorialTarget = null;
    /** 3D-камера нужна, чтобы навести руку на площадку в мире */
    private worldCamera: Camera | null = null;

    constructor(parent: Node, cb: GameUICallbacks) {
        this.cb = cb;
        const bundle = createCanvas(parent);
        this.root = bundle.node;
        this.camera = bundle.camera;
        this.canvas = bundle.canvas;

        this.buildHud();
        this.buildShop();
        this.buildBanner();
        this.buildFxLayer();
        this.buildOverlay();
        this.buildHand();
    }

    /**
     * Подогнать Canvas под текущее дизайн-разрешение и пересчитать виджеты.
     * Canvas умеет это сам, но только по своему событию ресайза, а мы меняем
     * разрешение вручную — поэтому выставляем размер и ортокамеру явно.
     */
    syncCanvas(): void {
        const visible = view.getVisibleSize();
        const ui = this.root.getComponent(UITransform);
        if (ui) ui.setContentSize(visible.width, visible.height);
        this.camera.orthoHeight = visible.height / 2;
        for (const w of this.root.getComponentsInChildren(Widget)) w.updateAlignment();
        this.redrawDamageFlash();
    }

    setWorldCamera(camera: Camera): void {
        this.worldCamera = camera;
    }

    // -- обучающая рука ------------------------------------------------------

    private buildHand(): void {
        this.handNode = new Node('Hand');
        this.handNode.layer = this.root.layer;
        this.handNode.setParent(this.root);
        transform(this.handNode, 80, 80);

        const art = getSprite(UI_IMAGES.tutorialHand);
        if (art) {
            // кончик пальца — в середине верхнего края картинки (замерено по альфе:
            // u 0.51, v 0). Сдвигаем картинку так, чтобы кончик пришёлся ровно
            // в начало узла руки: тогда узел ставится прямо в точку цели
            const hand = image(this.handNode, art, UI.handSize, UI.handSize);
            const size = hand.getComponent(UITransform)!.contentSize;
            hand.setPosition(-size.width * UI.handTipU + size.width * 0.5, -size.height * 0.5, 0);
            this.handNode.active = false;
            return;
        }

        const g = this.handNode.addComponent(Graphics);
        // кружок-«палец» с хвостиком — читается на любом фоне и не требует картинки
        g.fillColor = hexColor(UI.colors.text);
        g.circle(0, 0, 18);
        g.fill();
        g.lineWidth = 6;
        g.strokeColor = hexColor(UI.colors.accent);
        g.circle(0, 0, 28);
        g.stroke();
        g.fillColor = hexColor(UI.colors.accent);
        g.moveTo(6, -22);
        g.lineTo(30, -50);
        g.lineTo(-2, -42);
        g.close();
        g.fill();

        this.handNode.active = false;
    }

    setTutorial(target: TutorialTarget): void {
        this.handTarget = target;
        this.handNode.active = target !== null;
    }

    private updateHand(dt: number): void {
        if (!this.handTarget || !this.handNode.active) return;
        this.handTime += dt * 4;
        // «тап»: палец касается цели и отходит вниз — в верхней точке он ровно в цели
        const bob = -Math.abs(Math.sin(this.handTime)) * UI.handTapDepth;

        let pos: Vec3 | null = null;
        if (this.handTarget.at === 'card') {
            const kind = this.handTarget.kind;
            const card = this.cards.find((c) => c.kind === kind);
            // в центр портрета — туда и тапают
            if (card) pos = card.node.getWorldPosition().add3f(0, UI.portraitY, 0);
        } else if (this.handTarget.at === 'start') {
            pos = this.startButton.node.getWorldPosition();
        } else if (this.worldCamera && this.camera) {
            // мир -> экран -> интерфейс. Высота — верх постамента (UNIT_LEVEL):
            // при наклонной камере точка на другой высоте уезжает по экрану
            const screenPt = new Vec3();
            this.worldCamera.worldToScreen(
                new Vec3(this.handTarget.x, UNIT_LEVEL, this.handTarget.z),
                screenPt
            );
            pos = new Vec3();
            this.camera.screenToWorld(screenPt, pos);
        }

        if (pos) this.handNode.setWorldPosition(pos.x, pos.y + bob, 0);
    }

    // -- HUD -----------------------------------------------------------------

    private buildHud(): void {
        this.hudPanel = panel(this.root, 700, 104, { color: UI.colors.panel, alpha: 225, radius: 24 });
        align(this.hudPanel, { top: 24, centerX: true });

        // плашка волны растянута на весь HUD — на ней же монеты и HP базы
        const plate = getSprite(UI_IMAGES.hudPlate);
        if (plate) {
            this.hudFrame = slicedImage(this.hudPanel, plate, 700, 104, UI.hudPlateInset);
            this.hudFrame.setSiblingIndex(0);
            this.hudPanel.getComponent(Graphics)?.clear();
        }

        const coinArt = getSprite(UI_IMAGES.coin);
        if (coinArt) {
            this.hudCoin = image(this.hudPanel, coinArt, 50, 50);
            this.hudCoin.setPosition(-288, 0, 0);
        }
        const coins = label(this.hudPanel, '500', { size: 40, bold: true, color: UI.colors.accent, outline: 4 });
        coins.node.setPosition(-212, 0, 0);
        this.coinsLabel = coins;

        const wave = label(this.hudPanel, STRINGS.waveBanner(1), { size: 36, bold: true, outline: 4 });
        wave.node.setPosition(0, 10, 0);
        this.waveLabel = wave;
        const waveCap = label(this.hudPanel, STRINGS.phasePrepare, { size: 20, color: UI.colors.textDim });
        waveCap.node.setPosition(0, -24, 0);
        this.wavePhaseLabel = waveCap;

        this.baseBar = this.buildBaseBar();
        this.baseHpLabel = label(this.baseBar.node, '100', { size: 22, bold: true, outline: 3 });
        this.baseHpLabel.node.setPosition(0, 2, 0);
    }

    /**
     * HP базы: та же рамка и глянцевая заливка, что у врагов, и иконка замка.
     * Нет картинок — старая простая полоска.
     */
    private buildBaseBar(): BarHandle {
        const frameArt = getSprite(UI_IMAGES.hpFrame);
        const fillArt = getSprite(UI_IMAGES.hpFill);
        const castle = getSprite(UI_IMAGES.castleIcon);
        if (!frameArt || !fillArt) {
            const plain = bar(this.hudPanel, 190, 20, UI.colors.good, 0x0d1220);
            plain.node.setPosition(195, 4, 0);
            return plain;
        }
        const w = UI.baseBarWidth;
        const h = w / ENEMY_VIEW.frameAspect;
        const root = new Node('BaseBar');
        root.layer = this.hudPanel.layer;
        root.setParent(this.hudPanel);
        root.setPosition(350 - 24 - w / 2, 0, 0);

        slicedImage(root, frameArt, w, h, 10);
        // заливка растёт от левого края паза: якорь слева, ширина = доля HP
        const slotW = w * ENEMY_VIEW.slotWidth;
        const fill = new Node('Fill');
        fill.layer = root.layer;
        fill.setParent(root);
        const ft = transform(fill, slotW, h * ENEMY_VIEW.slotHeight);
        ft.setAnchorPoint(0, 0.5);
        fill.setPosition(-slotW / 2, h * ENEMY_VIEW.slotOffsetY, 0);
        const sprite = fill.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = fillArt;
        transform(fill, slotW, h * ENEMY_VIEW.slotHeight);
        sprite.color = hexColor(UI.colors.good);

        if (castle) image(root, castle, 52, 52).setPosition(-w / 2 - 22, 2, 0);

        return {
            node: root,
            setRatio: (r: number) => {
                const k = Math.max(0, Math.min(1, r));
                transform(fill, slotW * k, h * ENEMY_VIEW.slotHeight);
                sprite.color = hexColor(k < UI.baseBarLow ? UI.colors.bad : UI.colors.good);
            },
        };
    }

    setCoins(value: number): void {
        this.shownCoins = Math.max(0, Math.round(value));
        this.coinEpoch++;
        this.coinsLabel.string = String(this.shownCoins);
    }

    // -- сочность: монеты, всплывашки, вспышка урона ---------------------------

    /** Слой эффектов: над HUD и магазином, но под финальным экраном и рукой. */
    private buildFxLayer(): void {
        this.fxLayer = new Node('FxLayer');
        this.fxLayer.layer = this.root.layer;
        this.fxLayer.setParent(this.root);

        // вспышка урона — красная рамка по краям экрана, середина прозрачная
        const flash = new Node('DamageFlash');
        flash.layer = this.root.layer;
        flash.setParent(this.fxLayer);
        transform(flash, 10, 10);
        this.damageGraphics = flash.addComponent(Graphics);
        this.damageFlash = flash.addComponent(UIOpacity);
        this.damageFlash.opacity = 0;
        this.redrawDamageFlash();
    }

    /** Рамку рисуем по реальному видимому размеру: в ландшафте он другой. */
    private redrawDamageFlash(): void {
        if (!this.damageGraphics) return;
        const size = view.getVisibleSize();
        const hw = size.width / 2;
        const hh = size.height / 2;
        const edge = Math.min(hw, hh) * 0.28;
        const g = this.damageGraphics;
        g.clear();
        g.fillColor = hexColor(UI.colors.bad, JUICE.damageFlashAlpha);
        g.rect(-hw, hh - edge, hw * 2, edge);
        g.rect(-hw, -hh, hw * 2, edge);
        g.rect(-hw, -hh + edge, edge, hh * 2 - edge * 2);
        g.rect(hw - edge, -hh + edge, edge, hh * 2 - edge * 2);
        g.fill();
    }

    /** Враг дошёл до замка: красная вспышка по краям. */
    flashDamage(): void {
        this.damageTimer = JUICE.damageFlashTime;
    }

    /**
     * Убийство: «+N» над врагом и несколько монет, летящих дугой в счётчик.
     * Число на счётчике растёт по мере прилёта — награда видна сразу, а не в конце волны.
     */
    flyCoins(worldX: number, worldZ: number, amount: number): void {
        if (!this.worldCamera) {
            this.setCoins(this.shownCoins + amount);
            return;
        }
        const screenPt = new Vec3();
        this.worldCamera.worldToScreen(new Vec3(worldX, 1.4, worldZ), screenPt);
        const from = new Vec3();
        this.camera.screenToWorld(screenPt, from);
        from.z = 0;

        const popup = label(this.fxLayer, `+${amount}`, {
            size: 34,
            bold: true,
            color: UI.colors.accent,
            outline: 4,
        });
        popup.node.setWorldPosition(from);
        // гасим всю надпись целиком: у Label отдельно гаснет текст, а обводка висела бы призраком
        const fade = popup.node.addComponent(UIOpacity);
        this.popups.push({ node: popup.node, fade, t: 0, y0: popup.node.position.y });

        const art = getSprite(UI_IMAGES.coin);
        const target = (this.hudCoin ?? this.coinsLabel.node).getWorldPosition();
        const n = art ? Math.max(1, JUICE.coinsPerKill) : 1;
        let left = amount;
        for (let i = 0; i < n; i++) {
            const add = i === n - 1 ? left : Math.floor(amount / n);
            left -= add;
            const node = art ? image(this.fxLayer, art, JUICE.coinSize, JUICE.coinSize) : new Node('Coin');
            if (!art) {
                node.layer = this.root.layer;
                node.setParent(this.fxLayer);
            }
            node.setWorldPosition(from);
            this.flyers.push({
                node,
                from: from.clone(),
                to: target.clone(),
                // монеты стартуют вразнобой — летят «струйкой», а не одним комком
                t: -i * 0.07,
                dur: JUICE.coinFlyTime * (0.9 + Math.random() * 0.2),
                add,
                epoch: this.coinEpoch,
            });
        }
    }

    private updateJuice(dt: number): void {
        for (let i = this.flyers.length - 1; i >= 0; i--) {
            const f = this.flyers[i];
            f.t += dt;
            const k = Math.max(0, Math.min(1, f.t / f.dur));
            const e = k * k; // разгон к счётчику
            // дуга: квадратичная кривая через точку выше середины
            const mx = (f.from.x + f.to.x) / 2 + (f.from.x < f.to.x ? -80 : 80);
            const my = Math.max(f.from.y, f.to.y) + 120;
            const x = (1 - e) * (1 - e) * f.from.x + 2 * (1 - e) * e * mx + e * e * f.to.x;
            const y = (1 - e) * (1 - e) * f.from.y + 2 * (1 - e) * e * my + e * e * f.to.y;
            f.node.setWorldPosition(x, y, 0);
            const s = f.t < 0 ? 0 : 1 - e * 0.35;
            f.node.setScale(s, s, 1);
            if (k >= 1) {
                f.node.destroy();
                this.flyers.splice(i, 1);
                // волна могла закончиться, пока монета летела, — тогда счётчик уже верный
                if (f.epoch === this.coinEpoch) {
                    this.shownCoins += f.add;
                    this.coinsLabel.string = String(this.shownCoins);
                    this.coinPunch = 0.18;
                }
            }
        }

        for (let i = this.popups.length - 1; i >= 0; i--) {
            const p = this.popups[i];
            p.t += dt;
            const k = p.t / JUICE.popupLife;
            const pos = p.node.position;
            p.node.setPosition(pos.x, p.y0 + JUICE.popupRise * (1 - (1 - k) * (1 - k)), 0);
            const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.6 : 1.2 - Math.min(0.2, (k - 0.15) * 0.4);
            p.node.setScale(s, s, 1);
            p.fade.opacity = Math.round(255 * Math.max(0, Math.min(1, (1 - k) * 2.5)));
            if (k >= 1) {
                p.node.destroy();
                this.popups.splice(i, 1);
            }
        }

        // счётчик «подпрыгивает» на каждой прилетевшей монете
        if (this.coinPunch > 0) this.coinPunch = Math.max(0, this.coinPunch - dt);
        const punch = 1 + Math.sin((this.coinPunch / 0.18) * Math.PI) * 0.25;
        this.coinsLabel.node.setScale(punch, punch, 1);
        if (this.hudCoin) this.hudCoin.setScale(punch, punch, 1);

        if (this.damageTimer > 0) {
            this.damageTimer = Math.max(0, this.damageTimer - dt);
            this.damageFlash.opacity = Math.round(255 * (this.damageTimer / JUICE.damageFlashTime));
        }
    }

    setWave(index: number, phase: string): void {
        this.waveLabel.string = `${STRINGS.waveBanner(index + 1)}/${WAVES.length}`;
        this.wavePhaseLabel.string = phase;
    }

    setBaseHp(hp: number, max: number): void {
        const ratio = max > 0 ? hp / max : 0;
        this.baseBar.setRatio(ratio);
        this.baseHpLabel.string = `${Math.max(0, Math.round(hp))}`;
    }

    // -- магазин -------------------------------------------------------------

    private buildShop(): void {
        this.shopPanel = panel(this.root, 700, 372, { color: UI.colors.panel, alpha: 235, radius: 28 });
        this.shopGraphics = this.shopPanel.getComponent(Graphics)!;

        const frame = getSprite(UI_IMAGES.panelFrame);
        if (frame) {
            this.shopFrame = slicedImage(this.shopPanel, frame, 700, 372, 70);
            this.shopFrame.setSiblingIndex(0);
        }

        this.hintLabel = label(this.shopPanel, STRINGS.hintPickUnit, {
            size: 22,
            color: UI.colors.textDim,
        });

        this.synergyLabel = label(this.shopPanel, '', { size: 22, bold: true, color: UI.colors.good });

        for (const kind of UNIT_ORDER) {
            this.cards.push(this.buildCard(kind));
        }

        this.startButton = button(
            this.shopPanel,
            300,
            74,
            STRINGS.startBattle,
            () => this.cb.onStartWave(),
            {
                radius: 22,
                color: 0xffd97a,
                gradientTo: 0xd99a25,
                borderColor: 0x7a5410,
                borderWidth: 3,
                textColor: 0x2a1c05,
            }
        );
    }

    private buildCard(kind: UnitKind): ShopCard {
        const stats = UNITS[kind];
        const node = panel(this.shopPanel, CARD_W, CARD_H, {
            color: UI.colors.panelSoft,
            radius: 20,
            borderColor: UI.colors.cardBorder,
            borderWidth: 3,
        });
        const graphics = node.getComponent(Graphics)!;
        const tinted: Sprite[] = [];

        const frameArt = getSprite(UI_IMAGES.cardFrame);
        if (frameArt) {
            const frame = slicedImage(node, frameArt, CARD_W, CARD_H, UI.cardFrameInset);
            tinted.push(frame.getComponent(Sprite)!);
        }

        // портрет крупнее значка: в карточке покупают персонажа, а не символ
        const portrait = getSprite(heroPortraitPath(kind));
        const art = portrait ?? getSprite(unitIconPath(kind));
        if (art) {
            const size = portrait ? UI.portraitSize : 104;
            const icon = image(node, art, size, size);
            icon.setPosition(0, portrait ? UI.portraitY : 52, 0);
            tinted.push(icon.getComponent(Sprite)!);
        } else {
            const icon = new Node('Glyph');
            icon.layer = node.layer;
            icon.setParent(node);
            icon.setPosition(0, 58, 0);
            transform(icon, 92, 92);
            drawUnitGlyph(icon.addComponent(Graphics), kind, stats.tint);
        }

        // имя и статы на карточке убраны: герой читается по портрету,
        // а мелкий текст в плейбле никто не читает
        const price = label(node, `${stats.cost}`, { size: 32, bold: true, color: UI.colors.accent });
        const coinArt = getSprite(UI_IMAGES.coin);
        if (coinArt) {
            // монетка слева, цена сдвигается вправо — пара остаётся по центру
            const coin = image(node, coinArt, 34, 34);
            coin.setPosition(-30, -90, 0);
            tinted.push(coin.getComponent(Sprite)!);
            price.node.setPosition(16, -92, 0);
        } else {
            price.node.setPosition(0, -92, 0);
        }

        const highlightNode = new Node('Highlight');
        highlightNode.layer = node.layer;
        highlightNode.setParent(node);
        transform(highlightNode, CARD_W, CARD_H);
        const highlight = highlightNode.addComponent(Graphics);

        const count = label(node, '', { size: 20, bold: true, color: UI.colors.good });
        count.node.setPosition(CARD_W / 2 - 22, CARD_H / 2 - 20, 0);

        const card: ShopCard = {
            kind,
            node,
            graphics,
            highlight,
            tinted,
            skinned: !!frameArt,
            priceLabel: price,
            countLabel: count,
            selected: false,
            affordable: true,
        };

        node.on(Node.EventType.TOUCH_END, () => {
            if (card.affordable) this.cb.onPickUnit(kind);
        });

        return card;
    }

    /** Обновить состояние магазина: что по карману, что выбрано, можно ли в бой. */
    updateShop(opts: {
        coins: number;
        selected: UnitKind | null;
        counts: Record<UnitKind, number>;
        canStart: boolean;
        hint: string;
        startText: string;
        synergyKinds: number;
    }): void {
        for (const card of this.cards) {
            const stats = UNITS[card.kind];
            card.affordable = opts.coins >= stats.cost;
            card.selected = opts.selected === card.kind;
            if (card.skinned) {
                // фон даёт картинка; «не по карману» — притемняем её целиком
                card.graphics.clear();
                const shade = card.affordable ? 255 : 110;
                for (const s of card.tinted) s.color = new Color(shade, shade, shade, 255);
                card.highlight.clear();
                if (card.selected) {
                    card.highlight.lineWidth = 6;
                    card.highlight.strokeColor = hexColor(UI.colors.cardSelected);
                    card.highlight.roundRect(-CARD_W / 2 + 3, -CARD_H / 2 + 3, CARD_W - 6, CARD_H - 6, 18);
                    card.highlight.stroke();
                }
            } else {
                redrawPanel(card.graphics, CARD_W, CARD_H, {
                    color: card.affordable ? UI.colors.panelSoft : 0x171c27,
                    radius: 20,
                    borderColor: card.selected ? UI.colors.cardSelected : UI.colors.cardBorder,
                    borderWidth: card.selected ? 6 : 3,
                });
            }
            card.priceLabel.color = hexColor(card.affordable ? UI.colors.accent : UI.colors.disabled);
            const n = opts.counts[card.kind];
            card.countLabel.string = n > 0 ? `x${n}` : '';
        }

        this.hintLabel.string = opts.hint;
        this.startButton.setEnabled(opts.canStart);
        this.startButton.setText(opts.startText);

        if (opts.synergyKinds > 1) {
            const bonus = Math.round(SYNERGY.diversityBonus * (opts.synergyKinds - 1) * 100);
            this.synergyLabel.string = STRINGS.synergyOn(bonus);
        } else {
            this.synergyLabel.string = STRINGS.synergyOff;
        }
        this.synergyLabel.color = hexColor(
            opts.synergyKinds > 1 ? UI.colors.good : UI.colors.textDim
        );
    }

    showShop(on: boolean): void {
        this.shopPanel.active = on;
    }

    // -- баннер волны --------------------------------------------------------

    private buildBanner(): void {
        this.bannerNode = new Node('Banner');
        this.bannerNode.layer = this.root.layer;
        this.bannerNode.setParent(this.root);
        align(this.bannerNode, { centerX: true, centerY: true });

        this.bannerTitle = label(this.bannerNode, '', { size: 74, bold: true, color: UI.colors.accent });
        this.bannerTitle.node.setPosition(0, 18, 0);
        this.bannerSub = label(this.bannerNode, '', { size: 28, color: UI.colors.text });
        this.bannerSub.node.setPosition(0, -44, 0);
        this.bannerNode.active = false;
    }

    showBanner(title: string, sub: string, seconds = 1.6): void {
        this.bannerTitle.string = title;
        this.bannerSub.string = sub;
        this.bannerNode.active = true;
        this.bannerTimer = seconds;
    }

    // -- финальный оверлей ---------------------------------------------------

    /**
     * Пэкшот на весь экран: лучи, крупное название, три героя и кнопка.
     * Без отдельной карточки — фоном служит затемнённая сцена.
     */
    private buildOverlay(): void {
        this.overlay = new Node('Overlay');
        this.overlay.layer = this.root.layer;
        this.overlay.setParent(this.root);
        align(this.overlay, { centerX: true, centerY: true });

        // затемнение во весь экран: панель заведомо больше любого разумного экрана
        panel(this.overlay, 3000, 3000, { color: 0x05070d, alpha: 215, radius: 0 });

        // содержимое — отдельным узлом: в ландшафте его ужимаем целиком
        const content = new Node('Content');
        content.layer = this.root.layer;
        content.setParent(this.overlay);
        this.overlayContent = content;

        const rays = getSprite(UI_IMAGES.rays);
        if (rays) {
            this.raysNode = image(content, rays, 980, 980);
            this.raysNode.setPosition(0, 250, 0);
        }

        const brand = label(content, STRINGS.gameTitle, {
            size: 104,
            bold: true,
            color: UI.colors.accent,
            outline: 9,
            outlineColor: 0x2a1408,
            shadow: true,
        });
        brand.node.setPosition(0, 330, 0);

        // три героя покачиваются под названием — пэкшот не пустой
        const kinds: UnitKind[] = ['archer', 'bomber', 'mage'];
        kinds.forEach((kind, i) => {
            const art = getSprite(heroPortraitPath(kind));
            if (!art) return;
            const hero = image(content, art, UI.packHeroSize, UI.packHeroSize);
            hero.setPosition((i - 1) * 215, i === 1 ? 70 : 40, 0);
            this.packHeroes.push(hero);
        });

        this.overlayTitle = label(content, '', { size: 64, bold: true, outline: 6 });
        this.overlayTitle.node.setPosition(0, -130, 0);
        this.overlaySub = label(content, '', { size: 30, color: UI.colors.text, width: 600, outline: 3 });
        this.overlaySub.node.setPosition(0, -195, 0);

        this.ctaButton = button(content, 520, 130, STRINGS.cta, () => this.cb.onCta(), {
            radius: 32,
            fontSize: 52,
            color: 0x6fe08a,
            gradientTo: 0x2f9a4e,
            borderColor: UI.colors.accent,
            borderWidth: 5,
            // белый текст с тёмной обводкой: тёмно-зелёный на зелёной кнопке не читался
            textColor: 0xffffff,
        });
        this.ctaButton.node.setPosition(0, -330, 0);
        const ctaLabel = this.ctaButton.node.getComponentInChildren(Label);
        if (ctaLabel) {
            const outline = ctaLabel.node.getComponent(LabelOutline) ?? ctaLabel.node.addComponent(LabelOutline);
            outline.width = 5;
            outline.color = hexColor(0x0d3a1c);
        }

        const ctaSkin = getSprite(UI_IMAGES.ctaButton);
        if (ctaSkin) {
            // картинка ложится под текст кнопки, сама кнопка остаётся кликабельной;
            // 9-slice держит золотую окантовку одинаковой толщины на любой ширине
            const skin = slicedImage(this.ctaButton.node, ctaSkin, 540, 140, 48);
            skin.setSiblingIndex(0);
            const g = this.ctaButton.node.getComponent(Graphics);
            if (g) g.clear();
        }

        this.overlay.active = false;
    }

    showResult(win: boolean, title: string, sub: string): void {
        // пэкшот после победы — только логотип и кнопка, без лишнего текста
        this.overlayTitle.string = win ? '' : title;
        this.overlayTitle.color = hexColor(win ? UI.colors.good : UI.colors.bad);
        this.overlaySub.string = win ? '' : sub;
        this.overlay.active = true;
        this.ctaPulse = 0;
    }

    get resultVisible(): boolean {
        return this.overlay.active;
    }

    // -- лейаут и апдейт -----------------------------------------------------

    /** Пересобрать расположение под ориентацию экрана. */
    refreshLayout(width: number, height: number): void {
        const portrait = width <= height;
        this.portrait = portrait;

        if (portrait) {
            redrawPanel(this.shopGraphics, 700, 372, {
                color: UI.colors.panel,
                alpha: 235,
                radius: 28,
            });
            transform(this.shopPanel, 700, 372);
            if (this.shopFrame) transform(this.shopFrame, 700, 372);
            align(this.shopPanel, { bottom: 20, centerX: true });

            this.cards.forEach((c, i) => c.node.setPosition((i - 1) * (CARD_W + 14), 46, 0));
            this.hintLabel.node.setPosition(0, 168, 0);
            this.synergyLabel.node.setPosition(0, -82, 0);
            this.startButton.node.setPosition(0, -136, 0);

            align(this.hudPanel, { top: 24, centerX: true });
            transform(this.hudPanel, 700, 104);
            if (this.hudFrame) transform(this.hudFrame, 700, 104);
            redrawPanel(this.hudPanel.getComponent(Graphics)!, 700, 104, {
                color: UI.colors.panel,
                alpha: this.hudFrame ? 0 : 225,
                radius: 24,
            });
        } else {
            const w = 280;
            const h = 900;
            redrawPanel(this.shopGraphics, w, h, { color: UI.colors.panel, alpha: 235, radius: 28 });
            transform(this.shopPanel, w, h);
            if (this.shopFrame) transform(this.shopFrame, w, h);
            align(this.shopPanel, { right: 24, centerY: true });

            this.cards.forEach((c, i) => c.node.setPosition(0, 250 - i * (CARD_H + 16), 0));
            this.hintLabel.node.setPosition(0, 400, 0);
            this.synergyLabel.node.setPosition(0, -310, 0);
            this.startButton.node.setPosition(0, -370, 0);

            align(this.hudPanel, { top: 20, left: 24 });
            transform(this.hudPanel, 640, 104);
            if (this.hudFrame) transform(this.hudFrame, 640, 104);
            redrawPanel(this.hudPanel.getComponent(Graphics)!, 640, 104, {
                color: UI.colors.panel,
                alpha: this.hudFrame ? 0 : 225,
                radius: 24,
            });
        }
    }

    update(dt: number): void {
        this.updateHand(dt);
        this.updateJuice(dt);
        if (this.bannerTimer > 0) {
            this.bannerTimer -= dt;
            const t = Math.max(0, this.bannerTimer);
            const s = 1 + Math.sin(Math.min(1, t) * Math.PI) * 0.06;
            this.bannerNode.setScale(s, s, 1);
            if (this.bannerTimer <= 0) this.bannerNode.active = false;
        }
        if (this.overlay.active) {
            this.ctaPulse += dt * 3.2;
            const s = 1 + Math.sin(this.ctaPulse) * 0.05;
            this.ctaButton.node.setScale(s, s, 1);
            if (this.raysNode) this.raysNode.angle += dt * UI.raysSpin;
            this.packHeroes.forEach((hero, i) => {
                const k = 1 + Math.sin(this.ctaPulse * 0.8 + i * 1.3) * 0.04;
                hero.setScale(k, k, 1);
            });
            // в ландшафте экран ниже — пэкшот ужимаем, чтобы влез целиком
            const fit = this.portrait ? 1 : 0.62;
            this.overlayContent?.setScale(fit, fit, 1);
        }
    }

    /**
     * Тап пришёлся на интерфейс? Нужно, чтобы клик по магазину не ставил
     * юнита на арену под панелью.
     */
    isPointOverUI(screenX: number, screenY: number): boolean {
        const world = new Vec3();
        this.camera.screenToWorld(new Vec3(screenX, screenY, 0), world);
        const check = (node: Node): boolean => {
            if (!node.activeInHierarchy) return false;
            const ui = node.getComponent(UITransform);
            if (!ui) return false;
            const box = ui.getBoundingBoxToWorld();
            return (
                world.x >= box.xMin &&
                world.x <= box.xMax &&
                world.y >= box.yMin &&
                world.y <= box.yMax
            );
        };
        return check(this.shopPanel) || check(this.hudPanel) || this.overlay.active;
    }
}

/** Простые векторные пиктограммы — надёжнее эмодзи, которых может не быть в системном шрифте. */
function drawUnitGlyph(g: Graphics, kind: UnitKind, tint: number): void {
    g.clear();
    g.fillColor = hexColor(tint);
    g.strokeColor = hexColor(tint);
    g.lineWidth = 7;

    if (kind === 'archer') {
        // стрела вверх-вправо
        g.moveTo(-28, -28);
        g.lineTo(22, 22);
        g.stroke();
        g.moveTo(34, 34);
        g.lineTo(6, 26);
        g.lineTo(26, 6);
        g.close();
        g.fill();
    } else if (kind === 'bomber') {
        g.circle(0, -6, 26);
        g.fill();
        g.moveTo(10, 16);
        g.lineTo(26, 36);
        g.stroke();
    } else {
        // звезда
        const spikes = 5;
        const outer = 34;
        const inner = 15;
        for (let i = 0; i < spikes * 2; i++) {
            const r = i % 2 === 0 ? outer : inner;
            const a = (Math.PI / spikes) * i - Math.PI / 2;
            const x = Math.cos(a) * r;
            const y = Math.sin(a) * r;
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.close();
        g.fill();
    }
}
