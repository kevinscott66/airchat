import React, { type ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppPressable } from './components/AppPressable';
import { isUserFacingMessage } from './components/userErrorText';
import { ErrorHandler, ErrorSeverity, type AppError } from '../core/errorHandler';
import { log } from '../core/logger';
import { contrastingInk, darkColors, radius } from './theme';

type Props = { children: ReactNode };

type State = { hasError: boolean; message: string };

/**
 * v4.32.833: этот экран — последнее, что человек видит от приложения.
 *
 * Показывался здесь `error.message`, и запасной текст стоял в ветке `||`, то
 * есть срабатывал только на пустом сообщении — а его почти не бывает. Значит
 * на весь экран выводилось `undefined is not an object (evaluating
 * 'e.cid')` или `Maximum update depth exceeded`, вместо единственного, что
 * человеку тут можно сделать. Тот же дефект, что разобрали в v4.32.428 на 54
 * местах сразу; храповик `errorTextCallSites` ловит рукописную развёртку
 * `e instanceof Error ? e.message`, а здесь сообщение приходит из
 * `getDerivedStateFromError` уже строкой и мимо неё проскочило.
 *
 * Правило берём оттуда же и целиком: наш текст для человека написан
 * кириллицей, чужой — нет. Техническая подробность при этом не теряется — её
 * пишет `componentDidCatch` и в журнал, и в ErrorHandler.
 */
const ADVICE = 'Перезапустите приложение. Если проблема повторится, обновите AirChat.';

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // v4.32.150 U4: логируем React-ошибку явно через log.error — до ErrorHandler,
    // чтобы stack + componentStack попали в logStore даже если handle() упадёт.
    log.error('react_error_boundary', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
    const err: AppError = {
      code: 'REACT_ERROR',
      message: error.message,
      severity: ErrorSeverity.FATAL,
      context: {
        componentStack: errorInfo.componentStack,
        stack: error.stack,
      },
      retryable: false,
    };
    void ErrorHandler.getInstance().handle(err);
  }

  private clear = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.title}>Произошла ошибка</Text>
          <Text style={styles.body}>
            {isUserFacingMessage(this.state.message) ? this.state.message : ADVICE}
          </Text>
          <AppPressable
            style={styles.btn}
            onPress={this.clear}
            accessibilityRole="button"
            accessibilityLabel="Повторить попытку"
          >
            <Text style={styles.btnText}>Повторить</Text>
          </AppPressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// Цвета намеренно фиксированные, тёмные (v4.32.345). Границу ошибок ставит
// index.ts ВОКРУГ App, то есть снаружи ThemeProvider, — темы здесь физически
// нет. И взять её неоткуда по существу: экран показывается тогда, когда дерево
// уже сломалось, а тема читается асинхронно из хранилища и к этому моменту
// может быть не прочитана вовсе.
//
// v4.32.396: фиксированные — не значит вписанные руками. Четыре литерала были
// посимвольными копиями токенов тёмной палитры, то есть при её правке разошлись
// бы с ней молча и мимо контрастного теста. Палитра — обычный модуль без
// контекста и хуков, импортировать её здесь можно.
const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: darkColors.background,
  },
  title: { color: darkColors.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  body: { color: darkColors.textSecondary, textAlign: 'center', marginBottom: 20 },
  btn: {
    backgroundColor: darkColors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  btnText: { color: contrastingInk(darkColors.primary), fontWeight: '600' },
});
