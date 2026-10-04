import { Color, Material, Mesh, MeshRenderer, Node, Texture2D, Vec3, gfx, primitives, utils } from 'cc';

/**
 * Примитивы вместо моделей.
 *
 * Пока не приехали модели из Tripo, вся сцена собирается из боксов, цилиндров
 * и сфер — играть и тюнить баланс можно уже сейчас. Меши и материалы кешируются
 * по параметрам, так что сотня врагов не плодит сотню материалов.
 */

const materialCache = new Map<string, Material>();
const meshCache = new Map<string, Mesh>();

export function colorOf(hex: number, alpha = 255): Color {
    return new Color((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, alpha);
}

export interface MatOptions {
    /** unlit дешевле и даёт «мультяшную» заливку; standard реагирует на свет */
    unlit?: boolean;
    emissive?: number;
    /** текстура поверх цвета; цвет тогда работает как оттенок */
    texture?: Texture2D | null;
    /** яркость из цвета вершин — разброс по блокам без лишних драуколов */
    vertexColor?: boolean;
    /** полупрозрачный unlit (пена, свечение портала); прозрачность — в alpha */
    alpha?: number;
    /** аддитивный unlit: свечение складывается со сценой (вспышки, молния) */
    additive?: boolean;
    /** без отсечения задних граней: плоскость видна с обеих сторон */
    doubleSided?: boolean;
}

export function getMaterial(hex: number, opts: MatOptions = {}): Material {
    const tex = opts.texture ?? null;
    const key =
        `${hex}|${opts.unlit ? 'u' : 's'}|${opts.emissive ?? -1}|${tex ? tex.uuid : '-'}` +
        `|${opts.vertexColor ? 'vc' : ''}|${opts.alpha ?? 255}|${opts.additive ? 'add' : ''}|${opts.doubleSided ? '2s' : ''}`;
    const cached = materialCache.get(key);
    if (cached) return cached;

    const mat = createMaterial(hex, opts);
    materialCache.set(key, mat);
    return mat;
}

/**
 * Новый материал без кеша — для того, что анимируется по своим параметрам
 * (вода сдвигает текстуру, пена мигает): из общего кеша это задело бы всех.
 */
export function createMaterial(hex: number, opts: MatOptions = {}): Material {
    const tex = opts.texture ?? null;
    const transparent = opts.alpha !== undefined && opts.alpha < 255;
    const defines: Record<string, boolean> = {};
    if (tex) defines[opts.unlit ? 'USE_TEXTURE' : 'USE_ALBEDO_MAP'] = true;
    if (opts.vertexColor) defines.USE_VERTEX_COLOR = true;

    const mat = new Material();
    mat.initialize({
        effectName: opts.unlit ? 'builtin-unlit' : 'builtin-standard',
        // техники builtin-unlit: 0 opaque, 1 transparent, 2 add
        technique: opts.unlit ? (opts.additive ? 2 : transparent ? 1 : 0) : 0,
        defines,
    });
    if (opts.doubleSided) {
        mat.overridePipelineStates({ rasterizerState: { cullMode: gfx.CullMode.NONE } });
    }
    mat.setProperty('mainColor', colorOf(hex, opts.alpha ?? 255));
    if (tex) mat.setProperty('mainTexture', tex);
    if (!opts.unlit) {
        // плейблу идёт матовая заливка без бликов
        mat.setProperty('roughness', 0.9);
        mat.setProperty('metallic', 0.0);
        if (opts.emissive !== undefined) mat.setProperty('emissive', colorOf(opts.emissive));
    }
    return mat;
}

function cachedMesh(key: string, build: () => primitives.IGeometry): Mesh {
    const cached = meshCache.get(key);
    if (cached) return cached;
    const mesh = utils.MeshUtils.createMesh(build());
    meshCache.set(key, mesh);
    return mesh;
}

export function boxMesh(w: number, h: number, d: number): Mesh {
    return cachedMesh(`box:${w},${h},${d}`, () => primitives.box({ width: w, height: h, length: d }));
}

export function cylinderMesh(radius: number, height: number, segments = 16): Mesh {
    return cachedMesh(`cyl:${radius},${height},${segments}`, () =>
        primitives.cylinder(radius, radius, height, { radialSegments: segments, heightSegments: 1 })
    );
}

export function coneMesh(radius: number, height: number, segments = 16): Mesh {
    return cachedMesh(`cone:${radius},${height},${segments}`, () =>
        primitives.cone(radius, height, { radialSegments: segments })
    );
}

export function sphereMesh(radius: number, segments = 14): Mesh {
    return cachedMesh(`sph:${radius},${segments}`, () =>
        primitives.sphere(radius, { segments })
    );
}

export function capsuleMesh(radius: number, height: number): Mesh {
    return cachedMesh(`cap:${radius},${height}`, () =>
        primitives.capsule(radius, radius, height, { sides: 14, heightSegments: 4 })
    );
}

/**
 * Один меш из множества плоских квадратов.
 *
 * Блочный ландшафт — это сотни тайлов, и каждый отдельной нодой означал бы
 * сотни драуколов. Поэтому тайлы одного типа склеиваются в общую геометрию:
 * один меш, один материал, один драукол.
 */
export function tileMesh(tiles: { x: number; z: number; y: number; size: number }[]): Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    tiles.forEach((t, i) => {
        const h = t.size / 2;
        // против часовой стрелки при взгляде сверху
        positions.push(
            t.x - h, t.y, t.z - h,
            t.x + h, t.y, t.z - h,
            t.x + h, t.y, t.z + h,
            t.x - h, t.y, t.z + h
        );
        for (let n = 0; n < 4; n++) normals.push(0, 1, 0);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        const b = i * 4;
        indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
    });

    return utils.MeshUtils.createMesh({ positions, normals, uvs, indices });
}

