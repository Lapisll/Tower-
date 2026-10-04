import { Director, Node, director } from 'cc';
import { Bootstrap } from './Bootstrap';

/**
 * Поднимает игру на любой сцене, даже полностью пустой.
 *
 * Плейбл целиком собирается кодом, поэтому в .scene нечего хранить — а раз так,
 * незачем и требовать ручного перетаскивания Bootstrap на узел в редакторе
 * (после пересохранения сцены такие связи любят слетать).
 * Если Bootstrap уже висит на узле вручную — второй раз не создаём.
 */
director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
    const scene = director.getScene();
    if (!scene) return;
    if (scene.getComponentInChildren(Bootstrap)) return;

    const root = new Node('GameRoot');
    root.setParent(scene);
    root.addComponent(Bootstrap);
});
