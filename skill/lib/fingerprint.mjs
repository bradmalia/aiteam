import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Compute SHA-256 fingerprint over a set of repository-relative file paths.
 * @param {string} repo - Absolute path to repository root
 * @param {string[]} files - Array of relative file paths
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function computeFingerprint(repo, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return '';
  }

  const sortedFiles = [...new Set(files)].sort();
  const hash = crypto.createHash('sha256');

  for (const relPath of sortedFiles) {
    const fullPath = path.resolve(repo, relPath);
    hash.update(relPath + '\n');
    try {
      const content = fs.readFileSync(fullPath);
      hash.update(content);
    } catch {
      hash.update('__FILE_MISSING__\n');
    }
  }

  return hash.digest('hex');
}

/**
 * Verify if current repository files match a previously recorded fingerprint.
 * @param {string} repo - Absolute path to repository root
 * @param {string[]} files - Array of relative file paths
 * @param {string} expectedFingerprint - Expected SHA-256 hex string
 * @returns {boolean} True if matching, false otherwise
 */
export function verifyFingerprint(repo, files, expectedFingerprint) {
  if (!expectedFingerprint) return false;
  return computeFingerprint(repo, files) === expectedFingerprint;
}
