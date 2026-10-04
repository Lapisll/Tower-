/**
 * Генерация моделей через Tripo API и складывание их в проект.
 *
 *   npm run tripo -- balance          показать остаток кредитов
 *   npm run tripo -- list             какие модели описаны в tripo-prompts.json
 *   npm run tripo -- gen archer       сгенерить одну
 *   npm run tripo -- gen all          сгенерить все, которых ещё нет
 *
 * Ключ берётся из переменной TRIPO_API_KEY либо из файла .tripo.key в корне
 * проекта (он в .gitignore и в репозиторий не попадает).
 *
 * Готовые .glb падают в assets/resources/Models/. После этого пропиши имя
 * в assets/Scripts/Game/AssetSlots.ts — код подхватит модель вместо примитива.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'resources', 'Models');
const API = 'https://api.tripo3d.ai/v2/openapi';
const POLL_MS = 5000;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Версию модели задаём явно: у разных линеек разная цена, и молчаливый дефолт
 * может оказаться вдвое дороже. H3 с текстурой — 20 кредитов ($0.20) за модель,
 * этого качества плейблу более чем достаточно.
 * Альтернатива: 'v3.1-20260211' (новее), 'v2.5-20250123' (старая линейка).
 */
const MODEL_VERSION = 'v3.0-20250812';
const COST_PER_MODEL = 20;

function apiKey() {
    const fromEnv = process.env.TRIPO_API_KEY;
    if (fromEnv) return fromEnv.trim();
    const file = join(ROOT, '.tripo.key');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    console.error('Нет ключа: задай TRIPO_API_KEY или положи его в .tripo.key');
    process.exit(1);
}

const KEY = apiKey();
const prompts = JSON.parse(readFileSync(join(ROOT, 'tools', 'tripo-prompts.json'), 'utf8'));

async function call(path, init = {}) {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.code !== 0) {
        throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
    }
    return json.data;
}

async function showBalance() {
    const data = await call('/user/balance');
    console.log(`Кредитов на балансе: ${data.balance} (заморожено ${data.frozen})`);
    if (data.balance <= 0) {
        console.log('Баланс пуст — генерация вернёт ошибку. Пополни на tripo3d.ai.');
    }
    return data.balance;
}

function listNames() {
    return Object.keys(prompts);
}

async function createTask(name) {
    const entry = prompts[name];
    if (!entry) throw new Error(`Нет промпта для "${name}". Есть: ${listNames().join(', ')}`);
    const data = await call('/task', {
        method: 'POST',
        body: JSON.stringify({
            type: 'text_to_model',
            model_version: MODEL_VERSION,
            prompt: entry.prompt,
            // лимит свой у каждой модели: он считается от того, сколько штук
            // одновременно на экране, а не «на глаз». См. tripo-prompts.json
            face_limit: entry.faces ?? 2000,
            texture: true,
        }),
    });
    return data.task_id;
}

