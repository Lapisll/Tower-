/**
 * Ужимает текстуры внутри .glb, не трогая геометрию.
 *
 * Tripo отдаёт модели с крупными PNG: у типовой модели ~86% веса — это текстура,
 * а сам меш занимает считаные десятки килобайт. Для плейбла, где весь билд должен
 * влезть в пару мегабайт, это главный (и почти единственный) резерв.
 *
 *   npm run shrink              все модели, 512px, JPEG q80
 *   npm run shrink -- 256       все модели, 256px
 *   npm run shrink -- 512 grunt только grunt
 *
 * Оригинал копируется в art-src/originals/ — если пережали слишком сильно,
 * откатиться можно без повторной генерации (и без траты кредитов).
 */
import {
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    copyFileSync,
    mkdirSync,
    renameSync,
    statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'assets', 'resources', 'Models');
/**
 * Бэкапы держим ВНЕ assets: папка resources попадает в билд целиком, и оригиналы
 * вернули бы в плейбл те самые мегабайты, ради которых всё и затевалось.
 */
const BACKUP = join(ROOT, 'art-src', 'originals');
const QUALITY = 80;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function parseGlb(buf) {
    if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('это не GLB');
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset < buf.length) {
        const len = buf.readUInt32LE(offset);
        const type = buf.readUInt32LE(offset + 4);
        const data = buf.subarray(offset + 8, offset + 8 + len);
        if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
        else if (type === CHUNK_BIN) bin = data;
        offset += 8 + len + ((4 - ((8 + len) % 4)) % 4);
    }
    if (!json || !bin) throw new Error('в GLB нет JSON или BIN чанка');
    return { json, bin };
}

function buildGlb(json, bin) {
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    const binPad = (4 - (bin.length % 4)) % 4;

    const total =
        12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;
    const out = Buffer.alloc(total);

    out.writeUInt32LE(GLB_MAGIC, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(total, 8);

    let p = 12;
    out.writeUInt32LE(jsonBuf.length + jsonPad, p);
    out.writeUInt32LE(CHUNK_JSON, p + 4);
    jsonBuf.copy(out, p + 8);
    out.fill(0x20, p + 8 + jsonBuf.length, p + 8 + jsonBuf.length + jsonPad); // JSON добивается пробелами
    p += 8 + jsonBuf.length + jsonPad;

    out.writeUInt32LE(bin.length + binPad, p);
    out.writeUInt32LE(CHUNK_BIN, p + 4);
    bin.copy(out, p + 8);
    out.fill(0, p + 8 + bin.length, p + 8 + bin.length + binPad); // BIN добивается нулями

    return out;
}

async function shrink(file, maxSize) {
    const original = readFileSync(file);
    const { json, bin } = parseGlb(original);

    const images = json.images ?? [];
    if (images.length === 0) {
        console.log(`  ${file}: текстур нет, пропускаю`);
        return null;
    }

    // сначала пережимаем картинки, потом собираем BIN заново
    const replacement = new Map();
    for (const img of images) {
        if (img.bufferView === undefined) continue;
        const view = json.bufferViews[img.bufferView];
        const src = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        const resized = await sharp(src)
            .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: QUALITY, mozjpeg: true })
            .toBuffer();
        replacement.set(img.bufferView, resized);
        img.mimeType = 'image/jpeg';
    }

    // BIN пересобирается целиком: у картинок изменилась длина, значит поехали
    // смещения всех последующих bufferView, включая геометрию
    const parts = [];
    let cursor = 0;
    json.bufferViews.forEach((view, i) => {
        const data =
            replacement.get(i) ??
            bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        const pad = (4 - (cursor % 4)) % 4;
        if (pad > 0) {
            parts.push(Buffer.alloc(pad));
            cursor += pad;
        }
        view.byteOffset = cursor;
        view.byteLength = data.length;
        parts.push(data);
        cursor += data.length;
    });

    const newBin = Buffer.concat(parts);
    if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length;

    // метка «уже ужато»: по ней отличаем повторное сжатие от новой модели
    // под старым именем (у свежего файла из Tripo метки нет)
    const alreadyShrunk = !!json.asset?.extras?.shrunk;
    json.asset = { ...json.asset, extras: { ...json.asset?.extras, shrunk: true } };
    const out = buildGlb(json, newBin);

    mkdirSync(BACKUP, { recursive: true });
    const backup = join(BACKUP, `${basename(file)}.orig`);
    // пережимаем из самого оригинала — бэкап тот же, перекладывать нечего
    const sameAsBackup = existsSync(backup) && readFileSync(backup).equals(original);
    // производная от исходника (например, герой после split-weapon) — исходник не трогаем
    const derived = !!json.asset?.extras?.derived;
    if (existsSync(backup) && !alreadyShrunk && !sameAsBackup && !derived) {
        // пришла новая модель — старый исходник не затираем, а откладываем с датой
        const stamp = new Date(statSync(backup).mtimeMs).toISOString().slice(0, 10);
        renameSync(backup, join(BACKUP, `${basename(file)}.${stamp}.orig`));
    }
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, out);

    return { before: original.length, after: out.length };
}

const [sizeArg, nameArg] = process.argv.slice(2);
const maxSize = Number(sizeArg) || 512;

if (!existsSync(MODELS)) {
    console.error('Нет папки assets/resources/Models — сначала сгенерь модели.');
    process.exit(1);
}

const files = readdirSync(MODELS)
    .filter((f) => f.endsWith('.glb'))
    .filter((f) => !nameArg || f === `${nameArg}.glb`);

if (files.length === 0) {
    console.error(nameArg ? `Нет модели ${nameArg}.glb` : 'Моделей не найдено.');
    process.exit(1);
}

console.log(`Ужимаю текстуры до ${maxSize}px, JPEG q${QUALITY}\n`);
let before = 0;
let after = 0;

for (const f of files.sort()) {
    const res = await shrink(join(MODELS, f), maxSize);
    if (!res) continue;
    before += res.before;
    after += res.after;
    const saved = Math.round((1 - res.after / res.before) * 100);
    console.log(
        `  ${f.replace('.glb', '').padEnd(12)} ` +
            `${(res.before / 1024).toFixed(0).padStart(5)} КБ -> ` +
            `${(res.after / 1024).toFixed(0).padStart(5)} КБ  (-${saved}%)`
    );
}

console.log(
    `\nИтого: ${(before / 1024 / 1024).toFixed(2)} МБ -> ${(after / 1024 / 1024).toFixed(2)} МБ`
);
console.log('Оригиналы лежат в art-src/originals/ — если качество просело, откатись оттуда.');
