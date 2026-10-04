import { Camera, Color, Node, screen } from 'cc';
import { applyResolution, createCanvas } from './UIKit';

/**
 * Экран на время загрузки: просто чёрный. Без своей камеры сцена пустая,
 * и движок показывает серый кадр — чёрный выглядит как обычный старт.
 * Возвращает корневой узел — его достаточно уничтожить, когда всё готово.
 */
export function showSplash(parent: Node): Node {
    const size = screen.windowSize;
    applyResolution(Math.max(1, size.width), Math.max(1, size.height));

    const root = new Node('Splash');
    root.setParent(parent);
    const bundle = createCanvas(root);
    bundle.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    bundle.camera.clearColor = new Color(0, 0, 0, 255);
    return root;
}
