/**
 * Генерация UI-графики через Hugging Face Inference Providers.
 *
 *   npm run ui-art -- list                   что описано в ui-prompts.json
 *   npm run ui-art -- gen logoPlate          одна картинка
 *   npm run ui-art -- gen all                все, которых ещё нет
 *   npm run ui-art -- gen all --keep-bg      не вырезать фон
 *
 * Токен берётся из HF_TOKEN либо из файла .hf.key в корне проекта
 * (он в .gitignore). Нужен токен с правом "Inference Providers":
 * https://huggingface.co/settings/tokens
 *
 * Готовые PNG падают в assets/resources/UI/. Дальше пропиши имя в UI_IMAGES
 * в assets/Scripts/Game/AssetSlots.ts.
 *
 * ВАЖНО про текст: модели путают буквы (в тестах выходило «SACNGEL» вместо слов),
 * поэтому промпты просят ПУСТУЮ середину без единой надписи, а текст поверх
 * рисует код — он заодно локализуется и всегда чёткий.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'resources', 'UI');
/** Оригиналы до вырезания фона — вне assets, чтобы не попадали в билд. */
const SRC_DIR = join(ROOT, 'art-src', 'ui');

/**
 * HF маршрутизирует запросы к провайдерам: бесплатный hf-inference эти модели
 * уже не обслуживает (отвечает 410 deprecated), а старый api-inference вообще
 * снят с DNS. Рабочий путь — router + id модели у провайдера.
 * Расход идёт из месячного кредита аккаунта.
 */
const MODEL = 'fal-ai/fast-sdxl';
const ENDPOINT = `https://router.huggingface.co/fal-ai/${MODEL}`;

/**
 * Запасной бесплатный источник: без ключей и лимитов, но ставит водяной знак
 * в правом нижнем углу. Поэтому просим картинку выше нужного и срезаем низ.
 */
const FALLBACK_WATERMARK_CROP = 0.13;
function pollinationsUrl(prompt, width, height) {
    const tall = Math.round(height * (1 + FALLBACK_WATERMARK_CROP));
    return (
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
        `?width=${width}&height=${tall}&model=flux&nologo=true&seed=${Date.now() % 100000}`
    );
}

/** Фон, который вырезаем в прозрачность. Чистая magenta в артах не встречается. */
const CHROMA = { r: 255, g: 0, b: 255 };
const CHROMA_TOLERANCE = 100;

/**
 * Cloudflare Workers AI — основной источник: 10 000 нейронов в сутки бесплатно
 * (это примерно 2000 картинок 512x512 на FLUX-schnell), без водяных знаков,
 * лимит обновляется каждый день. Нужны account id и API-токен с правом
 * "Workers AI": https://dash.cloudflare.com/profile/api-tokens
 */
const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';

function cloudflareCreds() {
    const id = process.env.CF_ACCOUNT_ID;
    const tok = process.env.CF_API_TOKEN;
    if (id && tok) return { id: id.trim(), token: tok.trim() };

    const file = join(ROOT, '.cf.key');
    if (!existsSync(file)) return null;
    // формат файла: первая строка — account id, вторая — токен
    const parts = readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const fileId = (parts[0] || '').trim();
    const fileToken = (parts[1] || '').trim();
    if (!fileToken) return null;
    if (!fileId || fileId.startsWith('PASTE')) {
        console.error('В .cf.key нет Account ID (первая строка).');
        console.error('Он виден в адресной строке дашборда: dash.cloudflare.com/<32 hex символа>/...');
        console.error('или на странице аккаунта справа, поле "Account ID".');
        process.exit(1);
    }
    return { id: fileId.trim(), token: fileToken.trim() };
}

