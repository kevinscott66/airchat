module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // v4.32.614: под jest `import()` оставался нетронутым и падал с
    // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG. Ветка с отложенным импортом
    // — а их в приложении немало, ими разорваны кольца между модулями — целиком
    // уходила в catch, и любая проверка такого пути молча проверяла обработку
    // ошибки вместо самого пути. Плагин приезжает вместе с @babel/preset-env,
    // который и так стоит в devDependencies.
    env: {
      test: {
        plugins: ['@babel/plugin-transform-dynamic-import'],
      },
    },
  };
};
