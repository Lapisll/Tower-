/**
 * Все тексты в одном месте: сети часто просят версию на другом языке,
 * и тогда меняется только этот файл.
 */
export const STRINGS = {
    gameTitle: 'EVIL TOWER',

    hintPickUnit: 'PICK A HERO',
    hintPlace: 'TAP A GLOWING PAD',
    hintSpendAll: 'SPEND ALL YOUR GOLD',
    hintNoSlots: 'ALL PADS TAKEN — FIGHT!',
    hintNoMoney: 'OUT OF GOLD — FIGHT!',

    startBattle: 'FIGHT!',
    startNeedUnits: 'BUY A HERO',

    gold: 'GOLD',
    baseLabel: 'BASE',
    phasePrepare: 'PREPARE',
    phaseBattle: 'BATTLE',
    phaseDone: 'RESULT',

    waveBanner: (n: number) => `WAVE ${n}`,
    waveSubFirst: 'A goblin horde is coming',
    waveSubSecond: 'Three armored brutes among them',
    waveSubBoss: 'THE WARLORD. Hold the line!',

    waveCleared: 'WAVE CLEARED',
    rewardSub: (coins: number, pads: number) =>
        pads > 0 ? `+${coins} gold · ${pads} new pad${pads > 1 ? 's' : ''} unlocked` : `+${coins} gold`,

    synergyOn: (bonus: number) => `CLASS SYNERGY: +${bonus}% DAMAGE`,
    synergyOff: 'ONE CLASS — NO DAMAGE BONUS',

    loseTitle: 'BASE DESTROYED',
    loseSub: 'One class was not enough. Mix your heroes — the full game has dozens of combos.',
    winTitle: 'WARLORD SLAIN!',
    winSub: 'You held the line. New lands, heroes and bosses await.',
    cta: 'PLAY NOW',

    statSingle: 'single target',
    statSplash: 'area damage',
    statSplashSlow: 'area damage + slow',
};