async function fromCloudflare(creds, entry) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${creds.id}/ai/run/${CF_MODEL}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${creds.token}`,
            'Content-Type': 'application/json',
        },
        // flux-schnell сам подбирает размер, поэтому кадрируем уже на нашей стороне
        body: JSON.stringify({ prompt: entry.prompt, steps: 6 }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloudflare HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const b64 = json?.result?.image;
    if (!b64) throw new Error(`Cloudflare: в ответе нет картинки: ${JSON.stringify(json).slice(0, 200)}`);
    return Buffer.from(b64, 'base64');
}

function token() {
    const fromEnv = process.env.HF_TOKEN;
    if (fromEnv) return fromEnv.trim();
    const file = join(ROOT, '.hf.key');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    console.error('Нет ключей ни для одного источника.');
    console.error('Лучший вариант — Cloudflare Workers AI (10k нейронов в сутки бесплатно):');
    console.error('  положи в .cf.key две строки — account id и API-токен с правом Workers AI');
    console.error('  https://dash.cloudflare.com/profile/api-tokens');
    console.error('Либо HF: HF_TOKEN или .hf.key (https://huggingface.co/settings/tokens)');
    process.exit(1);
}

const CF = cloudflareCreds();
// токен HF нужен только если Cloudflare не настроен
const TOKEN = CF ? '' : token();
const prompts = JSON.parse(readFileSync(join(ROOT, 'tools', 'ui-prompts.json'), 'utf8'));

async function generate(name, keepBg) {
    const entry = prompts[name];
    if (!entry) {
        throw new Error(`Нет промпта "${name}". Есть: ${Object.keys(prompts).join(', ')}`);
    }

    let buf = null;
    let source = 'huggingface';

    if (CF) {
        try {
            buf = await fromCloudflare(CF, entry);
            source = 'cloudflare';
        } catch (e) {
            console.log(`  ${name}: Cloudflare не ответил (${e.message.slice(0, 90)}), пробую дальше`);
        }
    }

    // если HF-токена нет (работаем через Cloudflare), не ходим туда с пустым ключом
    const skipHf = !TOKEN;
    const res = buf || skipHf ? { ok: false, status: 0 } : await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            prompt: entry.prompt,
            image_size: { width: entry.width, height: entry.height },
            negative_prompt: 'text, letters, words, watermark, signature, blurry, people',
            num_images: 1,
            // фильтр иногда ложно срабатывает и возвращает чёрный кадр
            enable_safety_checker: false,
        }),
    });

    if (buf) {
        // уже получили картинку из Cloudflare
    } else if (res.ok) {
        // провайдер отдаёт не саму картинку, а ссылку на неё
        const json = await res.json();
        const link = json?.images?.[0]?.url ?? json?.image?.url;
        if (!link) {
            throw new Error(`${name}: в ответе нет картинки: ${JSON.stringify(json).slice(0, 200)}`);
        }
        const img = await fetch(link);
        if (!img.ok) throw new Error(`${name}: не скачалась картинка, HTTP ${img.status}`);
        buf = Buffer.from(await img.arrayBuffer());
    } else if (res.status === 0 || res.status === 402 || res.status === 429) {
        // кредиты кончились или превышен лимит — уходим на бесплатный источник
        const text = res.text ? await res.text().catch(() => '') : '';
        if (res.status !== 0) {
            console.log(`  ${name}: HF недоступен (${res.status}), беру бесплатный источник`);
            if (res.status === 402) console.log(`    ${text.slice(0, 120)}`);
        } else {
            console.log(`  ${name}: беру бесплатный источник`);
        }
        const img = await fetch(pollinationsUrl(entry.prompt, entry.width, entry.height));
        if (!img.ok) throw new Error(`${name}: запасной источник ответил HTTP ${img.status}`);
        buf = Buffer.from(await img.arrayBuffer());
        source = 'pollinations';
    } else {
        const text = await res.text().catch(() => '');
        throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 220)}`);
    }

    // провайдер при сбое отдаёт не ошибку, а чёрный кадр — ловим это явно
    if (source !== 'pollinations' && (await isBlank(buf))) {
        console.log(`  ${name}: провайдер вернул пустой кадр, беру бесплатный источник`);
        const img = await fetch(pollinationsUrl(entry.prompt, entry.width, entry.height));
        if (!img.ok) throw new Error(`${name}: запасной источник ответил HTTP ${img.status}`);
        buf = Buffer.from(await img.arrayBuffer());
        source = 'pollinations';
    }

    if (source === 'pollinations') {
        // срезаем полосу с водяным знаком снизу
        const meta = await sharp(buf).metadata();
        const keep = Math.round((meta.height ?? entry.height) / (1 + FALLBACK_WATERMARK_CROP));
        buf = await sharp(buf).extract({ left: 0, top: 0, width: meta.width ?? entry.width, height: keep }).png().toBuffer();
    }

    // оригинал храним всегда: повторная чистка не должна стоить ещё одной генерации
    mkdirSync(SRC_DIR, { recursive: true });
    writeFileSync(join(SRC_DIR, `${entry.out}.src.png`), buf);

    const outDir = entry.dir ? join(ROOT, 'assets', 'resources', entry.dir) : OUT_DIR;
    mkdirSync(outDir, { recursive: true });
    const ext = entry.tile ? 'jpg' : 'png';
    const file = join(outDir, `${entry.out}.${ext}`);
    const processed = entry.tile
        ? await makeTileable(buf, entry.width, entry.tile)
        : entry.lumaAlpha
        ? await lumaToAlpha(buf, entry.width, entry.height)
        : keepBg
        ? await sharp(buf).resize(entry.width, entry.height, { fit: 'inside' }).png().toBuffer()
        : await cutBackground(buf, entry.width, entry.height, entry);
    writeFileSync(file, processed);
    console.log(
        `  ${name}: assets/resources/${entry.dir ?? 'UI'}/${entry.out}.${ext} ` +
            `(${(processed.length / 1024).toFixed(0)} КБ, источник: ${source})`
    );
}

