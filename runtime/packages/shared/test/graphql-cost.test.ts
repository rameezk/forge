import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as approval from '../src/approval.ts';
import * as edits from '../src/edits.ts';
import * as feedback from '../src/feedback.ts';
import * as frontier from '../src/frontier.ts';
import * as ticketContext from '../src/ticket-context.ts';
import { countNodes } from './fixtures/graphql-cost.ts';

const GITHUB_NODE_LIMIT = 500_000;

const queries = Object.entries<unknown>({
  ...approval,
  ...edits,
  ...feedback,
  ...frontier,
  ...ticketContext,
}).filter(
  (entry): entry is [string, string] =>
    (entry[0].endsWith('_QUERY') || entry[0].endsWith('_MUTATION')) && typeof entry[1] === 'string',
);

const SENT: Record<string, Record<string, number>> = {
  FRONTIER_QUERY: { first: frontier.FRONTIER_PAGE_SIZE },
  CLOSED_QUERY: { first: frontier.FRONTIER_PAGE_SIZE },
  LABELLED_QUERY: { first: frontier.FRONTIER_PAGE_SIZE },
  WATCHED_PULL_REQUESTS_QUERY: { first: feedback.WATCHED_PAGE_SIZE },
};

for (const [name, query] of queries) {
  test(`given ${name}, when its static node cost is counted, then it is within GitHub's limit of ${GITHUB_NODE_LIMIT}`, () => {
    assert.ok(countNodes(query, SENT[name]) <= GITHUB_NODE_LIMIT);
  });
}

test('given a query of reviews of 100, each with comments of 100, each with reactors of 100, when its cost is counted, then it counts every connection level', () => {
  const query = `
    query {
      repository(owner: "o", name: "n") {
        pullRequest(number: 1) {
          reviews(last: 100) {
            nodes {
              comments(first: 100) {
                nodes {
                  reactionGroups {
                    reactors(first: 100) {
                      nodes {
                        __typename
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  assert.equal(countNodes(query), 1_010_100);
});

test('given a query with sibling connections, a fragment spread nested under a connection and a variable page size, when its cost is counted, then siblings add, the fragment is expanded under its parent and the variable takes the value sent', () => {
  const query = `
    query Q($first: Int!) {
      repository(owner: "o", name: "n") {
        issues(first: $first) {
          nodes {
            ...Labelled
          }
        }
        pullRequests(first: 5) {
          nodes {
            number
          }
        }
      }
    }
    fragment Labelled on Issue {
      labels(first: 10) {
        nodes {
          name
        }
      }
    }
  `;

  assert.equal(countNodes(query, { first: 20 }), 20 + 20 * 10 + 5);
});

test('given a connection whose page size is a variable with no value sent, when its cost is counted, then counting fails naming the variable', () => {
  const query = `query Q($first: Int!) { viewer { repositories(first: $first) { nodes { name } } } }`;

  assert.throws(() => countNodes(query), /first/);
});
