// Stops a release numbered lower than the version already in config.yaml.
// semantic-release numbers releases from its git tags, not from config.yaml,
// and Home Assistant only offers an add-on update when the version goes up.
// If the two disagree, releases silently stop reaching installs: this fork's
// first automated release restarted at 1.0.0 after 1.50.10 (see 1.51.5 in
// CHANGELOG.md).
//
// Run by semantic-release (verifyReleaseCmd in .releaserc.json) before it
// writes the new version into config.yaml:
//   node scripts/check-release-version.cjs <next version>

const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

function configVersion(configYaml) {
  const match = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(configYaml);
  return match ? match[1] : null;
}

/** Why `next` can't be released over this config.yaml, or null if it can. */
function releaseVersionProblem(next, configYaml) {
  const current = configVersion(configYaml);
  if (!parseVersion(next)) {
    return `Next release version ${JSON.stringify(next)} isn't in x.y.z form.`;
  }
  if (!parseVersion(current)) {
    return `Couldn't read an x.y.z version from config.yaml (found ${JSON.stringify(current)}).`;
  }
  if (compareVersions(next, current) < 0) {
    return [
      `Release ${next} would be lower than config.yaml's version ${current}, so`,
      'Home Assistant would never offer it to installs. semantic-release numbers',
      "releases from its git tags, and config.yaml has moved past them. See",
      '"Release Versions Only Go Up" in CLAUDE.md for how to fix this.',
    ].join('\n');
  }
  return null;
}

module.exports = { releaseVersionProblem };

if (require.main === module) {
  const configYaml = fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8');
  const problem = releaseVersionProblem(process.argv[2], configYaml);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
