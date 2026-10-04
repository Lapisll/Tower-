import type { UnitKind } from '../Sim/SimTypes';
import { BASE, ECONOMY, SLOT_POSITIONS, UNITS, UNIT_ORDER, WAVES, slotsOpenAtWave } from '../Sim/Balance';
import { BattleSim, type PlacedUnit } from '../Sim/BattleSim';
import { cheapestUnitCost } from '../Sim/Loadout';
import type { ArenaView } from './View/ArenaView';
import type { BattleView } from './View/BattleView';
import type { GameUI, TutorialTarget } from './UI/GameUI';
import { CtaService } from './Services/CtaService';
import { Audio } from './Services/Audio';
import { STRINGS } from './Strings';

export type Phase = 'shop' | 'battle' | 'over';

/**
 * Склейка: магазин -> волна -> магазин -> ... -> босс -> CTA.
 *
 * Контроллер владеет деньгами и составом армии, но сам бой целиком отдаёт
 * в BattleSim, а картинку — в BattleView. Логика победы/поражения тут только
 * одна: волна проиграна, если база обнулилась.
 */
export class GameController {
    phase: Phase = 'shop';
    coins = ECONOMY.startCoins;
    baseHp = BASE.hp;
    waveIndex = 0;

    private readonly placed: PlacedUnit[] = [];
    private selected: UnitKind | null = null;
    private sim: BattleSim | null = null;
    /** пауза перед показом итога, чтобы игрок увидел последний взрыв */
    private resultDelay = 0;
    private pendingResult: 'won' | 'lost' | null = null;

    constructor(
        private readonly arena: ArenaView,
        private readonly view: BattleView,
        private readonly ui: GameUI
    ) {}

    start(): void {
        this.phase = 'shop';
        this.arena.setUnlockedCount(slotsOpenAtWave(0));
        this.ui.showShop(true);
        this.ui.setWave(this.waveIndex, STRINGS.phasePrepare);
        this.ui.setBaseHp(this.baseHp, BASE.hp);
        this.refreshShop();
        this.ui.showBanner(STRINGS.waveBanner(1), STRINGS.waveSubFirst, 1.4);
    }

    // -- магазин -------------------------------------------------------------

    pickUnit(kind: UnitKind): void {
        if (this.phase !== 'shop') return;
        if (this.coins < UNITS[kind].cost) return;
        this.selected = this.selected === kind ? null : kind;
        Audio.play('buy');
        this.arena.highlightFree(this.selected !== null);
        this.refreshShop();
    }

    /** Тап по земле: ставим выбранного юнита на ближайшую свободную площадку. */
    tapWorld(x: number, z: number): void {
        if (this.phase !== 'shop' || !this.selected) return;
        const slot = this.arena.pickSlot(x, z);
        if (slot < 0) return;

        const kind = this.selected;
        const cost = UNITS[kind].cost;
        if (this.coins < cost) return;

        this.coins -= cost;
        this.placed.push({ slot, kind });
        this.arena.setSlotTaken(slot, true);
        const p = SLOT_POSITIONS[slot];
        this.view.spawnUnit(slot, kind, p.x, p.z);
        Audio.play('place');

        // если на оставшиеся монеты этот класс уже не купить — снимаем выделение
        if (this.coins < cost) {
            this.selected = null;
            this.arena.highlightFree(false);
        }
        this.refreshShop();
    }

    startWave(): void {
        if (this.phase !== 'shop' || !this.canStart()) return;

        this.selected = null;
        this.arena.highlightFree(false);
        this.ui.setTutorial(null);
        this.ui.showShop(false);
        this.ui.setWave(this.waveIndex, STRINGS.phaseBattle);

        Audio.play('waveStart');
        this.sim = new BattleSim({
            wave: WAVES[this.waveIndex],
            units: this.placed,
            baseHp: this.baseHp,
        });
        this.phase = 'battle';

        const subs = [STRINGS.waveSubFirst, STRINGS.waveSubSecond, STRINGS.waveSubBoss];
        this.ui.showBanner(
            STRINGS.waveBanner(this.waveIndex + 1),
            subs[Math.min(this.waveIndex, subs.length - 1)],
            1.3
        );
    }

    private get openSlots(): number {
        return slotsOpenAtWave(this.waveIndex);
    }

    private canStart(): boolean {
        if (this.placed.length === 0) return false;
        if (!ECONOMY.requireFullSpend) return true;
        // правило «потрать всё» работает только на первой волне: дальше монеты
        // могут остаться просто потому, что кончились свободные площадки
        if (this.waveIndex > 0) return true;
        if (this.placed.length >= this.openSlots) return true;
        return this.coins < cheapestUnitCost;
    }

