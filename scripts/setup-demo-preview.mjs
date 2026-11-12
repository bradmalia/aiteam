import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  initSession,
  readSession,
  writeSession,
  updateTaskLedger,
  startStage,
  completeStage,
  recordApproval
} from '../skill/lib/state-bridge.mjs';
import { computeFingerprint } from '../skill/lib/fingerprint.mjs';
import { ensureWatcher } from '../src/watcher-discovery.mjs';

const demoRepo = path.resolve('/home/brad/aiteam/demo-acceptance-preview');

// Clean and recreate demo repo
fs.rmSync(demoRepo, { recursive: true, force: true });
fs.mkdirSync(demoRepo, { recursive: true });

// 1. Create source and test directories
fs.mkdirSync(path.join(demoRepo, 'src', 'encounters'), { recursive: true });
fs.mkdirSync(path.join(demoRepo, 'tests', 'qa'), { recursive: true });
fs.mkdirSync(path.join(demoRepo, '.aiteam', 'motion'), { recursive: true });
fs.mkdirSync(path.join(demoRepo, '.aiteam', 'reviews', 't1'), { recursive: true });

// 2. Create sample source implementation file
fs.writeFileSync(
  path.join(demoRepo, 'src', 'encounters', 'storm_chase.gd'),
  `# Storm chase controller
extends Node2D

@export var pursuit_speed: float = 236.0
@export var acceleration: float = 480.0
@export var camera_margin: float = 120.0

var pursuer_active: bool = false
var target: Node2D = null

func trigger_pursuit(p_target: Node2D) -> void:
    target = p_target
    pursuer_active = true

func _physics_process(delta: float) -> void:
    if pursuer_active and target != null:
        var dir = (target.global_position - global_position).normalized()
        global_position += dir * pursuit_speed * delta
`
);

// 3. Create independent QA test file
fs.writeFileSync(
  path.join(demoRepo, 'tests', 'qa', 'T1.test.mjs'),
  `// Independent QA test suite for T1 Storm Chase
export default {
  run: () => ({
    checks: [
      { name: 'actual_input_traversal', passed: true, actual: 'Maintained 236px/s across 90-deg turn' },
      { name: 'rendered_viewport_bounds', passed: true, actual: 'Inner margin 120px respected' }
    ]
  })
};
`
);

// 4. Generate 3 representative native motion clips using ffmpeg
const clip1 = path.join(demoRepo, '.aiteam', 'motion', 'goose_pursuit_traversal.webm');
const clip2 = path.join(demoRepo, '.aiteam', 'motion', 'goose_contact_and_retry.webm');
const clip3 = path.join(demoRepo, '.aiteam', 'reviews', 't1', 'camera_pressure_framing.webm');

console.log('Generating native motion preview clips via ffmpeg...');
execSync(`ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -c:v libvpx-vp9 -b:v 200k "${clip1}"`, { stdio: 'ignore' });
execSync(`ffmpeg -y -f lavfi -i smptebars=duration=2:size=640x360:rate=30 -c:v libvpx-vp9 -b:v 200k "${clip2}"`, { stdio: 'ignore' });
execSync(`ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -c:v libvpx-vp9 -b:v 200k "${clip3}"`, { stdio: 'ignore' });

// 5. Initialize session and register task
initSession(demoRepo, 'Implement playable reinforcing goose pursuit encounter with verified motion evidence');
recordApproval(demoRepo, { gate: 'prd', decision: 'approved', response: 'PRD approved' });
recordApproval(demoRepo, { gate: 'trd', decision: 'approved', response: 'TRD approved' });

const taskDefinition = {
  id: 'T1',
  title: 'Playable reinforcing goose pursuit encounter',
  description: 'Storm chase encounter requiring player controls, turn traversal, readable camera framing, and retry pacing.',
  filesChanged: ['src/encounters/storm_chase.gd'],
  status: 'planned',
  acceptanceCriteria: [
    'Goose maintains pursuit acceleration without dropping target during 90-degree turn under actual input',
    'Viewport pressure bounds 1280x720 maintain pursuer in inner safety margin',
    'Escalating panic audio/visual cues transition smoothly on contact and retry'
  ],
  acceptanceObligations: {
    actualInput: true,
    renderedChecks: true,
    motionEvidence: true,
    humanReview: true,
    componentTests: true
  }
};