/**
 * Вырезать фон в прозрачность заливкой от краёв.
 *
 * Простой chroma key не годится: модель может нарисовать фон не того цвета,
 * который просили (у нас вместо magenta вышел белый), и тогда ключ не срабатывает,
 * а по контуру остаются цветные ореолы. Заливка от границ кадра не зависит от
 * конкретного цвета: она идёт от краёв внутрь, пока цвет похож на фоновый,
 * и останавливается на самом рисунке.
 */
/**
 * Дополнительные опции записи в ui-prompts.json:
 *   keepLargest: true  — оставить только самый крупный кусок рисунка; срезает
 *                        тени-эллипсы и подставки, которые модель упорно рисует
 *   bust: 0.62         — оставить верхнюю долю фигуры (портрет по грудь) с
 *                        мягким растворением снизу; нужен, когда модель рисует
 *                        персонажа в полный рост, а в карточке нужно лицо
 */
async function cutBackground(buf, width, height, opts = {}) {
    // работаем в исходном квадрате: растягивать до целевых пропорций нельзя,
    // иначе круглая печать станет овалом. Подгоним размер уже после обрезки.
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    const ch = info.channels;
    const at = (x, y) => (y * w + x) * ch;

    // фоновым считаем усреднённый цвет четырёх углов
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    let br = 0;
    let bg = 0;
    let bb = 0;
    for (const c of corners) {
        br += data[c];
        bg += data[c + 1];
        bb += data[c + 2];
    }
    br /= corners.length;
    bg /= corners.length;
    bb /= corners.length;

    const TOLERANCE = 78;
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;

    const push = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const idx = y * w + x;
        if (visited[idx]) return;
        const p = idx * ch;
        const dr = data[p] - br;
        const dg = data[p + 1] - bg;
        const db = data[p + 2] - bb;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > TOLERANCE) return;
        visited[idx] = 1;
        queue[tail++] = idx;
    };

    for (let x = 0; x < w; x++) {
        push(x, 0);
        push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
        push(0, y);
        push(w - 1, y);
    }

    while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = (idx / w) | 0;
        data[idx * ch + 3] = 0;
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
    }

    if (opts.keepLargest) keepLargestBlob(visited, w, h);

    let fadeFrom = -1;
    let fadeTo = -1;
    if (opts.bust) {
        let top = -1;
        let bottom = -1;
        for (let y = 0; y < h && top < 0; y++) {
            for (let x = 0; x < w; x++) if (!visited[y * w + x]) { top = y; break; }
        }
        for (let y = h - 1; y >= 0 && bottom < 0; y--) {
            for (let x = 0; x < w; x++) if (!visited[y * w + x]) { bottom = y; break; }
        }
        if (top >= 0) {
            fadeTo = Math.round(top + (bottom - top) * opts.bust);
            fadeFrom = Math.round(fadeTo - (bottom - top) * 0.08);
            for (let y = fadeTo; y < h; y++) visited.fill(1, y * w, (y + 1) * w);
        }
    }
    for (let i = 0; i < w * h; i++) if (visited[i]) data[i * ch + 3] = 0;

    // мягкий контур: пиксель на границе с вырезанным фоном приглушаем,
    // иначе по краю остаётся резкая кайма чужого цвета
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            if (visited[idx]) continue;
            const neighbours =
                visited[idx - 1] + visited[idx + 1] + visited[idx - w] + visited[idx + w];
            if (neighbours >= 2) data[idx * ch + 3] = 110;
            else if (neighbours === 1) data[idx * ch + 3] = 190;
        }
    }

    // низ бюста растворяем, а не режем ножом
    if (fadeFrom >= 0) {
        for (let y = Math.max(0, fadeFrom); y < fadeTo; y++) {
            const k = 1 - (y - fadeFrom) / (fadeTo - fadeFrom);
            for (let x = 0; x < w; x++) {
                const a = (y * w + x) * ch + 3;
                data[a] = Math.round(data[a] * k);
            }
        }
    }

    // после вырезания фона обрезаем пустые поля и вписываем в целевой размер
    // с сохранением пропорций — так композиция не искажается
    return sharp(data, { raw: { width: w, height: h, channels: ch } })
        .png()
        .trim({ threshold: 1 })
        // inside, а не contain: contain добивал картинку прозрачными полями до
        // заданных пропорций, и 9-slice растягивал эти поля — видимая рамка
        // оставалась крошечной посередине (логотип занимал 25% своего PNG)
        .resize(width, height, { fit: 'inside' })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

