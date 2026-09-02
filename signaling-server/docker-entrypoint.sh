#!/bin/sh
# Том fly монтируется root'ом, а процесс работает не от root. Каталог базы
# токенов передаётся пользователю node здесь — единственное место, где ещё
# есть права это сделать, — и права тут же сбрасываются.
set -e

if [ -n "$PUSH_TOKEN_DB" ]; then
  dir=$(dirname "$PUSH_TOKEN_DB")
  mkdir -p "$dir"
  chown -R node:node "$dir"
fi

exec su-exec node "$@"
