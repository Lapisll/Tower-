# Ассеты EVIL TOWER

## Генерация через Tripo

Промпты ниже продублированы в `tools/tripo-prompts.json` — оттуда их берёт скрипт:

```bash
npm run tripo -- list         # что описано и что уже скачано
npm run tripo -- gen archer   # одна модель
npm run tripo -- gen all      # всё, чего ещё нет
```

Ключ читается из `TRIPO_API_KEY` или из `.tripo.key` в корне проекта
(файл в `.gitignore`). Скрипт сам проверяет баланс кредитов и не тратит их впустую.

## Общие требования к моделям

| параметр | значение |
|---|---|
| формат | GLB (или FBX) |
| полигонаж | свой на каждую модель, см. таблицу ниже |
| текстура | одна, 512×512 (мелочь — 256), без PBR-карт |
| стиль | стилизованный low-poly, чистые силуэты, насыщенные цвета |
| ориентация | лицом в **+Z** |
| pivot | в ногах, модель стоит на нуле |
| анимации | не нужны — покачивание и повороты делает код |

Высоты важны: вью масштабирует префаб под `approxHeight` из
`assets/Scripts/Game/AssetSlots.ts`. Если модель сильно другой пропорции —
поправь это число, а не саму модель.

### Сколько полигонов

Бюджет считается не «на глаз», а от того, сколько штук модели одновременно
на экране. Лимиты зашиты в `tools/tripo-prompts.json` и уходят в API как
`face_limit`, так что Tripo сразу отдаёт нужный полигонаж — ретопологию руками
делать не нужно.

| модель | трисов | почему столько |
|---|---|---|
| `grunt` | 900 | их до 22 одновременно — это самая горячая модель в сцене |
| `tank` | 1800 | трое на экране, но крупнее и их разглядывают |
| `archer` / `bomber` | 2000 | до 7 штук, стоят неподвижно близко к камере |
| `mage` | 2200 | +шляпа и посох, силуэт сложнее |
| `base` | 2500 | одна, всегда в кадре |
| `spawnGate` | 900 | одна, мелкая, на заднем плане |
| `boss` | 5000 | один, крупный, финальный кадр перед CTA |

Итого вся сцена в пике ≈ 50k трисов — для мобильного GPU это пустяк.
**Полигоны тут вообще не узкое место.** Узкое место — вес билда и драуколы:

- тысяча трисов в GLB весит ~30 КБ, а одна PNG-текстура 2048×2048 — мегабайты;
- поэтому после генерации ужимай текстуры до 256–512 при импорте в Cocos,
  а геометрию не трогай;
- `npm run tripo -- info` показывает по каждой модели вес, трисы и **долю текстур**
  в этом весе — если доля высокая, режь текстуру, а не меш;
- ориентир: весь плейбл до 5 МБ (у ряда сетей до 2 МБ).

Один материал на модель — тоже важно: каждый лишний материал это лишний драукол
на каждом из 22 гоблинов.

## Что нужно

### Юниты (3 шт.) — стоят на площадках у дороги

| # | ключ | высота | промпт для Tripo |
|---|---|---|---|
| 1 | `archer` | 1.6 | `stylized low-poly fantasy archer, green hooded cloak, wooden bow in hand, standing idle pose, chunky proportions, flat vibrant colors, mobile game asset, clean silhouette` |
| 2 | `bomber` | 1.7 | `stylized low-poly fantasy rock thrower, stocky dwarf with leather apron, heavy stone in raised hand, orange and brown palette, standing idle, mobile game asset` |
| 3 | `mage` | 1.8 | `stylized low-poly fantasy mage, long blue robe, pointed wizard hat, glowing staff with crystal orb, standing idle pose, purple-blue palette, mobile game asset` |

Классы должны отличаться **силуэтом**, а не только цветом: игрок видит их сверху
под углом 62° и мелкими. Шляпа мага, бочкообразный метатель, лук над плечом лучника.

Атакуют они по-разному, и это видно: лучник пускает летящую стрелу, метатель
кидает камень навесом, маг бьёт мгновенной молнией. Снаряды рисуются кодом,
моделей для них не нужно.

### Враги (3 шт.) — идут по дороге к базе

| # | ключ | высота | промпт для Tripo |
|---|---|---|---|
| 4 | `grunt` | 1.3 | `stylized low-poly goblin grunt, small green creature, crude wooden club, hunched running pose, red rag clothing, flat colors, mobile game asset` |
| 5 | `tank` | 1.9 | `stylized low-poly armored orc brute, heavy iron plate armor, horned helmet, massive shoulders, purple and dark steel palette, standing pose, mobile game asset` |
| 6 | `boss` | 3.4 | `stylized low-poly demon warlord boss, huge muscular silhouette, large curved horns, dark armor with glowing red cracks, menacing standing pose, mobile game asset` |

Толстяков (`tank`) в волне трое — они должны читаться как «жирные» мгновенно:
крупнее, темнее, с рогами. Босс — сильно крупнее всех, тот же язык форм.

### Окружение (2 шт.)

| # | ключ | высота | промпт для Tripo |
|---|---|---|---|
| 7 | `base` | 4.0 | `stylized low-poly fantasy castle keep, small square stone tower with blue conical roof, four corner turrets, banner, mobile game asset, flat colors` |
| 8 | `spawnGate` | 2.6 | `stylized low-poly dark stone portal gate, two carved pillars with lintel, cracked purple stone, ominous, mobile game asset` |

### Опционально, для оживления сцены

- `tree` — `stylized low-poly conifer tree, chunky triangular crown, flat green` (сейчас рисуется примитивом)
- `rock` — `stylized low-poly boulder cluster, grey with moss`

## Как подключить

1. Положить префабы в `assets/resources/Models/` (папка `resources` обязательна —
   загрузка идёт через `resources.load`).
2. В `assets/Scripts/Game/AssetSlots.ts` прописать имя:

```ts
export const UNIT_MODELS: Record<UnitKind, ModelSlot> = {
    archer: { prefab: 'Models/archer', approxHeight: 1.6 },
    ...
};
```

Пустая строка `prefab: ''` = рисуем примитив. Так что модели можно подключать
по одной, остальные останутся заглушками — игра продолжит работать.

## Графика интерфейса (не Tripo)

Это 2D, генерить надо картиночной моделью, а класть в `assets/resources/UI/`
и прописывать в `UI_IMAGES` в `assets/Scripts/Game/AssetSlots.ts`.
Пока путь пустой — логотип рисуется текстом, кнопка CTA векторно, всё работает.

| ключ | размер | что это | промпт |
|---|---|---|---|
| `logo` | 840×192 PNG, прозрачный фон | логотип на финальном экране | `game logo "EVIL TOWER", bold fantasy lettering, dark stone letters with glowing red cracks, subtle gold outline, transparent background, mobile game splash logo` |
| `ctaButton` | 920×208 PNG, прозрачный фон | плашка кнопки PLAY NOW | `glossy green call-to-action button, rounded rectangle, gold border, soft inner glow, empty center for text, mobile game UI, transparent background` |

Текст на кнопке всё равно рисуется кодом поверх картинки — так его можно менять
и локализовать без перерисовки.

## Порядок важности

Если делать не всё сразу: сначала **три юнита** (их игрок разглядывает в магазине
и ставит руками), затем **грант и толстяк** (их на экране десяток), потом **босс**,
и в последнюю очередь замок с воротами — примитивы для них выглядят приемлемо.
