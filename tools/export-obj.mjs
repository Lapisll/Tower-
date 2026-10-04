/**
 * Выгрузить модель из .glb в OBJ + MTL + текстуру — для авторига в Mixamo.
 *
 *   npm run export-obj -- <путь к .glb> <имя>
 *
 * Результат: art-src/mixamo/<имя>/ (obj, mtl, png). Mixamo принимает это
 * одним zip-архивом. Tripo не всегда справляется с ригом нестандартных
 * пропорций (гоблин, голем: весь скин на одной кости), а Mixamo ригует
 * гуманоидов надёжно и отдаёт скелет mixamorig:* — тот, что понимает RigAnimator.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [src, name] = process.argv.slice(2);
if (!src || !name) {
    console.log('npm run export-obj -- <путь к .glb> <имя>');
    process.exit(1);
}

const buf = readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = buf.subarray(20 + jsonLen + 8);

function read(index) {
    const a = json.accessors[index];
    const v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const rd = {
        5126: (o) => bin.readFloatLE(o),
        5125: (o) => bin.readUInt32LE(o),
        5123: (o) => bin.readUInt16LE(o),
        5121: (o) => bin.readUInt8(o),
    }[a.componentType];
    const stride = v.byteStride || n * size;
    const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = [];
    for (let k = 0; k < a.count; k++) {
        const e = [];
        for (let c = 0; c < n; c++) e.push(rd(off + k * stride + c * size));
        out.push(n === 1 ? e[0] : e);
    }
    return out;
}

const outDir = join(ROOT, 'art-src', 'mixamo', name);
mkdirSync(outDir, { recursive: true });

const lines = [`mtllib ${name}.mtl`, `o ${name}`];
let base = 0;
let texWritten = false;
const used = new Set(json.nodes.filter((n) => n.mesh != null).map((n) => n.mesh));
for (const [mi, mesh] of json.meshes.entries()) {
    if (!used.has(mi)) continue;
    for (const prim of mesh.primitives) {
        const P = read(prim.attributes.POSITION);
        const N = prim.attributes.NORMAL != null ? read(prim.attributes.NORMAL) : null;
        const T = prim.attributes.TEXCOORD_0 != null ? read(prim.attributes.TEXCOORD_0) : null;
        const I = prim.indices != null ? read(prim.indices) : P.map((_, i) => i);
        for (const p of P) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
        if (N) for (const n of N) lines.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
        // у glTF v растёт вниз, у OBJ — вверх
        if (T) for (const t of T) lines.push(`vt ${t[0]} ${1 - t[1]}`);
        lines.push('usemtl body');
        for (let t = 0; t < I.length; t += 3) {
            const f = [I[t], I[t + 1], I[t + 2]].map((i) => {
                const k = base + i + 1;
                return `${k}/${T ? k : ''}/${N ? k : ''}`;
            });
            lines.push(`f ${f.join(' ')}`);
        }
        base += P.length;

        const mat = prim.material != null ? json.materials[prim.material] : null;
        const texIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
        if (!texWritten && texIndex != null) {
            const img = json.images[json.textures[texIndex].source];
            const view = json.bufferViews[img.bufferView];
            const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
            await sharp(bytes).png().toFile(join(outDir, `${name}.png`));
            texWritten = true;
        }
    }
}

writeFileSync(join(outDir, `${name}.obj`), lines.join('\n') + '\n');
writeFileSync(
    join(outDir, `${name}.mtl`),
    `newmtl body\nKd 1 1 1\n${texWritten ? `map_Kd ${name}.png\n` : ''}`
);
console.log(`  ${name}: ${base} вершин -> art-src/mixamo/${name}/ (obj, mtl${texWritten ? ', png' : ''})`);
