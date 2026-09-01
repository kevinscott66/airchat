/**
 * Дополняет `app.json`: Apple Team ID для автоматической подписи iOS.
 * Задаётся одним из способов (первый найденный выигрывает):
 *   - переменная окружения `APPLE_TEAM_ID` или `EXPO_APPLE_TEAM_ID`
 *   - файл `ios-signing.local` в корне репозитория (строка `APPLE_TEAM_ID=XXXXXXXXXX`)
 * После смены Team ID выполните: `npx expo prebuild --platform ios`
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
      ios: {
        ...appJson.expo.ios,
        ...(teamId ? { appleTeamId: teamId } : {}),
      },
    },
  };
};
