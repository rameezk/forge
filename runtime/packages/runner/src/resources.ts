import { availableParallelism, totalmem } from 'node:os';

export interface Box {
  memoryBytes: number;
  cpuCount: number;
}

export const thisBox = (): Box => ({
  memoryBytes: totalmem(),
  cpuCount: availableParallelism(),
});

const SIZE_UNITS = 'KMGTPE';

export const sharedMemoryBytes = (max: string, boxBytes: number): number => {
  if (max === 'infinity') return boxBytes;
  if (max.endsWith('%')) {
    return Math.floor((boxBytes * Number.parseFloat(max)) / 100);
  }
  const unit = SIZE_UNITS.indexOf(max.at(-1) ?? '');
  if (unit === -1) return Number.parseInt(max, 10);
  return Math.floor(Number.parseFloat(max) * 1024 ** (unit + 1));
};

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

export const formatSize = (bytes: number): string => {
  let unit = 0;
  while (unit < BINARY_UNITS.length - 1 && bytes >= 1024 ** (unit + 1)) {
    unit += 1;
  }
  const value = Math.round((bytes / 1024 ** unit) * 10) / 10;
  return `${value} ${BINARY_UNITS[unit]}`;
};

export const resourceNote = (sharedMemoryMax: string, box: Box): string =>
  [
    `Resources: every running workload and every build the nix daemon runs share one shared memory limit of ${formatSize(sharedMemoryBytes(sharedMemoryMax, box.memoryBytes))}, so other workloads share the memory you use.`,
    `The box has ${box.cpuCount} ${box.cpuCount === 1 ? 'CPU' : 'CPUs'}.`,
    'A command that exits with 137 ran out of memory: it should not be retried at the same scale, so try a lighter approach, such as less parallelism or smaller inputs.',
  ].join('\n');
