/** Диагностика арены: сколько дороги простреливает каждый слот. */
import { PATH, SLOT_ANCHORS, SLOT_POSITIONS, UNITS } from '../assets/Scripts/Sim/Balance';
import { coveredLength } from '../assets/Scripts/Sim/BattleSim';

console.log('длина дороги:', PATH.total.toFixed(1));
console.log('slot  along side      x      z    archer  bomber    mage');
SLOT_POSITIONS.forEach((p, i) => {
    const a = SLOT_ANCHORS[i];
    const c = (r: number) => coveredLength(PATH, p.x, p.z, r).toFixed(1).padStart(7);
    console.log(
        String(i).padStart(4) +
            String(a.along).padStart(7) +
            String(a.side).padStart(5) +
            p.x.toFixed(1).padStart(7) +
            p.z.toFixed(1).padStart(7) +
            c(UNITS.archer.range) +
            c(UNITS.bomber.range) +
            c(UNITS.mage.range)
    );
});
