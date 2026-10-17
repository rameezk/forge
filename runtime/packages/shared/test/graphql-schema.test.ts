import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientSchema, extendSchema, type IntrospectionQuery, parse, validate } from 'graphql';
import { schema as githubSchema } from '@octokit/graphql-schema';
import * as feedback from '../src/feedback.ts';
import * as frontier from '../src/frontier.ts';

const published = buildClientSchema(githubSchema.json as unknown as IntrospectionQuery);

const schema = extendSchema(
  published,
  parse(`
    type IssueDependenciesSummary {
      blockedBy: Int!
      blocking: Int!
    }

    extend type Issue {
      issueDependenciesSummary: IssueDependenciesSummary!
      blockedBy(first: Int, after: String): IssueConnection!
      parent: Issue
    }
  `),
);

const queries = Object.entries<unknown>({ ...feedback, ...frontier }).filter(
  (entry): entry is [string, string] => entry[0].endsWith('_QUERY') && typeof entry[1] === 'string',
);

test('given the query constants the feedback and frontier code exports, then forge sends GitHub every query it knows', () => {
  assert.deepEqual(
    queries.map(([name]) => name).sort(),
    [
      'CLOSED_QUERY',
      'CLOSING_PULL_REQUESTS_QUERY',
      'FEEDBACK_ANSWERS_QUERY',
      'FEEDBACK_WINDOW_QUERY',
      'FRONTIER_QUERY',
      'LABELLED_QUERY',
      'PULL_REQUEST_CONFLICT_QUERY',
      'PULL_REQUEST_HEAD_QUERY',
      'PULL_REQUEST_QUERY',
      'PULL_REQUEST_READINESS_QUERY',
      'TICKET_QUERY',
      'WATCHED_PULL_REQUESTS_QUERY',
    ],
  );
});

for (const [name, query] of queries) {
  test(`given ${name}, when it is validated against GitHub's published schema, then it has no errors`, () => {
    assert.deepEqual(
      validate(schema, parse(query)).map((error) => error.message),
      [],
    );
  });
}

test('given a query asking for a field GitHub lacks, when it is validated against GitHub schema, then the error names the field', () => {
  const errors = validate(schema, parse('query { viewer { reactor } }'));

  assert.deepEqual(
    errors.map((error) => error.message),
    ['Cannot query field "reactor" on type "User".'],
  );
});
