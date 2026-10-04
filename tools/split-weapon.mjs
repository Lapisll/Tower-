/**
 * Вырезать оружие из модели героя в отдельную модель.
 *
 *   npm run split-weapon -- list archer          показать куски меша
 *   npm run split-weapon -- split archer 1        кусок #1 — оружие
 *   npm run split-weapon -- split mage mesh:2     оружие — целый меш №2
 *
 * Tripo кладёт оружие внутрь модели героя: лук стоит рядом с ногой, валун
 * лежит у ступни, и авториг привязывает их к случайным костям — при анимации
 * их корёжит. Скрипт режет меш на связные куски, выносит оружие в
 * `<герой>_weapon.glb` (только его вершины и текстура, центр — в точке хвата),
 * а из героя его убирает. В руку оружие вкладывает RigAnimator.
 *
 * Источник всегда исходник из art-src/originals/<герой>.glb.orig — повторный
 * запуск даёт тот же результат. После разреза обе модели нужно ужать: npm run shrink.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'assets', 'resources', 'Models');
const ORIGINALS = join(ROOT, 'art-src', 'originals');

/**
 * Где оружие держат: доля высоты от низа. Лук и валун — за середину,
 * посох — чуть выше середины, как держат посох при ходьбе.
 */
const GRIP_HEIGHT = { archer: 0.5, bomber: 0.5, mage: 0.55 };

// -- glb -----------------------------------------------------------------------

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

function readAccessor(json, bin, index) {
    const a = json.accessors[index];
    const v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const read = {
        5126: (o) => bin.readFloatLE(o),
        5125: (o) => bin.readUInt32LE(o),
        5123: (o) => bin.readUInt16LE(o),
        5121: (o) => bin.readUInt8(o),
    }[a.componentType];
    const stride = v.byteStride || n * size;
    const off = (v.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Array(a.count);
    for (let k = 0; k < a.count; k++) {
        if (n === 1) out[k] = read(off + k * stride);
        else {
            const e = new Array(n);
            for (let c = 0; c < n; c++) e[c] = read(off + k * stride + c * size);
            out[k] = e;
        }
    }
    return out;
}

/** Дописать данные в буфер и завести под них bufferView + accessor. */
function appendAccessor(json, chunks, state, data, type, componentType, target, extra = {}) {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const size = componentType === 5126 || componentType === 5125 ? 4 : 2;
    const count = data.length / n;
    const buf = Buffer.alloc(data.length * size);
    data.forEach((v, i) => {
        if (componentType === 5126) buf.writeFloatLE(v, i * 4);
        else if (componentType === 5125) buf.writeUInt32LE(v, i * 4);
        else buf.writeUInt16LE(v, i * 2);
    });
    const pad = (4 - (state.length % 4)) % 4;
    if (pad) {
        chunks.push(Buffer.alloc(pad));
        state.length += pad;
    }
    json.bufferViews.push({ buffer: 0, byteOffset: state.length, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf);
    state.length += buf.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType, count, type, ...extra });
    return json.accessors.length - 1;
}

// -- куски меша ----------------------------------------------------------------

/** Связные куски одного примитива; вершины сварены по позиции (Tripo режет их по UV-швам). */
function components(P, I) {
    const weld = new Map();
    const id = P.map((p) => {
        const k = p.map((v) => Math.round(v * 1e4)).join(',');
        if (!weld.has(k)) weld.set(k, weld.size);
        return weld.get(k);
    });
    const parent = Array.from({ length: weld.size }, (_, i) => i);
    const find = (x) => {
        while (parent[x] !== x) x = parent[x] = parent[parent[x]];
        return x;
    };
    for (let t = 0; t < I.length; t += 3) {
        const a = find(id[I[t]]);
        parent[find(id[I[t + 1]])] = a;
        parent[find(id[I[t + 2]])] = a;
    }
    const map = new Map();
    for (let t = 0; t < I.length; t += 3) {
        const r = find(id[I[t]]);
        if (!map.has(r)) map.set(r, []);
        map.get(r).push(t / 3);
    }
    return [...map.values()].sort((a, b) => b.length - a.length);
}