async function waitTask(taskId, name) {
    const started = Date.now();
    let lastProgress = -1;
    for (;;) {
        const data = await call(`/task/${taskId}`);
        if (data.progress !== lastProgress) {
            lastProgress = data.progress;
            process.stdout.write(`\r  ${name}: ${data.status} ${data.progress ?? 0}%   `);
        }
        if (data.status === 'success') {
            process.stdout.write('\n');
            return data.output;
        }
        if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'banned') {
            throw new Error(`задача ${taskId} -> ${data.status}`);
        }
        if (Date.now() - started > TIMEOUT_MS) throw new Error(`таймаут по задаче ${taskId}`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

async function download(url, file) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`скачивание ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    return buf.length;
}

/**
 * Что внутри .glb: треугольники и, главное, текстуры.
 * В плейбле геометрия почти ничего не весит (тысяча трисов это ~30 КБ),
 * а одна PNG-текстура 2048x2048 легко съедает мегабайты — смотреть надо на них.
 */
function inspectGlb(file) {
    const buf = readFileSync(file);
    if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'

    // первый чанк GLB — JSON-описание сцены
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

    let tris = 0;
    for (const mesh of gltf.meshes ?? []) {
        for (const prim of mesh.primitives ?? []) {
            if (prim.indices === undefined) continue;
            tris += Math.floor((gltf.accessors?.[prim.indices]?.count ?? 0) / 3);
        }
    }

    let textureBytes = 0;
    for (const img of gltf.images ?? []) {
        textureBytes += gltf.bufferViews?.[img.bufferView]?.byteLength ?? 0;
    }

    return { total: buf.length, tris, textureBytes };
}

function showInfo() {
    const files = existsSync(OUT_DIR)
        ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.glb'))
        : [];
    if (files.length === 0) {
        console.log('Моделей ещё нет — сначала npm run tripo -- gen all');
        return;
    }

    const kb = (b) => (b / 1024).toFixed(0).padStart(7);
    console.log('модель           вес КБ   трисы  текстуры КБ  доля текстур');
    let total = 0;
    for (const f of files.sort()) {
        const info = inspectGlb(join(OUT_DIR, f));
        if (!info) {
            console.log(`${f.padEnd(15)} — не похоже на GLB`);
            continue;
        }
        total += info.total;
        const share = info.total > 0 ? Math.round((info.textureBytes / info.total) * 100) : 0;
        console.log(
            f.replace('.glb', '').padEnd(15) +
                kb(info.total) +
                String(info.tris).padStart(8) +
                kb(info.textureBytes) +
                String(share + '%').padStart(13)
        );
    }
    console.log(`
Итого: ${(total / 1024 / 1024).toFixed(2)} МБ`);
    console.log('Ориентир для плейбла: весь билд до 5 МБ, чаще до 2.');
    console.log('Высокая доля текстур — ужимай их до 256-512 при импорте в Cocos,');
    console.log('геометрию трогать незачем: она почти ничего не весит.');
}


async function generate(name) {
    console.log(`\n[${name}] ${prompts[name].prompt.slice(0, 70)}...`);
    const taskId = await createTask(name);
    console.log(`  задача ${taskId}`);
    const out = await waitTask(taskId, name);
    const url = out.pbr_model ?? out.model ?? out.base_model;
    if (!url) throw new Error(`в ответе нет модели: ${JSON.stringify(out)}`);
    const file = join(OUT_DIR, `${name}.glb`);
    const size = await download(url, file);
    console.log(`  сохранено: assets/resources/Models/${name}.glb (${(size / 1024).toFixed(0)} КБ)`);
}

const [cmd, arg] = process.argv.slice(2);

try {
    if (cmd === 'balance') {
        await showBalance();
    } else if (cmd === 'list' || !cmd) {
        console.log('Доступные модели:');
        for (const name of listNames()) {
            const has = existsSync(join(OUT_DIR, `${name}.glb`));
            const p = prompts[name];
            console.log(
                `  ${has ? '[есть]' : '[  -  ]'} ${name.padEnd(12)} ` +
                    `${String(p.faces ?? 2000).padStart(5)} трисов  ${p.note} — ${p.budget ?? ''}`
            );
        }
        console.log('\nnpm run tripo -- gen <имя>   или   npm run tripo -- gen all');
    } else if (cmd === 'info') {
        showInfo();
    } else if (cmd === 'gen') {
        const balance = await showBalance();
        if (balance <= 0) process.exit(1);
        const targets =
            arg === 'all'
                ? listNames().filter((n) => !existsSync(join(OUT_DIR, `${n}.glb`)))
                : [arg];
        if (targets.length === 0) {
            console.log('Всё уже сгенерено.');
        }
        const need = targets.length * COST_PER_MODEL;
        console.log(
            `Модель ${MODEL_VERSION}: ${targets.length} шт x ${COST_PER_MODEL} кредитов = ` +
                `${need} ($${(need / 100).toFixed(2)})`
        );
        if (need > balance) {
            console.error(`Не хватает кредитов: нужно ${need}, есть ${balance}.`);
            process.exit(1);
        }
        for (const name of targets) await generate(name);
        console.log('\nГотово. Открой Cocos, чтобы он импортировал .glb,');
        console.log('затем пропиши имена в assets/Scripts/Game/AssetSlots.ts.');
    } else {
        console.error(`Неизвестная команда "${cmd}". Есть: balance, list, gen, info`);
        process.exit(1);
    }
} catch (e) {
    console.error(`\nОшибка: ${e.message}`);
    process.exit(1);
}
