#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm run lint
npx jest --runInBand src/ui src/__tests__
