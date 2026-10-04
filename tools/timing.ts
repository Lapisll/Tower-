/** Сколько секунд занимает каждая волна при типичной игре. */
import { BattleSim } from '../assets/Scripts/Sim/BattleSim';
import { ECONOMY, UNITS, WAVES, slotsOpenAtWave } from '../assets/Scripts/Sim/Balance';
import { loadoutCost, loadoutLabel, spreadToSlots, type Loadout } from '../assets/Scripts/Sim/Loadout';

const start: Loadout = { archer: 2, bomber: 1, mage: 0 };
let coins = ECONOMY.startCoins - loadoutCost(start);
let army: Loadout = { ...start };
let baseHp = 100;
let total = 0;

for (let i = 0; i < WAVES.length; i++) {
    const slots = slotsOpenAtWave(i);
    const sim = new BattleSim({ wave: WAVES[i], units: spreadToSlots(army, slots), baseHp });
    const r = sim.runToEnd();
    total += r.seconds;
    console.log(
        `Волна ${i + 1}: ${r.seconds.toFixed(1)}с  ${r.outcome}  убито ${r.killed}  прорыв ${r.leaked}  ` +
            `HP базы ${r.baseHp}  +${r.coins} монет  [${loadoutLabel(army)}]`
    );
    if (r.outcome !== 'won') break;
    baseHp = r.baseHp;
    coins += r.coins;
    // докупаем как средний игрок: сначала мага, потом лучников
    const next = slotsOpenAtWave(i + 1);
    const size = () => army.archer + army.bomber + army.mage;
    if (coins >= UNITS.mage.cost && size() < next) {
        army.mage++;
        coins -= UNITS.mage.cost;
    }
    while (coins >= UNITS.archer.cost && size() < next) {
        army.archer++;
        coins -= UNITS.archer.cost;
    }
}
console.log(`\nИтого бой: ${total.toFixed(1)}с (+ магазины между волнами)`);