/**
 * Сделать текстуру бесшовной (опция tile: "xy" или "x").
 *
 * Генератор не умеет в настоящий seamless, поэтому склеиваем сами: берём копию,
 * сдвинутую на половину, и плавно подмешиваем её к краям. У сдвинутой копии
 * на краях оказывается середина оригинала, которая непрерывна, — значит, края
 * результата совпадают. "x" — только по горизонтали: для боковой грани блока,
 * где сверху полоса травы, а снизу земля, вертикальный шов не нужен.
 * Размер — степень двойки: иначе WebGL1 не даст повторять текстуру.
 */
async function makeTileable(buf, size, mode) {
    const { data, info } = await sharp(buf)
        .resize(size, size, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const n = info.width;
    const ch = info.channels;
    const out = Buffer.alloc(data.length);
    const both = mode !== 'x';
    // вес оригинала: 1 в центре, 0 на краю
    const weight = (i) => 1 - Math.abs((i + 0.5) / n - 0.5) * 2;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const sx = (x + n / 2) % n;
            const sy = both ? (y + n / 2) % n : y;
            let a = weight(x);
            if (both) a = Math.min(a, weight(y));
            // smoothstep, чтобы переход не читался полосой
            a = a * a * (3 - 2 * a);
            const di = (y * n + x) * ch;
            const si = (sy * n + sx) * ch;
            for (let c = 0; c < ch; c++) out[di + c] = Math.round(data[di + c] * a + data[si + c] * (1 - a));
        }
    }
    // JPEG: альфа текстуре земли не нужна, а весит она втрое меньше PNG
    return sharp(out, { raw: { width: n, height: n, channels: ch } }).jpeg({ quality: 82 }).toBuffer();
}

/**
 * Свечение на чёрном фоне -> прозрачность по яркости (опция lumaAlpha).
 * Вырезка заливкой дала бы резкий край и съела бы мягкое затухание glow;
 * здесь альфа = яркость пикселя, а цвет «разбавляется» обратно до полного.
 */
