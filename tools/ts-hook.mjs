// Node сам стрипает типы из .ts (v22.18+), но не умеет доставлять расширение
// в импортах вида `./Balance`. Cocos требует импорты без расширений, поэтому
// дорисовываем `.ts` на резолве — так балансный прогон гоняет ровно те же файлы,
// что и игра, без сборщика и без единой зависимости.
import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
            try {
                return next(specifier + '.ts', context);
            } catch {
                // не .ts — падаем в обычный резолв ниже
            }
        }
        return next(specifier, context);
    },
});
