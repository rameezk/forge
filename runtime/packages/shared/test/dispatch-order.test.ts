import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOrder } from '../src/dispatch-order.ts';

test('dispatch order takes the oldest ticket first, then the lowest number', () => {
  const tickets = [
    { createdAt: '2026-03-02T00:00:00Z', number: 1 },
    { createdAt: '2026-03-01T00:00:00Z', number: 9 },
    { createdAt: '2026-03-01T00:00:00Z', number: 4 },
  ];
  assert.deepEqual(tickets.toSorted(dispatchOrder).map(({ number }) => number), [4, 9, 1]);
});