updateTaskLedger(demoRepo, [taskDefinition]);

// 6. Advance through implementation and code-review stages
startStage(demoRepo, 'implementation', 'T1', 'programmer', 'Programmer');
completeStage(demoRepo, 'implementation', 'T1', {
  outcome: 'PASS',
  filesChanged: ['src/encounters/storm_chase.gd'],
  summary: 'Implemented storm chase controller with actual velocity steering'
});

startStage(demoRepo, 'code-review', 'T1', 'reviewer', 'Reviewer');
completeStage(demoRepo, 'code-review', 'T1', {
  outcome: 'PASS',
  summary: 'Code review verified no unlinked stubs or artificial state forcing'
});

// 7. Advance QA stage with motion evidence and rendered checks
startStage(demoRepo, 'qa', 'T1', 'qa', 'QA');
const qaResult = {
  outcome: 'PASS_WITH_MANUAL_VALIDATION',
  summary: 'Integrated execution passed. Actual-input traversal completed 90-deg turn; camera bounds verified; native motion clips captured for manual visual acceptance.',
  evidence: [
    '.aiteam/motion/goose_pursuit_traversal.webm',
    '.aiteam/motion/goose_contact_and_retry.webm',
    '.aiteam/reviews/t1/camera_pressure_framing.webm'
  ],
  motionEvidence: [
    {
      path: '.aiteam/motion/goose_pursuit_traversal.webm',
      scenario: 'Goose pursuit traversing 90-degree corner under simulated actual player steering',
      executionMethod: 'actual-input',
      durationSeconds: 2.0,
      frameCount: 60
    },
    {
      path: '.aiteam/motion/goose_contact_and_retry.webm',
      scenario: 'Contact hit detection, panic escalation, and retry reset pacing',
      executionMethod: 'integrated-execution',
      durationSeconds: 2.0,
      frameCount: 60
    },
    {
      path: '.aiteam/reviews/t1/camera_pressure_framing.webm',
      scenario: 'Rendered viewport camera pressure maintaining inner safety margin',
      executionMethod: 'rendered-measurement',
      durationSeconds: 2.0,
      frameCount: 60
    }
  ],
  checks: [
    {
      name: 'actual_input_turn_pursuit',
      passed: true,
      actual: 'Maintained 236px/s across 90-deg turn with continuous target tracking'
    },
    {
      name: 'rendered_camera_framing',
      passed: true,
      actual: 'Inner margin 120px respected at 1280x720 canvas resolution'
    }
  ],
  manualChecks: [
    'Verify that camera shake and panic escalation feel intense without obscuring obstacle readability',
    'Verify that player retry pacing feels natural after goose contact'
  ]
};

completeStage(demoRepo, 'qa', 'T1', qaResult);

console.log('Task advanced to QA automated pass; awaiting manual review.');

// 8. Launch Watcher server and discover URL
const watchUrl = await ensureWatcher(demoRepo);
console.log(`Watcher URL: ${watchUrl}`);

// Verify endpoints
const stateRes = await fetch(`${watchUrl}/api/state`);
if (!stateRes.ok) throw new Error(`Failed to fetch state: ${stateRes.status}`);
const stateData = await stateRes.json();

console.log(`Demo Repository: ${stateData.repository}`);
console.log(`Current Stage: ${stateData.session.currentStage}`);
console.log(`Pending Gate: ${stateData.session.pendingUserInput?.gate}`);

const videoRes = await fetch(`${watchUrl}/api/media?path=${encodeURIComponent('.aiteam/motion/goose_pursuit_traversal.webm')}`);
console.log(`Video media endpoint status: ${videoRes.status} (Content-Type: ${videoRes.headers.get('content-type')})`);

const reviewAssetRes = await fetch(`${watchUrl}/review-assets/t1/camera_pressure_framing.webm`);
console.log(`Review asset endpoint status: ${reviewAssetRes.status} (Content-Type: ${reviewAssetRes.headers.get('content-type')})`);

console.log('\n=== END-TO-END DEMONSTRATION READY ===');
console.log(`Review Dashboard URL: ${watchUrl}`);