    private counts(): Record<UnitKind, number> {
        const c: Record<UnitKind, number> = { archer: 0, bomber: 0, mage: 0 };
        for (const p of this.placed) c[p.kind]++;
        return c;
    }

    private refreshShop(): void {
        const counts = this.counts();
        let kinds = 0;
        for (const k of UNIT_ORDER) if (counts[k] > 0) kinds++;

        const slotsLeft = this.openSlots - this.placed.length;
        let hint: string;
        if (this.selected) hint = STRINGS.hintPlace;
        else if (slotsLeft === 0) hint = STRINGS.hintNoSlots;
        else if (this.coins < cheapestUnitCost) hint = STRINGS.hintNoMoney;
        else if (this.placed.length > 0 && ECONOMY.requireFullSpend && this.waveIndex === 0)
            hint = STRINGS.hintSpendAll;
        else hint = STRINGS.hintPickUnit;

        this.ui.setCoins(this.coins);
        this.ui.setTutorial(this.tutorialTarget());
        this.ui.updateShop({
            coins: this.coins,
            selected: this.selected,
            counts,
            canStart: this.canStart(),
            hint,
            startText: this.placed.length === 0 ? STRINGS.startNeedUnits : STRINGS.startBattle,
            synergyKinds: kinds,
        });
    }

    /**
     * Куда показывает обучающая рука. Ведём игрока только на первой волне:
     * дальше он уже понял правила, и указатель будет только мешать.
     */
    private tutorialTarget(): TutorialTarget {
        if (this.phase !== 'shop' || this.waveIndex > 0) return null;
        if (this.selected) {
            const slot = this.firstFreeSlot();
            if (slot >= 0) {
                const p = SLOT_POSITIONS[slot];
                return { at: 'world', x: p.x, z: p.z };
            }
            return null;
        }
        if (this.canStart()) return { at: 'start' };
        for (const k of UNIT_ORDER) {
            if (this.coins >= UNITS[k].cost) return { at: 'card', kind: k };
        }
        return null;
    }

    private firstFreeSlot(): number {
        for (let i = 0; i < this.openSlots; i++) {
            if (!this.placed.some((p) => p.slot === i)) return i;
        }
        return -1;
    }

    // -- бой -----------------------------------------------------------------

    update(dt: number): void {
        if (this.phase === 'battle' && this.sim) {
            this.sim.update(dt);
            this.view.sync(this.sim, dt);
            this.ui.setBaseHp(this.sim.baseHp, BASE.hp);

            if (this.sim.outcome !== 'running' && this.pendingResult === null) {
                this.pendingResult = this.sim.outcome;
                this.resultDelay = 0.9;
            }
        }

        if (this.pendingResult) {
            this.resultDelay -= dt;
            if (this.resultDelay <= 0) {
                const outcome = this.pendingResult;
                this.pendingResult = null;
                this.finishWave(outcome);
            }
        }
    }

    private finishWave(outcome: 'won' | 'lost'): void {
        const sim = this.sim;
        this.sim = null;
        if (!sim) return;

        this.baseHp = sim.baseHp;
        this.ui.setBaseHp(this.baseHp, BASE.hp);

        if (outcome === 'lost') {
            this.phase = 'over';
            this.ui.setWave(this.waveIndex, STRINGS.phaseDone);
            Audio.play('lose');
            Audio.duckMusic();
            this.ui.showResult(false, STRINGS.loseTitle, STRINGS.loseSub);
            return;
        }

        this.coins += sim.coinsEarned;
        this.view.reset();

        const isLast = this.waveIndex >= WAVES.length - 1;
        if (isLast) {
            this.phase = 'over';
            this.ui.setWave(this.waveIndex, STRINGS.phaseDone);
            Audio.play('win');
            Audio.duckMusic();
            this.ui.showResult(true, STRINGS.winTitle, STRINGS.winSub);
            return;
        }

        this.waveIndex++;
        this.phase = 'shop';
        const opened = this.arena.setUnlockedCount(slotsOpenAtWave(this.waveIndex));
        this.ui.showShop(true);
        this.ui.setWave(this.waveIndex, STRINGS.phasePrepare);
        Audio.play('waveClear');
        this.ui.showBanner(
            STRINGS.waveCleared,
            STRINGS.rewardSub(sim.coinsEarned, opened.length),
            1.8
        );
        this.refreshShop();
    }

    // -- CTA -----------------------------------------------------------------

    fireCta(): void {
        Audio.play('button');
        CtaService.openStore();
    }
}
