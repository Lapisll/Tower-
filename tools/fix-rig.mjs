/**
 * Починка рига в .glb из Tripo.
 *
 *   npm run fix-rig -- check archer     сверить позы костей с матрицами привязки
 *   npm run fix-rig -- fix archer       восстановить позы костей (оригинал -> art-src/originals)
 *
 * Tripo иногда экспортирует скелет без трансформов у костей: все кости стоят
 * в нуле, а inverse bind matrices при этом правильные. Движок рисует меш по
 * позам костей, и модель сминается в комок. Но поза покоя кости — это просто
 * обратная матрица привязки, так что позы восстанавливаются без потерь:
 * world_j = inverse(IBM_j), local_j = inverse(world_parent) * world_j.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'assets', 'resources', 'Models');
const ORIGINALS = join(ROOT, 'art-src', 'originals');

// -- матрицы 4x4, column-major, как в glTF ------------------------------------

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}

function invert(m) {
    const inv = new Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    const d = 1 / det;
    inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
    inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
    inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
    inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
    inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
    inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
    inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
    inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
    inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
    inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
    inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
    inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
    inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
    inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
    inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
    inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
    return inv;
}

function fromTRS(n) {
    if (n.matrix) return n.matrix.slice();
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

/** Разложить матрицу на перенос/поворот/масштаб (без сдвигов — у костей их нет). */
function toTRS(m) {
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
    // матрица поворота -> кватернион
    const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    const len = Math.hypot(...q);
    return {
        translation: [m[12], m[13], m[14]],
        rotation: q.map((v) => v / len),
        scale: [sx, sy, sz],
    };
}

// -- glb ------------------------------------------------------------------------

function readGlb(file) {
    const buf = readFileSync(file);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const binChunk = buf.subarray(20 + jsonLen);
    const binLen = binChunk.readUInt32LE(0);
    const bin = binChunk.subarray(8, 8 + binLen);
    return { json, bin };
}

function writeGlb(file, json, bin) {
    let text = Buffer.from(JSON.stringify(json), 'utf8');
    const pad = (4 - (text.length % 4)) % 4;
    text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
    const binPad = (4 - (bin.length % 4)) % 4;
    const binBuf = Buffer.concat([bin, Buffer.alloc(binPad)]);
    const total = 12 + 8 + text.length + 8 + binBuf.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(text.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binBuf.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    writeFileSync(file, Buffer.concat([header, jh, text, bh, binBuf]));
}

function readIbms(json, bin, skin) {
    const acc = json.accessors[skin.inverseBindMatrices];
    const view = json.bufferViews[acc.bufferView];
    const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out = [];
    for (let j = 0; j < acc.count; j++) {
        const m = [];
        for (let i = 0; i < 16; i++) m.push(bin.readFloatLE(off + (j * 16 + i) * 4));
        out.push(m);
    }
    return out;
}

/**
 * Позы покоя костей из матриц привязки. Корень скелета привязан к миру через
 * узел-меш: матрицы привязки заданы в пространстве меша, поэтому мир кости
 * считаем как world(mesh) * inverse(IBM).
 */
function restPoses(json, bin) {
    const parent = {};
    json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
    const worldOf = (i) => (i === undefined ? identity() : mul(worldOf(parent[i]), fromTRS(json.nodes[i])));

    const skin = json.skins[0];
    const meshNode = json.nodes.findIndex((n) => n.skin === 0);
    const meshWorld = worldOf(meshNode);
    const ibms = readIbms(json, bin, skin);
    const want = new Map();
    skin.joints.forEach((j, k) => want.set(j, mul(meshWorld, invert(ibms[k]))));
    return { skin, parent, worldOf, want };
}

function check(name) {
    const file = join(MODELS, `${name}.glb`);
    const { json, bin } = readGlb(file);
    if (!json.skins?.length) {
        console.log(`  ${name}: рига нет`);
        return 0;
    }
    const { want, worldOf } = restPoses(json, bin);
    let worst = 0;
    for (const [j, w] of want) {
        const have = worldOf(j);
        const d = Math.hypot(have[12] - w[12], have[13] - w[13], have[14] - w[14]);
        worst = Math.max(worst, d);
    }
    console.log(`  ${name}: костей ${want.size}, макс. расхождение позиций ${worst.toFixed(4)}`);
    return worst;
}

function fix(name) {
    const file = join(MODELS, `${name}.glb`);
    const { json, bin } = readGlb(file);
    if (!json.skins?.length) throw new Error(`${name}: рига нет`);
    const { want, parent } = restPoses(json, bin);

    // идём от корня к листьям: локальная поза = inverse(мир родителя) * мир кости
    const solved = new Map();
    const worldSolved = (i) => {
        if (i === undefined) return identity();
        if (want.has(i)) return want.get(i);
        if (!solved.has(i)) {
            solved.set(i, mul(worldSolved(parent[i]), fromTRS(json.nodes[i])));
        }
        return solved.get(i);
    };
    for (const [j, w] of want) {
        const local = mul(invert(worldSolved(parent[j])), w);
        const n = json.nodes[j];
        delete n.matrix;
        Object.assign(n, toTRS(local));
    }

    mkdirSync(ORIGINALS, { recursive: true });
    const backup = join(ORIGINALS, `${name}.rig-broken.glb`);
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeGlb(file, json, bin);
    console.log(`  ${name}: позы ${want.size} костей восстановлены (оригинал: art-src/originals/${name}.rig-broken.glb)`);
}

const [cmd, name] = process.argv.slice(2);
if (!name || (cmd !== 'check' && cmd !== 'fix')) {
    console.log('npm run fix-rig -- check <модель>   |   npm run fix-rig -- fix <модель>');
    process.exit(1);
}
if (cmd === 'check') check(name);
else {
    fix(name);
    check(name);
}