/** Все куски модели: и связные части примитивов, и отдельные меши. */
function listParts(json, bin) {
    const parts = [];
    json.meshes.forEach((mesh, mi) => {
        mesh.primitives.forEach((prim, pi) => {
            const P = readAccessor(json, bin, prim.attributes.POSITION);
            const I = prim.indices != null ? readAccessor(json, bin, prim.indices) : P.map((_, i) => i);
            for (const tris of components(P, I)) parts.push({ mesh: mi, prim: pi, tris, P, I });
        });
    });
    return parts.sort((a, b) => b.tris.length - a.tris.length);
}

function bounds(part) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of part.tris) {
        for (let c = 0; c < 3; c++) {
            const p = part.P[part.I[t * 3 + c]];
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], p[k]);
                max[k] = Math.max(max[k], p[k]);
            }
        }
    }
    return { min, max };
}

// -- оружие отдельной моделью ---------------------------------------------------

function buildWeapon(src, part, grip) {
    const { json, bin } = src;
    const prim = json.meshes[part.mesh].primitives[part.prim];
    const N = prim.attributes.NORMAL != null ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
    const UV = prim.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;

    // переиндексация: в новую модель идут только вершины оружия
    const remap = new Map();
    const pos = [], nrm = [], uv = [], idx = [];
    for (const t of part.tris) {
        for (let c = 0; c < 3; c++) {
            const v = part.I[t * 3 + c];
            if (!remap.has(v)) {
                remap.set(v, remap.size);
                const p = part.P[v];
                // центр модели — в точке хвата: так её удобно вкладывать в кисть
                pos.push(p[0] - grip[0], p[1] - grip[1], p[2] - grip[2]);
                if (N) nrm.push(...N[v]);
                if (UV) uv.push(...UV[v]);
            }
            idx.push(remap.get(v));
        }
    }

    const out = {
        asset: { version: '2.0', generator: 'tower split-weapon', extras: { derived: true } },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Weapon', mesh: 0 }],
        meshes: [{ name: 'Weapon', primitives: [{ attributes: {}, indices: 0, mode: 4 }] }],
        buffers: [{ byteLength: 0 }],
        bufferViews: [],
        accessors: [],
    };
    const chunks = [];
    const state = { length: 0 };
    const p0 = out.meshes[0].primitives[0];
    const big = remap.size > 65535;
    p0.indices = appendAccessor(out, chunks, state, idx, 'SCALAR', big ? 5125 : 5123, 34963);
    const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
    p0.attributes.POSITION = appendAccessor(out, chunks, state, pos, 'VEC3', 5126, 34962, { min, max });
    if (N) p0.attributes.NORMAL = appendAccessor(out, chunks, state, nrm, 'VEC3', 5126, 34962);
    if (UV) p0.attributes.TEXCOORD_0 = appendAccessor(out, chunks, state, uv, 'VEC2', 5126, 34962);

    // материал: цвет и базовая текстура оружия (нормали и ORM мелкому предмету не нужны)
    const srcMat = prim.material != null ? json.materials[prim.material] : null;
    if (srcMat) {
        const pbr = { ...(srcMat.pbrMetallicRoughness ?? {}) };
        delete pbr.metallicRoughnessTexture;
        const base = pbr.baseColorTexture;
        if (base) {
            const tex = json.textures[base.index];
            const img = json.images[tex.source];
            const view = json.bufferViews[img.bufferView];
            const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
            const pad = (4 - (state.length % 4)) % 4;
            if (pad) {
                chunks.push(Buffer.alloc(pad));
                state.length += pad;
            }
            out.bufferViews.push({ buffer: 0, byteOffset: state.length, byteLength: bytes.length });
            chunks.push(Buffer.from(bytes));
            state.length += bytes.length;
            out.images = [{ bufferView: out.bufferViews.length - 1, mimeType: img.mimeType }];
            out.samplers = tex.sampler != null ? [json.samplers[tex.sampler]] : undefined;
            out.textures = [{ source: 0, ...(out.samplers ? { sampler: 0 } : {}) }];
            pbr.baseColorTexture = { index: 0 };
        }
        out.materials = [{ name: 'Weapon', pbrMetallicRoughness: pbr, doubleSided: !!srcMat.doubleSided }];
        p0.material = 0;
    }
    const binOut = Buffer.concat(chunks);
    out.buffers[0].byteLength = binOut.length;
    return { json: out, bin: binOut, verts: remap.size, tris: part.tris.length };
}

