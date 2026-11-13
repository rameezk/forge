import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, resourceNote, sharedMemoryBytes } from '../src/resources.ts';

const GIB = 1024 ** 3;

test('given a shared memory limit set as a size, a percentage, plain bytes or infinity, when it is resolved on a 16 GiB box, then each means the size systemd reads', () => {
  assert.equal(sharedMemoryBytes('6G', 16 * GIB), 6 * GIB);
  assert.equal(sharedMemoryBytes('256M', 16 * GIB), 256 * 1024 ** 2);
  assert.equal(sharedMemoryBytes('1.5G', 16 * GIB), 1.5 * GIB);
  assert.equal(sharedMemoryBytes('80%', 16 * GIB), Math.floor(12.8 * GIB));
  assert.equal(sharedMemoryBytes('100%', 16 * GIB), 16 * GIB);
  assert.equal(sharedMemoryBytes('4096', 16 * GIB), 4096);
  assert.equal(sharedMemoryBytes('infinity', 16 * GIB), 16 * GIB);
});

test('given sizes from bytes to gibibytes, when they are formatted, then each uses the largest unit it reaches, with at most one decimal', () => {
  assert.equal(formatSize(256 * 1024 ** 2), '256 MiB');
  assert.equal(formatSize(6 * GIB), '6 GiB');
  assert.equal(formatSize(Math.floor(12.8 * GIB)), '12.8 GiB');
  assert.equal(formatSize(512), '512 B');
});

test('given a box, when the resource note is written, then it states the limit and CPU count and never says budget', () => {
  const note = resourceNote('80%', { memoryBytes: 16 * GIB, cpuCount: 8 });
  assert.match(note, /shared memory limit of 12\.8 GiB/);
  assert.match(note, /8 CPUs/);
  assert.doesNotMatch(note, /budget/i);
  assert.match(resourceNote('1G', { memoryBytes: GIB, cpuCount: 1 }), /1 CPU\b(?!s)/);
});
