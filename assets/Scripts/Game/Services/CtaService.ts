import { sys } from 'cc';

/**
 * Универсальный CTA-хук.
 *
 * Плейбл крутится у разных сетей, и у каждой свой способ открыть стор.
 * Сервис дёргает тот SDK, который реально присутствует на странице,
 * поэтому под конкретную сеть обычно ничего дописывать не нужно.
 * Если сеть экзотическая — добавь её в openStore() одной строкой.
 */

/** Куда вести, если никакого SDK сети на странице не оказалось (прямой тест в браузере). */
export const STORE_URL = {
    ios: 'https://apps.apple.com/app/id0000000000',
    android: 'https://play.google.com/store/apps/details?id=com.example.game',
};

type AnyWindow = Record<string, any>;

function w(): AnyWindow {
    return (typeof window !== 'undefined' ? window : {}) as AnyWindow;
}

export class CtaService {
    /** Сети не любят несколько переходов подряд — пускаем только первый. */
    private static fired = false;
    private static readyFired = false;

    /** Сообщить сети, что плейбл загрузился. Вызывается один раз на старте. */
    static notifyReady(): void {
        if (CtaService.readyFired) return;
        CtaService.readyFired = true;
        const g = w();
        try {
            if (g.mraid && typeof g.mraid.getState === 'function') {
                if (g.mraid.getState() === 'loading') {
                    g.mraid.addEventListener('ready', () => void 0);
                }
            }
            // Unity Ads / ironSource
            if (g.dapi && typeof g.dapi.isReady === 'function') g.dapi.isReady();
            // Google Ads playable
            if (g.ExitApi && typeof g.ExitApi.init === 'function') g.ExitApi.init();
        } catch (e) {
            console.warn('[CTA] notifyReady:', e);
        }
    }

    /** Главное действие плейбла: увести в стор. */
    static openStore(): void {
        if (CtaService.fired) return;
        CtaService.fired = true;
        const g = w();
        const url = sys.os === sys.OS.IOS ? STORE_URL.ios : STORE_URL.android;

        try {
            // Mintegral / ironSource / AppLovin и все, кто поднимает MRAID
            if (g.mraid && typeof g.mraid.open === 'function') {
                g.mraid.open(url);
                return;
            }
            // Unity Ads
            if (g.dapi && typeof g.dapi.openStoreUrl === 'function') {
                g.dapi.openStoreUrl();
                return;
            }
            // Google Ads
            if (g.ExitApi && typeof g.ExitApi.exit === 'function') {
                g.ExitApi.exit();
                return;
            }
            // Facebook / Meta
            if (g.FbPlayableAd && typeof g.FbPlayableAd.onCTAClick === 'function') {
                g.FbPlayableAd.onCTAClick();
                return;
            }
            // Mintegral (старый вариант) и часть китайских сетей
            if (typeof g.install === 'function') {
                g.install();
                return;
            }
            if (typeof g.gameEnd === 'function') {
                g.gameEnd();
                return;
            }
            if (typeof g.openStore === 'function') {
                g.openStore();
                return;
            }
            // Прямой запуск в браузере — просто открываем ссылку
            if (typeof g.open === 'function') g.open(url, '_blank');
        } catch (e) {
            console.warn('[CTA] openStore:', e);
        }
    }

    /** Для отладки: можно нажать CTA повторно. */
    static reset(): void {
        CtaService.fired = false;
    }
}