async function lumaToAlpha(buf, width, height) {
    const { data, info } = await sharp(buf)
        .resize(width, height, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const a = Math.max(r, g, b);
        // тёмный шум фона — в ноль, иначе по краю останется серая дымка
        const alpha = a < 24 ? 0 : a;
        const k = alpha > 0 ? 255 / alpha : 0;
        out[o] = Math.min(255, Math.round(r * k));
        out[o + 1] = Math.min(255, Math.round(g * k));
        out[o + 2] = Math.min(255, Math.round(b * k));
        out[o + 3] = alpha;
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

/** Оставить в маске только самую крупную связную область рисунка. */
function keepLargestBlob(visited, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let best = 0;
    let bestSize = 0;
    let next = 0;
    for (let i = 0; i < w * h; i++) {
        if (visited[i] || label[i]) continue;
        next++;
        let size = 0;
        let sp = 0;
        stack[sp++] = i;
        label[i] = next;
        while (sp > 0) {
            const idx = stack[--sp];
            size++;
            const x = idx % w;
            const n = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, idx - w, idx + w];
            for (const j of n) {
                if (j < 0 || j >= w * h || visited[j] || label[j]) continue;
                label[j] = next;
                stack[sp++] = j;
            }
        }
        if (size > bestSize) {
            bestSize = size;
            best = next;
        }
    }
    for (let i = 0; i < w * h; i++) if (!visited[i] && label[i] !== best) visited[i] = 1;
}

/** Картинка почти одноцветная — значит генерация не удалась. */
async function isBlank(buf) {
    const stats = await sharp(buf).stats();
    return stats.channels.slice(0, 3).every((c) => c.max - c.min < 12);
}

/** Дочистить фон у уже сохранённой картинки (без повторной генерации). */
async function clean(name) {
    const entry = prompts[name];
    if (!entry) throw new Error(`Нет описания "${name}"`);
    // чистим из оригинала, если он сохранён: повторная чистка уже обработанного
    // файла режет по контуру второй раз и выедает картинку
    const src = join(SRC_DIR, `${entry.out}.src.png`);
    const file = join(OUT_DIR, `${entry.out}.png`);
    const from = existsSync(src) ? src : file;
    if (!existsSync(from)) throw new Error(`Нет файла ${from}`);
    const cleaned = await cutBackground(readFileSync(from), entry.width, entry.height, entry);
    writeFileSync(file, cleaned);
    console.log(`  ${name}: фон вычищен (${(cleaned.length / 1024).toFixed(0)} КБ)`);
}

const args = process.argv.slice(2);
const cmd = args[0];
const arg = args[1];
const keepBg = args.includes('--keep-bg');

try {
    if (cmd === 'list' || !cmd) {
        console.log('UI-графика:');
        for (const [name, entry] of Object.entries(prompts)) {
            const has = existsSync(join(OUT_DIR, `${entry.out}.png`));
            console.log(
                `  ${has ? '[есть]' : '[  -  ]'} ${name.padEnd(12)} ` +
                    `${entry.width}x${entry.height}  ${entry.note}`
            );
        }
        console.log('\nnpm run ui-art -- gen <имя>   или   npm run ui-art -- gen all');
    } else if (cmd === 'clean') {
        const targets = arg === 'all' ? Object.keys(prompts) : [arg];
        for (const name of targets) await clean(name);
    } else if (cmd === 'gen') {
        const targets =
            arg === 'all'
                ? Object.keys(prompts).filter((n) => !existsSync(join(OUT_DIR, `${prompts[n].out}.png`)))
                : [arg];
        if (targets.length === 0) {
            console.log('Всё уже сгенерено.');
        }
                console.log(
            `Источник: ${CF ? 'Cloudflare Workers AI' : 'Hugging Face'}` +
                `${keepBg ? '' : ', фон вырезается в прозрачность'}`
        );
        for (const name of targets) await generate(name, keepBg);
        console.log('\nГотово. Пропиши имена в UI_IMAGES (assets/Scripts/Game/AssetSlots.ts).');
    } else {
        console.error(`Неизвестная команда "${cmd}". Есть: list, gen, clean`);
        process.exit(1);
    }
} catch (e) {
    console.error(`\nОшибка: ${e.message}`);
    process.exit(1);
}
