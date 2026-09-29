import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

// Observe only a test-owned home; deletion belongs to its fixture owner after
// child close. Production queue identities are never garbage-collected here.
export function observeFixtureCoordination(fixture, minimumTargets = 1) {
  const namespace = join(fixture.home, '.proof-or-stop', 'locks', 'workspace-validation-coordination');
  // Migration fence authority files share this directory but are not queues.
  const names = existsSync(namespace) ? readdirSync(namespace).filter(name => /^[a-f0-9]{64}$/.test(name)) : [];
  assert.ok(names.length >= minimumTargets, 'actual coordination targets must exist in the private fixture home');
  return names.map(name => {
    assert.match(name, /^[a-f0-9]{64}$/);
    const target = join(namespace, name);
    assert.equal(lstatSync(target).isDirectory(), true, 'coordination target must be an owned directory, not a symlink');
    const actual = realpathSync(target);
    const inside = relative(realpathSync(fixture.root), actual);
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep), 'actual coordination target escaped the fixture root');
    return actual;
  });
}

export function assertFixtureCoordinationRemoved(fixture, targets) {
  assert.equal(existsSync(fixture.root), false, 'fixture root must be removed after child close');
  for (const target of targets) assert.equal(existsSync(target), false, 'observed external coordination target must be removed: ' + target);
}

export function assertObservedCoordinationAliases(output, targets, expectedCount) {
  const aliases = output.split('\n').filter(line => line.startsWith('COORDINATION_ALIAS_TARGET '))
    .map(line => JSON.parse(line.slice('COORDINATION_ALIAS_TARGET '.length)));
  assert.equal(aliases.length, expectedCount, 'the child must report the actual compatibility aliases');
  for (const target of aliases) assert.ok(targets.includes(target), 'actual compatibility alias must resolve inside the observed private namespace');
}

// Child-reported realpaths are captured during admission; after normal child
// exit, deleted fixture repositories must leave no physical queue behind.
export function assertReclaimedFixtureCoordination(fixture, output, expectedCount) {
  const namespace = join(realpathSync(fixture.home), '.proof-or-stop', 'locks', 'workspace-validation-coordination');
  const targets = output.split('\n').filter(line => line.startsWith('COORDINATION_ALIAS_TARGET '))
    .map(line => JSON.parse(line.slice('COORDINATION_ALIAS_TARGET '.length)));
  assert.equal(targets.length, expectedCount);
  for (const target of targets) {
    assert.match(relative(namespace, target), /^[a-f0-9]{64}$/);
    assert.equal(existsSync(target), false, 'disposed fixture queue survived child exit');
  }
  assert.deepEqual(observeFixtureCoordination(fixture, 0), [], 'unexpected abandoned fixture queue');
  return targets;
}
