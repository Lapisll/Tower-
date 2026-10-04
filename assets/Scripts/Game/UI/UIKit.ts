import {
    Camera,
    LabelOutline,
    LabelShadow,
    Canvas,
    Color,
    Graphics,
    Label,
    Layers,
    Node,
    ResolutionPolicy,
    Sprite,
    SpriteFrame,
    UITransform,
    Vec2,
    Vec3,
    Widget,
    view,
} from 'cc';
import { UI } from '../ViewConfig';

/**
 * Весь интерфейс собирается кодом: ни префабов, ни атласов, ни шрифтов —
 * плейблу важен вес, а Graphics рисует панели и кнопки векторно.
 */

export function hexColor(hex: number, alpha = 255): Color {
    return new Color((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, alpha);
}

function uiNode(name: string, parent: Node): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    node.setParent(parent);
    return node;
}

export interface CanvasBundle {
    node: Node;
    canvas: Canvas;
    camera: Camera;
}

export function createCanvas(parent: Node): CanvasBundle {
    const camNode = new Node('UICamera');
    camNode.layer = Layers.Enum.UI_2D;
    camNode.setParent(parent);
    camNode.setPosition(0, 0, 1000);
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.near = -2000;
    camera.far = 2000;
    camera.visibility = Layers.Enum.UI_2D;
    camera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
    // рисуем поверх 3D-сцены
    camera.priority = 1;

    const node = uiNode('Canvas', parent);
    const canvas = node.addComponent(Canvas);
    canvas.cameraComponent = camera;

    return { node, canvas, camera };
}

/**
 * Держим 750 по узкой стороне: в портрете тянется высота, в ландшафте — ширина.
 * Благодаря этому кнопки остаются одного физического размера в обеих ориентациях.
 */
export function applyResolution(width: number, height: number): void {
    const portrait = width <= height;
    view.setDesignResolutionSize(
        UI.designWidth,
        UI.designHeight,
        portrait ? ResolutionPolicy.FIXED_WIDTH : ResolutionPolicy.FIXED_HEIGHT
    );
}

export function transform(node: Node, w: number, h: number): UITransform {
    const ui = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    ui.setContentSize(w, h);
    return ui;
}

export interface PanelOptions {
    radius?: number;
    color?: number;
    alpha?: number;
    borderColor?: number;
    borderWidth?: number;
}

export function panel(parent: Node, w: number, h: number, opts: PanelOptions = {}): Node {
    const node = uiNode('Panel', parent);
    transform(node, w, h);
    const g = node.addComponent(Graphics);
    redrawPanel(g, w, h, opts);
    return node;
}

/**
 * Вертикальный градиент скруглённым прямоугольником.
 * Graphics градиенты не умеет, поэтому набираем его полосами — на кнопке
 * этого достаточно, чтобы плашка перестала выглядеть плоской заливкой.
 */
export function gradientRoundRect(
    g: Graphics,
    w: number,
    h: number,
    radius: number,
    topHex: number,
    bottomHex: number,
    bands = 18
): void {
    const top = hexColor(topHex);
    const bottom = hexColor(bottomHex);
    for (let i = 0; i < bands; i++) {
        const t0 = i / bands;
        const t1 = (i + 1) / bands;
        const y0 = h / 2 - h * t1;
        const bandH = h * (t1 - t0) + 0.5; // нахлёст, чтобы не было швов
        // крайние полосы скругляем, середину рисуем прямоугольниками
        const r = i === 0 || i === bands - 1 ? Math.min(radius, bandH) : 0;
        g.fillColor = new Color(
            Math.round(top.r + (bottom.r - top.r) * t0),
            Math.round(top.g + (bottom.g - top.g) * t0),
            Math.round(top.b + (bottom.b - top.b) * t0),
            255
        );
        const inset = i === 0 || i === bands - 1 ? 0 : 0;
        g.roundRect(-w / 2 + inset, y0, w - inset * 2, bandH, r);
        g.fill();
    }
}

