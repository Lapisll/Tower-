import { AudioClip, AudioSource, Node, director, resources } from 'cc';

/**
 * Звук плейбла.
 *
 * Файлов пока нет — сервис молча пропускает всё, что не загрузилось, поэтому
 * игра работает и без них. Когда клипы появятся, достаточно положить их в
 * assets/resources/Audio/ с именами из SOUNDS — код трогать не нужно.
 *
 * Важно для рекламных сетей: звук нельзя заводить до первого касания экрана,
 * иначе браузер его заблокирует. Поэтому музыка стартует по unlock().
 */
export const SOUNDS = {
    music: 'Audio/music',
    place: 'Audio/place',
    buy: 'Audio/buy',
    arrow: 'Audio/arrow',
    rock: 'Audio/rock',
    bolt: 'Audio/bolt',
    hit: 'Audio/hit',
    enemyDie: 'Audio/enemy_die',
    leak: 'Audio/leak',
    waveStart: 'Audio/wave_start',
    waveClear: 'Audio/wave_clear',
    win: 'Audio/win',
    lose: 'Audio/lose',
    button: 'Audio/button',
};

export type SoundName = keyof typeof SOUNDS;

const VOLUME: Partial<Record<SoundName, number>> = {
    music: 0.35,
    arrow: 0.35,
    rock: 0.45,
    bolt: 0.5,
    hit: 0.3,
    enemyDie: 0.4,
};

/** Чтобы залп из пяти лучников не слился в кашу и не клиппировал. */
const MIN_GAP: Partial<Record<SoundName, number>> = {
    arrow: 0.06,
    rock: 0.08,
    bolt: 0.08,
    hit: 0.05,
    enemyDie: 0.05,
};

class AudioServiceImpl {
    private node: Node | null = null;
    private source: AudioSource | null = null;
    private readonly clips = new Map<SoundName, AudioClip>();
    private readonly lastPlayed = new Map<SoundName, number>();
    private unlocked = false;
    private musicWanted = false;
    private time = 0;

    /** Грузим всё разом на старте; отсутствующие файлы просто пропускаем. */
    init(): void {
        if (this.node) return;
        this.node = new Node('Audio');
        this.node.setParent(director.getScene()!);
        this.source = this.node.addComponent(AudioSource);
        this.source.playOnAwake = false;

        (Object.keys(SOUNDS) as SoundName[]).forEach((name) => {
            resources.load(SOUNDS[name], AudioClip, (err, clip) => {
                if (!err && clip) this.clips.set(name, clip);
            });
        });
    }

    tick(dt: number): void {
        this.time += dt;
    }

    /** Вызывается на первом касании: до него браузер звук не пустит. */
    unlock(): void {
        if (this.unlocked) return;
        this.unlocked = true;
        if (this.musicWanted) this.playMusic();
    }

    play(name: SoundName): void {
        if (!this.unlocked || !this.source) return;
        const gap = MIN_GAP[name];
        if (gap !== undefined) {
            const last = this.lastPlayed.get(name) ?? -999;
            if (this.time - last < gap) return;
            this.lastPlayed.set(name, this.time);
        }
        const clip = this.clips.get(name);
        if (!clip) return;
        this.source.playOneShot(clip, VOLUME[name] ?? 1);
    }

    playMusic(): void {
        this.musicWanted = true;
        if (!this.unlocked || !this.source) return;
        const clip = this.clips.get('music');
        if (!clip) return;
        this.source.clip = clip;
        this.source.loop = true;
        this.source.volume = VOLUME.music ?? 0.35;
        this.source.play();
    }

    stopMusic(): void {
        this.musicWanted = false;
        this.source?.stop();
    }

    /** Приглушить музыку под финальный экран, чтобы CTA читался. */
    duckMusic(volume = 0.15): void {
        if (this.source) this.source.volume = volume;
    }
}

export const Audio = new AudioServiceImpl();
