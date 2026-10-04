/**
 * Упростить геометрию статичной модели (пропсы, декор).
 *
 *   npm run simplify -- tree 0.15            оставить ~15% треугольников
 *   npm run simplify -- tree 0.15 --dry      только посчитать, файл не трогать
 *
 * Tripo отдаёт любой предмет в ~6.5k треугольников — цветок размером в полблока
 * весит как герой. Двадцать таких предметов, да ещё с тенями, — это сотни тысяч
 * треугольников на кадр и 20 FPS. Упрощаем meshoptimizer'ом; границы UV-островов
 * закрепляем, иначе на швах текстуры появятся дыры. Текстуры и материалы не трогаем.
 *
 * Модель правится на месте; копия до упрощения — art-src/originals/<имя>.pre-simplify.glb.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'assets', 'resources', 'Models');
const ORIGINALS = join(ROOT, 'art-src', 'originals');

function readGlb(file) {
    const buf = readFileSync(file);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const binChunk = buf.subarray(20 + jsonLen);
    const bin = Buffer.from(binChunk.subarray(8, 8 + binChunk.readUInt32LE(0)));
    return { json, bin };
}

function writeGlb(file, json, bin) {
    let text = Buffer.from(JSON.stringify(json), 'utf8');
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const body = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + text.length + 8 + body.length, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(text.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(body.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    writeFileSync(file, Buffer.concat([header, jh, text, bh, body]));
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Прочитать accessor в плоский Float32Array / Uint32Array. */
function readFlat(json, bin, index) {
    const a = json.accessors[index];
    const v = json.bufferViews[a.bufferView];
    const n = COMPONENTS[a.type];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const stride = v.byteStride || n * size;
    const off = (v.byteOffset || 0) + (a.byteOffset || 0);
    const out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
    for (let k = 0; k < a.count; k++) {
        for (let c = 0; c < n; c++) {
            const o = off + k * stride + c * size;
            out[k * n + c] =
                a.componentType === 5126
                    ? bin.readFloatLE(o)
                    : a.componentType === 5125
                      ? bin.readUInt32LE(o)
                      : a.componentType === 5123
                        ? bin.readUInt16LE(o)
                        : bin.readUInt8(o);
        }
    }
    return { data: out, n, type: a.type, componentType: a.componentType };
}

async function simplify(name, ratio, dry) {
    await MeshoptSimplifier.ready;
    const file = join(MODELS, `${name}.glb`);
    const { json, bin } = readGlb(file);
    if (json.skins?.length) throw new Error(`${name}: модель со скелетом — упрощать нельзя, сломается скиннинг`);

    // новый бинарник: сначала переносим картинки, потом пишем упрощённую геометрию
    const chunks = [];
    let length = 0;
    const views = [];
    const push = (buf, target) => {
        const pad = (4 - (length % 4)) % 4;
        if (pad) {
            chunks.push(Buffer.alloc(pad));
            length += pad;
        }
        views.push({ buffer: 0, byteOffset: length, byteLength: buf.length, ...(target ? { target } : {}) });
        chunks.push(buf);
        length += buf.length;
        return views.length - 1;
    };
    for (const img of json.images ?? []) {
        const v = json.bufferViews[img.bufferView];
        img.bufferView = push(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
    }

    const accessors = [];
    let before = 0;
    let after = 0;
    for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
            const pos = readFlat(json, bin, prim.attributes.POSITION);
            const idx = prim.indices != null
                ? readFlat(json, bin, prim.indices).data
                : Uint32Array.from({ length: pos.data.length / 3 }, (_, i) => i);
            before += idx.length / 3;

            const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
            // LockBorder: края UV-островов (там вершины разрезаны) не двигаем —
            // иначе на швах текстуры появятся щели
            const [simplified] = MeshoptSimplifier.simplify(idx, pos.data, 3, target, 0.05, ['LockBorder']);
            after += simplified.length / 3;

            // уплотнение: оставляем только вершины, на которые ссылаются треугольники
            const remap = new Map();
            const newIdx = new Uint32Array(simplified.length);
            simplified.forEach((v, i) => {
                if (!remap.has(v)) remap.set(v, remap.size);
                newIdx[i] = remap.get(v);
            });
            const order = [...remap.keys()];

            const attrs = {};
            for (const [semantic, accIndex] of Object.entries(prim.attributes)) {
                const src = semantic === 'POSITION' ? pos : readFlat(json, bin, accIndex);
                const out = new Float32Array(order.length * src.n);
                order.forEach((v, i) => {
                    for (let c = 0; c < src.n; c++) out[i * src.n + c] = src.data[v * src.n + c];
                });
                const acc = { componentType: 5126, count: order.length, type: src.type };
                if (semantic === 'POSITION') {
                    acc.min = [0, 1, 2].map((c) => Math.min(...order.map((_, i) => out[i * 3 + c])));
                    acc.max = [0, 1, 2].map((c) => Math.max(...order.map((_, i) => out[i * 3 + c])));
                }
                acc.bufferView = push(Buffer.from(out.buffer), 34962);
                accessors.push(acc);
                attrs[semantic] = accessors.length - 1;
            }
            const big = order.length > 65535;
            const idxBuf = big ? Buffer.from(newIdx.buffer) : Buffer.from(Uint16Array.from(newIdx).buffer);
            accessors.push({
                bufferView: push(idxBuf, 34963),
                componentType: big ? 5125 : 5123,
                count: newIdx.length,
                type: 'SCALAR',
            });
            prim.attributes = attrs;
            prim.indices = accessors.length - 1;
        }
    }

    const pct = ((after / before) * 100).toFixed(0);
    console.log(`  ${name.padEnd(12)} ${String(before).padStart(6)} -> ${String(after).padStart(5)} треуг. (${pct}%)`);
    if (dry) return;

    json.accessors = accessors;
    json.bufferViews = views;
    const out = Buffer.concat(chunks);
    json.buffers = [{ byteLength: out.length }];
    json.asset = { ...json.asset, extras: { ...(json.asset.extras ?? {}), simplified: ratio } };

    mkdirSync(ORIGINALS, { recursive: true });
    const backup = join(ORIGINALS, `${name}.pre-simplify.glb`);
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeGlb(file, json, out);
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [name, ratioArg] = args.filter((a) => !a.startsWith('--'));
const ratio = Number(ratioArg);
if (!name || !(ratio > 0 && ratio <= 1)) {
    console.log('npm run simplify -- <модель> <доля 0..1> [--dry]');
    process.exit(1);
}
await simplify(name, ratio, dry);
