import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kind, type OperationDefinitionNode, parse } from 'graphql';
import * as feedback from '../src/feedback.ts';
import * as frontier from '../src/frontier.ts';

const queries = Object.entries<unknown>({ ...feedback, ...frontier }).filter(
  (entry): entry is [string, string] => entry[0].endsWith('_QUERY') && typeof entry[1] === 'string',
);

const answered = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const operationName = (query: string): string | undefined =>
  parse(query).definitions.find(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  )?.name?.value;

test('given any query forge sends and an answer with data and errors, when forge reads it, then it fails naming the query, the repository and GitHub\'s messages', async () => {
  for (const [constant, query] of queries) {
    await assert.rejects(
      frontier.readGraphql(
        answered({ data: { repository: {} }, errors: [{ message: 'first' }, { message: 'second' }] }),
        query,
        'rameezk/forge#7',
      ),
      new Error(`GitHub rejected the ${operationName(query)} query for rameezk/forge#7: first; second`),
      constant,
    );
  }
});

test('given an answer with data and no errors or an empty errors list, when forge reads it, then it returns the data', async () => {
  const data = { repository: null };
  assert.deepEqual(await frontier.readGraphql(answered({ data }), frontier.TICKET_QUERY, 'a/b'), data);
  assert.deepEqual(
    await frontier.readGraphql(answered({ data, errors: [] }), frontier.TICKET_QUERY, 'a/b'),
    data,
  );
});
