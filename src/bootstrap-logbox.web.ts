/**
 * Веб-вариант bootstrap-logbox: настраивать нечего.
 *
 * LogBox — часть нативного рантайма React Native, а не react-native-web:
 * `react-native/Libraries/LogBox/*` тянет за собой NativeModules, и в браузере
 * первый же вызов падает с `__fbBatchedBridgeConfig is not set`. Ошибки на web
 * показывает сам браузер (консоль и overlay dev-сервера), гасить их нечем и не
 * нужно.
 *
 * Файл существует ради платформенного расширения `.web.ts`: entry импортирует
 * `./src/bootstrap-logbox` первым, и на web Metro подставляет сюда. Побочный
 * эффект из `bootstrap-fusebox-global` сохранён — он про глобальный флаг
 * консоли и от нативного моста не зависит.
 */
import './bootstrap-fusebox-global';

export {};
