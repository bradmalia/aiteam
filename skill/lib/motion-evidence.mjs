import fs from 'node:fs';
import path from 'node:path';

export const MOTION_SCENARIOS = {
  NORMAL_OPERATION: 'normal-operation',
  CONTACT_INTERACTION: 'contact-interaction',
  FAILURE_RETRY: 'failure-retry',
  COMPLETION_TRANSITION: 'completion-transition'
};

export const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.ogg']);

/**
 * Validate motion evidence reference(s).
 * @param {string} repo - Root repository path
 * @param {string|object|Array} evidence - Motion evidence path, manifest, or array
 * @returns {{ valid: boolean, errors: string[], clips: Array<{ name: string, path: string, url: string, scenario?: string, mime: string, size: number }> }}
 */
export function validateMotionEvidence(repo, evidence) {
  const errors = [];
  const clips = [];

  if (!evidence) {
    return { valid: false, errors: ['No motion evidence provided.'], clips: [] };
  }

  const items = Array.isArray(evidence) ? evidence : [evidence];

  for (const item of items) {
    if (typeof item === 'string') {
      const relPath = item.replace(/^https?:\/\/[^/]+(?:\/review-assets\/|\/artifacts\/)?/, '');
      const candidates = [
        path.resolve(repo, item),
        path.resolve(repo, relPath),
        path.resolve(repo, '.aiteam', 'reviews', relPath),
        path.resolve(repo, '.aiteam', 'docs', relPath)
      ];
      const matched = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!matched) {
        errors.push(`Referenced motion file does not exist: "${item}"`);
        continue;
      }

      const ext = path.extname(matched).toLowerCase();
      const stat = fs.statSync(matched);
      if (stat.size === 0) {
        errors.push(`Motion evidence file is empty (0 bytes): "${item}"`);
        continue;
      }

      if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
        const mime = ext === '.webm' ? 'video/webm' : ext === '.mp4' ? 'video/mp4' : 'video/ogg';
        const relativeToRepo = path.relative(repo, matched);
        const url = relativeToRepo.startsWith('.aiteam/reviews/')
          ? `/review-assets/${relativeToRepo.slice('.aiteam/reviews/'.length)}`
          : `/${relativeToRepo}`;
        clips.push({
          name: path.basename(matched),
          path: relativeToRepo,
          url,
          mime,
          size: stat.size
        });
      } else if (ext === '.json') {
        // Frame sequence index or motion manifest
        try {
          const parsed = JSON.parse(fs.readFileSync(matched, 'utf8'));
          const subClips = parseMotionManifest(repo, matched, parsed);
          if (subClips.errors.length) {
            errors.push(...subClips.errors);
          } else {
            clips.push(...subClips.clips);
          }
        } catch (e) {
          errors.push(`Invalid motion manifest JSON in "${item}": ${e.message}`);
        }
      } else {
        errors.push(`Unsupported motion format "${ext}". Expected .webm, .mp4, or manifest .json.`);
      }
    } else if (typeof item === 'object' && item !== null) {
      if (item.videoPath || item.path) {
        const p = item.videoPath || item.path;
        const sub = validateMotionEvidence(repo, p);
        if (!sub.valid) {
          errors.push(...sub.errors);
        } else {
          for (const c of sub.clips) {
            clips.push({
              ...c,
              scenario: item.scenario || item.name || c.scenario,
              caption: item.caption || item.description || c.caption
            });
          }
        }
      } else if (item.frameSequence) {
        const sub = validateFrameSequence(repo, item.frameSequence);
        if (!sub.valid) {
          errors.push(...sub.errors);
        } else {
          clips.push(sub.clip);
        }
      } else {
        errors.push('Motion evidence object missing "videoPath", "path", or "frameSequence".');
      }
    }
  }

  return {
    valid: errors.length === 0 && clips.length > 0,
    errors,
    clips
  };
}

function parseMotionManifest(repo, manifestFile, manifest) {
  const dir = path.dirname(manifestFile);
  const errors = [];
  const clips = [];

  const videoList = Array.isArray(manifest.videos)
    ? manifest.videos
    : (manifest.video ? [manifest.video] : []);

  for (const v of videoList) {
    const rawPath = typeof v === 'string' ? v : v.path || v.file;
    if (!rawPath) continue;
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(dir, rawPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`Manifest video not found: "${rawPath}" referenced in "${manifestFile}"`);
      continue;
    }
    const stat = fs.statSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mime = ext === '.webm' ? 'video/webm' : ext === '.mp4' ? 'video/mp4' : 'video/ogg';
    const relativeToRepo = path.relative(repo, absPath);
    const url = relativeToRepo.startsWith('.aiteam/reviews/')
      ? `/review-assets/${relativeToRepo.slice('.aiteam/reviews/'.length)}`
      : `/${relativeToRepo}`;

    clips.push({
      name: typeof v === 'object' && v.name ? v.name : path.basename(absPath),
      scenario: typeof v === 'object' ? v.scenario : undefined,
      caption: typeof v === 'object' ? v.caption : undefined,
      path: relativeToRepo,
      url,
      mime,
      size: stat.size
    });
  }

  if (manifest.frameSequence) {
    const seq = validateFrameSequence(repo, manifest.frameSequence, dir);
    if (!seq.valid) {
      errors.push(...seq.errors);
    } else {
      clips.push(seq.clip);
    }
  }

  if (clips.length === 0 && errors.length === 0) {
    errors.push(`No video clips or frame sequences found in manifest "${manifestFile}".`);
  }

  return { errors, clips };
}

function validateFrameSequence(repo, seq, baseDir = repo) {
  const errors = [];
  const seqDir = path.isAbsolute(seq.dir || '') ? seq.dir : path.resolve(baseDir, seq.dir || '.');
  if (!fs.existsSync(seqDir) || !fs.statSync(seqDir).isDirectory()) {
    return { valid: false, errors: [`Frame sequence directory not found: "${seq.dir}"`] };
  }

  const count = Number(seq.count || 0);
  const pattern = seq.pattern || 'frame-%03d.png';
  let found = 0;

  if (count > 0) {
    for (let i = 0; i < Math.min(count, 5); i++) {
      const fn = pattern.replace(/%0(\d+)d/, (_, d) => String(i).padStart(Number(d), '0'));
      const fp = path.join(seqDir, fn);
      if (fs.existsSync(fp)) found++;
    }
    if (found === 0) {
      errors.push(`Frame sequence pattern "${pattern}" did not match files in "${seq.dir}".`);
    }
  } else {
    try {
      const files = fs.readdirSync(seqDir).filter((f) => /\.(?:png|jpg|webp)$/i.test(f));
      if (files.length === 0) {
        errors.push(`No image frames found in frame sequence directory "${seq.dir}".`);
      } else {
        found = files.length;
      }
    } catch (e) {
      errors.push(`Cannot read frame sequence directory "${seq.dir}": ${e.message}`);
    }
  }

  const relativeDir = path.relative(repo, seqDir);
  return {
    valid: errors.length === 0,
    errors,
    clip: {
      name: seq.name || 'Frame Sequence',
      type: 'frame-sequence',
      dir: relativeDir,
      fps: seq.fps || 10,
      count: found || count,
      pattern,
      scenario: seq.scenario || 'native-frames'
    }
  };
}
