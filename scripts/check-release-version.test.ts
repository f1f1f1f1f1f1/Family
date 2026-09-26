// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const { releaseVersionProblem } = createRequire(import.meta.url)('./check-release-version.cjs');

const config = (version: string) => `name: Family\nversion: "${version}"\nslug: family\n`;

describe('releaseVersionProblem', () => {
  it('allows a release above the current version', () => {
    expect(releaseVersionProblem('1.51.6', config('1.51.5'))).toBeNull();
    expect(releaseVersionProblem('1.52.0', config('1.51.5'))).toBeNull();
    expect(releaseVersionProblem('2.0.0', config('1.51.5'))).toBeNull();
  });

  it('allows a release equal to a version already put in config.yaml', () => {
    expect(releaseVersionProblem('1.51.6', config('1.51.6'))).toBeNull();
  });

  it('refuses a release below the current version', () => {
    // What happened when the fork's first automated release restarted at 1.0.0.
    expect(releaseVersionProblem('1.1.2', config('1.51.0'))).toMatch(
      /Release 1\.1\.2 would be lower than config\.yaml's version 1\.51\.0/,
    );
  });

  it('compares each part as a number, not as text', () => {
    expect(releaseVersionProblem('1.10.0', config('1.9.0'))).toBeNull();
    expect(releaseVersionProblem('1.51.10', config('1.51.9'))).toBeNull();
    expect(releaseVersionProblem('1.9.0', config('1.10.0'))).not.toBeNull();
  });

  it('reads an unquoted version', () => {
    expect(releaseVersionProblem('1.2.4', 'version: 1.2.3\n')).toBeNull();
  });

  it('refuses when either version is unreadable', () => {
    expect(releaseVersionProblem('1.2.3', 'name: Family\n')).toMatch(/Couldn't read/);
    expect(releaseVersionProblem('1.2.3', config('latest'))).toMatch(/Couldn't read/);
    expect(releaseVersionProblem(undefined, config('1.2.3'))).toMatch(/isn't in x\.y\.z form/);
  });

  it('reads the real config.yaml', () => {
    const real = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
    expect(releaseVersionProblem('999.0.0', real)).toBeNull();
    expect(releaseVersionProblem('0.0.1', real)).not.toBeNull();
  });
});
