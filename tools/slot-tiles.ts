/**
 * Проверка площадок против воксельной сетки: не стоит ли постамент на дороге.
 *   npm run slot-tiles
 * Тайл считается дорогой так же, как в ArenaView: центр тайла ближе roadWidth/2 к пути.
 */
import { ARENA, PATH, SLOT_ANCHORS, SLOT_OFFSET, SLOT_POSITIONS } from '../assets/Scripts/Sim/Balance';

const cols = Math.round(ARENA.width);
const rows = Math.round(ARENA.depth);
const centerZ = (ARENA.spawnPos.z + ARENA.basePos.z) / 2;
const samples: { x: number; z: number }[] = [];
for (let d = 0; d <= PATH.total; d += 0.25) samples.push(PATH.posAt(d));
const distToPath = (x: number, z: number) => Math.min(...samples.map((p) => Math.hypot(p.x - x, p.z - z)));
const tileOf = (x: number, z: number) => ({
    c: Math.round(x + (cols - 1) / 2),
    r: Math.round(z - centerZ + (rows - 1) / 2),
});
const tileCenter = (c: number, r: number) => ({ x: c - (cols - 1) / 2, z: centerZ + r - (rows - 1) / 2 });

console.log('slot  along side      x      z   до пути  тайл     дорога?');
SLOT_POSITIONS.forEach((p, i) => {
    const a = SLOT_ANCHORS[i];
    const t = tileOf(p.x, p.z);
    const tc = tileCenter(t.c, t.r);
    const road = distToPath(tc.x, tc.z) <= ARENA.roadWidth / 2;
    // постамент радиусом ~0.47 может задеть соседний тайл, если центр между тайлами
    const offGrid = Math.abs(p.x - tc.x) > 0.01 || Math.abs(p.z - tc.z) > 0.01;
    console.log(
        `${String(i).padStart(4)} ${a.along.toFixed(1).padStart(6)} ${String(a.side).padStart(4)} ` +
            `${p.x.toFixed(2).padStart(6)} ${p.z.toFixed(2).padStart(6)} ${distToPath(p.x, p.z).toFixed(2).padStart(8)}  ` +
            `${t.c},${t.r}`.padEnd(8) +
            (road ? ' ДОРОГА' : ' трава') +
            (offGrid ? '  (между тайлами)' : '')
    );
});
console.log(`SLOT_OFFSET ${SLOT_OFFSET}, ширина дороги ${ARENA.roadWidth}`);