/** Убрать оружие из героя: свои треугольники выкидываем из индексов, отдельный меш — отцепляем. */
function stripFromHero(src, part, wholeMesh) {
    const { json, bin } = src;
    json.asset = { ...json.asset, extras: { ...(json.asset.extras ?? {}), derived: true } };
    if (wholeMesh) {
        for (const node of json.nodes) {
            if (node.mesh === part.mesh) {
                delete node.mesh;
                delete node.skin;
            }
        }
        return bin;
    }
    const prim = json.meshes[part.mesh].primitives[part.prim];
    const drop = new Set(part.tris);
    const keep = [];
    for (let t = 0; t < part.I.length / 3; t++) {
        if (!drop.has(t)) keep.push(part.I[t * 3], part.I[t * 3 + 1], part.I[t * 3 + 2]);
    }
    const chunks = [bin];
    const state = { length: bin.length };
    const big = part.P.length > 65535;
    prim.indices = appendAccessor(json, chunks, state, keep, 'SCALAR', big ? 5125 : 5123, 34963);
    const out = Buffer.concat(chunks);
    json.buffers[0].byteLength = out.length;
    return out;
}

// -- cli -------------------------------------------------------------------------

const [cmd, name, which] = process.argv.slice(2);
const source = join(ORIGINALS, `${name}.glb.orig`);
if (!name || !existsSync(source)) {
    console.log('npm run split-weapon -- list <герой>   |   split <герой> <номер куска | mesh:N>');
    console.log(name ? `Нет исходника ${source}` : '');
    process.exit(1);
}

const src = readGlb(source);
const parts = listParts(src.json, src.bin);

if (cmd === 'list') {
    parts.slice(0, 12).forEach((p, i) => {
        const b = bounds(p);
        const size = b.max.map((v, k) => (v - b.min[k]).toFixed(2)).join('x');
        const center = b.min.map((v, k) => ((v + b.max[k]) / 2).toFixed(2)).join(',');
        console.log(`  #${i}  mesh${p.mesh}  треуг. ${String(p.tris.length).padStart(5)}  размер ${size}  центр ${center}`);
    });
} else if (cmd === 'split') {
    const wholeMesh = String(which).startsWith('mesh:');
    let part;
    if (wholeMesh) {
        const m = Number(which.slice(5));
        const inMesh = parts.filter((p) => p.mesh === m);
        // целый меш: собираем все его куски в один
        part = { ...inMesh[0], tris: inMesh.flatMap((p) => p.tris) };
    } else {
        part = parts[Number(which)];
    }
    if (!part) throw new Error(`Нет куска ${which}`);

    const b = bounds(part);
    const k = GRIP_HEIGHT[name] ?? 0.5;
    const grip = [(b.min[0] + b.max[0]) / 2, b.min[1] + (b.max[1] - b.min[1]) * k, (b.min[2] + b.max[2]) / 2];

    const weapon = buildWeapon(src, part, grip);
    writeGlb(join(MODELS, `${name}_weapon.glb`), weapon.json, weapon.bin);
    const heroBin = stripFromHero(src, part, wholeMesh);
    writeGlb(join(MODELS, `${name}.glb`), src.json, heroBin);
    console.log(
        `  ${name}: оружие -> ${name}_weapon.glb (${weapon.tris} треуг., ${weapon.verts} верш.), ` +
            `хват ${grip.map((v) => v.toFixed(2)).join(',')}; из героя убрано`
    );
} else {
    console.log('Команды: list | split');
}
