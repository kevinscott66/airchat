# Системные уведомления: что нужно завести руками

Код готов целиком — и клиент, и ретранслятор (`signaling-server/push.js`).
Не готовы учётные данные: их нельзя ни сгенерировать из репозитория, ни
держать в нём. Ниже — ровно то, что делается в консолях и один раз.

Пока этого нет, приложение собирается и работает, ретранслятор отвечает `204`,
а уведомление просто не приходит. Ничего не падает.

## 1. Проект Firebase

Консоль Firebase → создать проект (или взять существующий) → **Cloud
Messaging**.

## 2. Android: `google-services.json`

Firebase → Project settings → Your apps → Add app → Android.

- Package name: `com.anonymous.airchat` (значение `android.package` в `app.json`)

Скачанный файл кладётся в корень репозитория **вместо** заглушки
`google-services.json`. Заглушку видно по `REPLACE_WITH_KEY_FROM_FIREBASE_CONSOLE`.

## 3. iOS: `GoogleService-Info.plist`

Firebase → Add app → iOS.

- Bundle ID: `com.anonymous.airchat` (значение `ios.bundleIdentifier` в `app.json`)

Файл кладётся в корень репозитория вместо заглушки
`GoogleService-Info.plist`. `app.json` уже указывает на него через
`ios.googleServicesFile`.

## 4. iOS: ключ APNs (.p8)

Apple Developer → Certificates, Identifiers & Profiles → Keys → **+** →
включить **Apple Push Notifications service (APNs)**. Ключ скачивается **один
раз**, второй раз его не отдадут.

Дальше Firebase → Project settings → Cloud Messaging → Apple app configuration
→ **APNs Authentication Key**: загрузить `.p8`, указать Key ID и Team ID.

Сам `.p8` остаётся в консоли Firebase. **В репозиторий он не попадает
никогда** — это ключ, которым можно слать пуши во все приложения команды.

Там же проверить, что у App ID включена возможность Push Notifications, а
профиль сборки её содержит. Для `eas build --profile production` EAS сделает
это сам при первом запуске.

## 5. Секрет ретранслятора

Firebase → Project settings → **Service accounts** → Generate new private key.
Скачанный JSON — это доступ на отправку от имени проекта.

```sh
fly secrets set FCM_SERVICE_ACCOUNT_JSON="$(base64 -i service-account.json)"
```

Затем скачанный файл удалить. В репозиторий он не кладётся; переменная читается
только из окружения.

## 6. Проверка

```sh
cd signaling-server && npm test
```

Тесты проходят и без учётных данных — они подставляют свои. Живая проверка —
собрать `eas build --profile preview` (APK) или `--profile production` (iOS),
поставить на два устройства, **закрыть** приложение на одном и написать ему со
второго.

В логе ретранслятора видно `push_sent` / `push_stale`; в логе приложения —
`push_register_ok`. Если в логе `push_register_unsupported`, устройство не
Android и не iOS (веб-версия push не шлёт — там его нечем принять с закрытой
вкладкой).

## Почему это вообще нужно

С 4.32.537 сеть — основной путь доставки, а не запасной. Оффлайн-транспорты
(Wi-Fi Direct, mDNS в общей сети, дальняя радиосвязь) остаются как резерв и
никуда не убраны, но рассчитывать на то, что собеседник рядом, больше нельзя.
А значит, сообщение приходит тогда, когда приложение закрыто, — и без пуша его
никто не увидит до следующего запуска.