export function redrawPanel(g: Graphics, w: number, h: number, opts: PanelOptions = {}): void {
    const radius = opts.radius ?? 18;
    g.clear();
    g.fillColor = hexColor(opts.color ?? UI.colors.panel, opts.alpha ?? 255);
    g.roundRect(-w / 2, -h / 2, w, h, radius);
    g.fill();
    if (opts.borderColor !== undefined) {
        g.lineWidth = opts.borderWidth ?? 4;
        g.strokeColor = hexColor(opts.borderColor);
        g.roundRect(-w / 2, -h / 2, w, h, radius);
        g.stroke();
    }
}

export interface LabelOptions {
    size?: number;
    color?: number;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    width?: number;
    lineHeight?: number;
    /** толщина обводки: заголовок без неё теряется на пёстром фоне */
    outline?: number;
    outlineColor?: number;
    shadow?: boolean;
}

export function label(parent: Node, text: string, opts: LabelOptions = {}): Label {
    const node = uiNode('Label', parent);
    const lbl = node.addComponent(Label);
    lbl.string = text;
    lbl.fontSize = opts.size ?? 30;
    lbl.lineHeight = opts.lineHeight ?? (opts.size ?? 30) * 1.25;
    lbl.color = hexColor(opts.color ?? UI.colors.text);
    lbl.isBold = opts.bold ?? false;
    lbl.horizontalAlign =
        opts.align === 'left'
            ? Label.HorizontalAlign.LEFT
            : opts.align === 'right'
              ? Label.HorizontalAlign.RIGHT
              : Label.HorizontalAlign.CENTER;
    lbl.verticalAlign = Label.VerticalAlign.CENTER;
    if (opts.width) {
        lbl.overflow = Label.Overflow.RESIZE_HEIGHT;
        transform(node, opts.width, lbl.lineHeight);
    }
    if (opts.outline) {
        const outline = node.addComponent(LabelOutline);
        outline.width = opts.outline;
        outline.color = hexColor(opts.outlineColor ?? 0x0b0e16);
    }
    if (opts.shadow) {
        const shadow = node.addComponent(LabelShadow);
        shadow.color = hexColor(0x000000, 160);
        shadow.offset = new Vec2(0, -4);
        shadow.blur = 2;
    }
    return lbl;
}

export interface ButtonHandle {
    node: Node;
    label: Label;
    setText(text: string): void;
    setEnabled(on: boolean): void;
    readonly enabled: boolean;
}

export interface ButtonOptions extends PanelOptions {
    fontSize?: number;
    textColor?: number;
    disabledColor?: number;
    /** нижний цвет градиента; без него плашка рисуется плоской заливкой */
    gradientTo?: number;
}

export function button(
    parent: Node,
    w: number,
    h: number,
    text: string,
    onClick: () => void,
    opts: ButtonOptions = {}
): ButtonHandle {
    const node = uiNode('Button', parent);
    transform(node, w, h);
    const g = node.addComponent(Graphics);

    const baseColor = opts.color ?? UI.colors.accent;
    const disabledColor = opts.disabledColor ?? UI.colors.disabled;
    let enabled = true;

    const paint = () => {
        g.clear();
        if (enabled && opts.gradientTo !== undefined) {
            gradientRoundRect(g, w, h, opts.radius ?? 18, baseColor, opts.gradientTo);
            if (opts.borderColor !== undefined) {
                g.lineWidth = opts.borderWidth ?? 4;
                g.strokeColor = hexColor(opts.borderColor);
                g.roundRect(-w / 2, -h / 2, w, h, opts.radius ?? 18);
                g.stroke();
            }
        } else {
            redrawPanel(g, w, h, { ...opts, color: enabled ? baseColor : disabledColor });
        }
    };
    paint();

    const lbl = label(node, text, {
        size: opts.fontSize ?? 34,
        color: opts.textColor ?? 0x1a1f2b,
        bold: true,
        outline: opts.gradientTo !== undefined ? 3 : 0,
        outlineColor: 0x14301c,
    });
    lbl.node.setPosition(0, 0, 0);

    node.on(Node.EventType.TOUCH_START, () => {
        if (!enabled) return;
        node.setScale(0.96, 0.96, 1);
    });
    node.on(Node.EventType.TOUCH_CANCEL, () => node.setScale(1, 1, 1));
    node.on(Node.EventType.TOUCH_END, () => {
        node.setScale(1, 1, 1);
        if (enabled) onClick();
    });

    return {
        node,
        label: lbl,
        setText: (t: string) => {
            lbl.string = t;
        },
        setEnabled: (on: boolean) => {
            enabled = on;
            lbl.color = hexColor(on ? (opts.textColor ?? 0x1a1f2b) : UI.colors.textDim);
            paint();
        },
        get enabled() {
            return enabled;
        },
    };
}

