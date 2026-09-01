import { Alert } from 'react-native';
import { ErrorHandler, ErrorSeverity, type AppError } from '../errorHandler';

/**
 * v4.32.336: ErrorHandler показывает ошибку модальным окном, а окна система
 * ставит в очередь. Пока ничто не мешало, рассылка на двадцать контактов, из
 * которых половина недоступна, выдавала десять одинаковых окон подряд.
 */

type AlertButton = { text?: string; onPress?: () => void };
type AlertOptions = { onDismiss?: () => void };

function err(over: Partial<AppError> = {}): AppError {
  return {
    code: 'NO_SESSION_DM',
    message: 'Нет защищённого канала с этим контактом.',
    severity: ErrorSeverity.ERROR,
    retryable: false,
    ...over,
  };
}

/** Свежий синглтон на каждый тест: копится состояние показанных окон. */
function freshHandler(): ErrorHandler {
  (ErrorHandler as unknown as { instance?: ErrorHandler }).instance = undefined;
  return ErrorHandler.getInstance();
}

describe('ErrorHandler.handle — окна не множатся', () => {
  let alertSpy: jest.SpyInstance;
  let nowSpy: jest.SpyInstance;
  let now = 1_000_000;

  /** Штатное поведение человека: увидел окно и нажал OK. */
  function autoDismiss(): void {
    alertSpy.mockImplementation(
      (_title: string, _msg: string, buttons?: AlertButton[], _opts?: AlertOptions) => {
        buttons?.[0]?.onPress?.();
      }
    );
  }

  beforeEach(() => {
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nowSpy.mockRestore();
  });

  it('двадцать одинаковых отказов подряд — одно окно', async () => {
    autoDismiss();
    const h = freshHandler();
    for (let i = 0; i < 20; i++) {
      await h.handle(err());
    }
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('повтор при незакрытом окне не ждёт закрытия первого', async () => {
    const h = freshHandler();
    // Окно висит: onPress никто не нажимал, первый handle не завершится.
    const pending = h.handle(err());
    await h.handle(err());
    await h.handle(err());
    expect(alertSpy).toHaveBeenCalledTimes(1);
    // Закрываем первое окно, чтобы не оставлять висящий промис.
    const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
    buttons[0].onPress?.();
    await pending;
  });

  it('другая ошибка показывается, а не прячется за первой', async () => {
    autoDismiss();
    const h = freshHandler();
    await h.handle(err());
    await h.handle(err({ code: 'BLOCKED_CONTACT', message: 'Контакт заблокирован.' }));
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1][1]).toBe('Контакт заблокирован.');
  });

  it('та же ошибка спустя окно тишины показывается снова', async () => {
    autoDismiss();
    const h = freshHandler();
    await h.handle(err());
    now += 5_001;
    await h.handle(err());
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('закрытие крестиком тоже открывает дорогу следующему окну', async () => {
    const h = freshHandler();
    const pending = h.handle(err());
    const opts = alertSpy.mock.calls[0][3] as AlertOptions;
    opts.onDismiss?.();
    await pending;
    now += 5_001;
    autoDismiss();
    await h.handle(err());
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('info и warning окон не открывают вовсе', async () => {
    autoDismiss();
    const h = freshHandler();
    await h.handle(err({ code: 'A', severity: ErrorSeverity.INFO }));
    await h.handle(err({ code: 'B', severity: ErrorSeverity.WARNING }));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('fatal показывается наравне с error', async () => {
    autoDismiss();
    const h = freshHandler();
    await h.handle(err({ code: 'CRASH', severity: ErrorSeverity.FATAL, message: 'Сбой.' }));
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('пустое сообщение не оставляет окно без текста', async () => {
    autoDismiss();
    const h = freshHandler();
    await h.handle(err({ message: '' }));
    expect(alertSpy.mock.calls[0][1]).toBe('Something went wrong.');
  });
});