/** Вертикальный квадрат в плоскости XY — под спрайты-вспышки, развёрнутые к камере. */
export function quadMesh(size: number): Mesh {
    return cachedMesh(`quad:${size}`, () => {
        const h = size / 2;
        return {
            positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
            normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
            uvs: [0, 1, 1, 1, 1, 0, 0, 0],
            indices: [0, 1, 2, 0, 2, 3],
        };
    });
}

/** Затемнить цвет: боковые грани блока должны быть темнее верхней. */
export function darken(hex: number, k: number): number {
    const r = Math.round(((hex >> 16) & 0xff) * k);
    const g = Math.round(((hex >> 8) & 0xff) * k);
    const b = Math.round((hex & 0xff) * k);
    return (r << 16) | (g << 8) | b;
}

/**
 * Один меш из множества кубов — блочный ландшафт.
 *
 * Верхние и боковые грани строятся раздельно: воксельный вид держится именно
 * на том, что бока темнее верха. С одним материалом на весь куб блоки выглядят
 * плоскими наклейками, а не кубами.
 * Нижнюю грань не строим никогда: её не видно, а это четверть геометрии.
 */
export interface BlockMeshOptions {
    /**
     * Яркость блока 0..1 в цвет вершин (нужен материал с vertexColor).
     * Даёт разнобой оттенков, чтобы текстура не читалась обоями.
     */
    shade?: (b: { x: number; z: number }) => number;
    /**
     * Какую высоту боковой грани покрывает одна плитка текстуры. У травяного
     * бока сверху полоса травы: она должна лечь ровно по верхнему краю блока.
     */
    sideSpan?: number;
}

export function blockMesh(
    blocks: { x: number; z: number; size: number; top: number; bottom: number }[],
    part: 'top' | 'side' = 'top',
    opts: BlockMeshOptions = {}
): Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    let base = 0;
    let shade = 1;
    const span = opts.sideSpan ?? 1;

    const quad = (
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number,
        nx: number, ny: number, nz: number,
        uv: number[]
    ) => {
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
        for (let i = 0; i < 4; i++) {
            normals.push(nx, ny, nz);
            colors.push(shade, shade, shade, 1);
        }
        uvs.push(...uv);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        base += 4;
    };

    for (const b of blocks) {
        const h = b.size / 2;
        const x0 = b.x - h;
        const x1 = b.x + h;
        const z0 = b.z - h;
        const z1 = b.z + h;
        const t = b.top;
        const u = b.bottom;
        shade = opts.shade ? opts.shade(b) : 1;

        if (part === 'top') {
            // каждый блок — целая плитка текстуры, как в майнкрафте; поворот
            // плитки на 90° по хешу ломает повтор, швов не даёт (текстура бесшовная)
            const turn = Math.floor(Math.abs(Math.sin(b.x * 12.9898 + b.z * 78.233) * 43758.5453) % 4);
            const ring = [0, 0, 1, 0, 1, 1, 0, 1];
            const uv: number[] = [];
            for (let i = 0; i < 4; i++) {
                const k = ((i + turn) % 4) * 2;
                uv.push(ring[k], ring[k + 1]);
            }
            quad(x0, t, z1, x1, t, z1, x1, t, z0, x0, t, z0, 0, 1, 0, uv);
        } else {
            // v = 0 по верхнему краю блока, вниз растёт в долях плитки
            const vb = (t - u) / (b.size * span);
            const side = [0, vb, 1, vb, 1, 0, 0, 0];
            quad(x0, u, z1, x1, u, z1, x1, t, z1, x0, t, z1, 0, 0, 1, side); // +Z
            quad(x1, u, z0, x0, u, z0, x0, t, z0, x1, t, z0, 0, 0, -1, side); // -Z
            quad(x1, u, z1, x1, u, z0, x1, t, z0, x1, t, z1, 1, 0, 0, side); // +X
            quad(x0, u, z0, x0, u, z1, x0, t, z1, x0, t, z0, -1, 0, 0, side); // -X
        }
    }

    return utils.MeshUtils.createMesh({ positions, normals, uvs, colors, indices });
}

export interface ShapeOptions extends MatOptions {
    name?: string;
    pos?: Vec3;
    castShadow?: boolean;
    receiveShadow?: boolean;
    /** готовый материал (анимируемый, некешируемый) вместо собранного по цвету */
    material?: Material;
}

/** Собрать узел с мешем и материалом и прицепить к родителю. */
export function makeShape(
    parent: Node,
    mesh: Mesh,
    hex: number,
    opts: ShapeOptions = {}
): Node {
    const node = new Node(opts.name ?? 'shape');
    node.setParent(parent);
    if (opts.pos) node.setPosition(opts.pos);

    const mr = node.addComponent(MeshRenderer);
    mr.mesh = mesh;
    mr.material = opts.material ?? getMaterial(hex, opts);
    mr.shadowCastingMode = opts.castShadow
        ? MeshRenderer.ShadowCastingMode.ON
        : MeshRenderer.ShadowCastingMode.OFF;
    mr.receiveShadow = opts.receiveShadow
        ? MeshRenderer.ShadowReceivingMode.ON
        : MeshRenderer.ShadowReceivingMode.OFF;
    return node;
}

/** Перекрасить уже созданный узел (например, подсветить слот). */
export function tintShape(node: Node, hex: number, opts: MatOptions = {}): void {
    const mr = node.getComponent(MeshRenderer);
    if (mr) mr.material = getMaterial(hex, opts);
}