/** Горизонтальная полоска (HP базы, прогресс волны). */
export interface BarHandle {
    node: Node;
    setRatio(r: number): void;
}

export function bar(parent: Node, w: number, h: number, fillColor: number, backColor: number): BarHandle {
    const node = uiNode('Bar', parent);
    transform(node, w, h);
    const back = node.addComponent(Graphics);
    back.fillColor = hexColor(backColor);
    back.roundRect(-w / 2, -h / 2, w, h, h / 2);
    back.fill();

    const fillNode = uiNode('Fill', node);
    transform(fillNode, w, h);
    const fill = fillNode.addComponent(Graphics);

    const draw = (r: number) => {
        const clamped = Math.max(0, Math.min(1, r));
        fill.clear();
        if (clamped <= 0.001) return;
        fill.fillColor = hexColor(fillColor);
        fill.roundRect(-w / 2, -h / 2, w * clamped, h, h / 2);
        fill.fill();
    };
    draw(1);

    return { node, setRatio: draw };
}

export type AlignSpec = {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    centerX?: boolean;
    centerY?: boolean;
};

export function align(node: Node, spec: AlignSpec): Widget {
    const w = node.getComponent(Widget) ?? node.addComponent(Widget);
    w.isAlignTop = spec.top !== undefined;
    w.isAlignBottom = spec.bottom !== undefined;
    w.isAlignLeft = spec.left !== undefined;
    w.isAlignRight = spec.right !== undefined;
    w.isAlignHorizontalCenter = !!spec.centerX;
    w.isAlignVerticalCenter = !!spec.centerY;
    if (spec.top !== undefined) w.top = spec.top;
    if (spec.bottom !== undefined) w.bottom = spec.bottom;
    if (spec.left !== undefined) w.left = spec.left;
    if (spec.right !== undefined) w.right = spec.right;
    w.alignMode = Widget.AlignMode.ALWAYS;
    w.updateAlignment();
    return w;
}

/**
 * Картинка, натянутая как 9-slice: углы сохраняют размер, тянется только
 * середина. Для кнопок и рамок обязательна — простое растягивание разносит
 * толщину золотой окантовки по ширине.
 */
export function slicedImage(
    parent: Node,
    frame: SpriteFrame,
    w: number,
    h: number,
    inset: number
): Node {
    const node = uiNode('Sliced', parent);
    transform(node, w, h);
    frame.insetLeft = inset;
    frame.insetRight = inset;
    frame.insetTop = inset;
    frame.insetBottom = inset;
    const sprite = node.addComponent(Sprite);
    // режим размера — ДО картинки: иначе спрайт подгоняет узел под исходный
    // размер текстуры (монета 96px вместо 34, рамка 412px вместо 206)
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.type = Sprite.Type.SLICED;
    sprite.spriteFrame = frame;
    transform(node, w, h);
    return node;
}

/** Простая картинка без растяжения пропорций. */
export function image(parent: Node, frame: SpriteFrame, w: number, h: number): Node {
    const node = uiNode('Image', parent);
    transform(node, w, h);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = frame;
    // на всякий случай возвращаем заданный размер: см. slicedImage
    transform(node, w, h);
    return node;
}

/** Кружок-иконка класса, пока нет нормальных артов. */
export function circleIcon(parent: Node, radius: number, hex: number, glyph: string): Node {
    const node = uiNode('Icon', parent);
    transform(node, radius * 2, radius * 2);
    const g = node.addComponent(Graphics);
    g.fillColor = hexColor(hex);
    g.circle(0, 0, radius);
    g.fill();
    const lbl = label(node, glyph, { size: radius * 1.1, bold: true, color: 0x101520 });
    lbl.node.setPosition(new Vec3(0, 0, 0));
    return node;
}
