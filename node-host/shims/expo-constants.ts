/**
 * Node-замена `expo-constants`.
 *
 * Единственный потребитель в ядре — `syncApi`: он собирает из этих полей
 * описание устройства, которое видно в списке «мои устройства». Подставлять
 * туда чужие «iPhone» нельзя — человек не должен искать среди телефонов
 * строку, которая на самом деле обозначает процесс на машине. Поэтому здесь
 * настоящие сведения о хосте, и они прямо называют себя узлом Node.
 */
import * as os from 'node:os';

const appVersion = process.env.AIRCHAT_APP_VERSION ?? '0.0.0-node-host';

export const Constants = {
  Manufacturer: os.type(),
  Model: `node-host ${os.hostname()}`,
  Release: os.release(),
  osVersion: `${os.type()} ${os.release()}`,
  nativeAppVersion: appVersion,
  nativeBuildVersion: appVersion,
  platform: { ios: undefined, android: undefined, web: undefined },
  deviceName: os.hostname(),
  expoConfig: {
    name: 'AirChat node-host',
    slug: 'airchat',
    version: appVersion,
    extra: {},
  },
};

export default Constants;
