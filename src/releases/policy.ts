/** Deliberately outside the agent's writable game directory. */
export function protectedPath(file: string, existed: boolean): boolean {
  if (!/^(src\/|public\/|docs\/|release-checks\/)/.test(file)) return true;
  if (/(^|\/)(?:AGENTS\.md|\.env[^/]*|\.codex)(?:\/|$)/.test(file)) return true;
  if (/^public\/(?:sw\.js|_.*|manifest.*)$/.test(file)) return true;
  if (/^src\/(?:main\.tsx|platform\/|bugReport\/)/.test(file)) return true;
  if (existed && /(?:storage\.[tj]sx?$|\.(?:test|spec)\.[tj]sx?$)/.test(file)) return true;
  return false;
}
export function riskyStorageDiff(diff: string): boolean {
  return diff.split('\n').some(line => /^[+-](?![+-])/.test(line) && /(?:STORAGE[_A-Z]*|(?:localStorage|indexedDB)\s*\.|createStore\s*\(|storageVersion|storageKey|namespace\s*:)/i.test(line));
}
export class ReviewRequired extends Error {}
export class CheckFailed extends Error {}

export class CheckUnavailable extends Error {}
