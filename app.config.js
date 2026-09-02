/**
 * Дополняет `app.json`: Apple Team ID для автоматической подписи iOS.
 * Задаётся одним из способов (первый найденный выигрывает):
 *   - переменная окружения `APPLE_TEAM_ID` или `EXPO_APPLE_TEAM_ID`
 *   - файл `ios-signing.local` в корне репозитория (строка `APPLE_TEAM_ID=XXXXXXXXXX`)
 * После смены Team ID выполните: `npx expo prebuild --platform ios`
 *
 * Здесь же подставляются конфиги Firebase. В репозитории на их путях лежат
 * заглушки — настоящие файлы в git не попадают. На EAS они заведены как
 * переменные типа `file`, и сборка получает путь к распакованному файлу в
 * `GOOGLE_SERVICES_JSON` / `GOOGLE_SERVICES_PLIST`. Без этой подстановки
 * сборщик забрал бы из архива git именно заглушку, и push молча не работал
 * бы в собранном приложении.
 */
const fs = require('fs');
const path = require('path');

const appJson = require('./app.json');

function readTeamFromLocalFile() {
  const p = path.join(__dirname, 'ios-signing.local');
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*#\s*$/) ? null : line.match(/^\s*APPLE_TEAM_ID\s*=\s*([A-Za-z0-9]{10})\s*(?:#.*)?$/);
      if (m) return m[1].toUpperCase();
    }
  } catch {
    /* нет файла */
  }
  return null;
}

module.exports = () => {
  const teamId =
    process.env.APPLE_TEAM_ID ||
    process.env.EXPO_APPLE_TEAM_ID ||
    readTeamFromLocalFile();

  return {
    expo: {
      ...appJson.expo,
      android: {
        ...appJson.expo.android,
        ...(process.env.GOOGLE_SERVICES_JSON
          ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
          : {}),
      },
      ios: {
        ...appJson.expo.ios,
        ...(teamId ? { appleTeamId: teamId } : {}),
        ...(process.env.GOOGLE_SERVICES_PLIST
          ? { googleServicesFile: process.env.GOOGLE_SERVICES_PLIST }
          : {}),
      },
    },
  };
};
