const fs = require('fs');
const path = require('path');

function assertDiskReserve(root, incomingBytes = 0, { reserveBytes = 256 * 1024 ** 2, statfs = fs.statfsSync } = {}) {
  const space = statfs(root);
  if (Number(space.bavail) * Number(space.bsize) - incomingBytes < reserveBytes) {
    const error = new Error('storage_reserve'); error.status = 507; throw error;
  }
}

// File storage has a shared ceiling across identities. Refuse before allocating
// a temporary copy, and leave filesystem space for SQLite/WAL and recovery.
function assertFileStorageBudget(root, incomingBytes, options = {}) {
  const maxBytes = options.maxBytes ?? 16 * 1024 ** 3;
  const reserveBytes = options.reserveBytes ?? 256 * 1024 ** 2;
  const statfs = options.statfs || fs.statfsSync;
  assertDiskReserve(root, incomingBytes, { reserveBytes, statfs });
  let used = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) used += fs.statSync(file).size;
      if (used + incomingBytes > maxBytes) {
        const error = new Error('storage_quota'); error.status = 507; throw error;
      }
    }
  };
  visit(root);
}

module.exports = { assertFileStorageBudget, assertDiskReserve };
