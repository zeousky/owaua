// October 21, 2026 security-release floors. Unknown release lines require review.
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
export const SUPPORTED_NODE = '^24.22.1 || ^26.12.1';

export function assertSupportedNode(version = process.versions.node) {
  const parts = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const [major, minor, patch] = parts ? parts.slice(1).map(Number) : [];
  const minimumMinor = major === 24 ? 22 : major === 26 ? 12 : undefined;
  if (minimumMinor === undefined || ![major, minor, patch].every(Number.isSafeInteger) ||
    minor < minimumMinor || minor === minimumMinor && patch < 1) {
    throw new Error(`Unsupported Node.js ${version}. Owaua requires ${SUPPORTED_NODE}; select the version in .nvmrc before starting.`);
  }
}

// Keep this module first in executable entry points: fail before loading secrets.
assertSupportedNode();
