import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Store,
  fingerprintHash,
  requestRecordRef,
  type HarnessOutput,
} from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import type { HarnessRegistry, RuntimeConfig } from '../src/index.ts';
import { builtInHarnesses, harnessFor } from '../src/harnesses.ts';
import { launchWorkload } from '../src/workload.ts';
import { resolveWorker } from '../src/config.ts';
import { fakeOpenRouter, LISTED_MODELS, billedAt } from './helpers.ts';

const SYSTEM_PROMPT = 'You are the scripted harness.';

const scripted: HarnessRegistry = {
  scripted: () => ({
    open: () => ({
      identity: async () => ({ version: '9.9.9', args: ['--scripted'] }),
      async *run(_invocation, sinks): AsyncIterable<HarnessOutput> {
        sinks.requestRecord({ type: 'system_prompt', hash: 'scripted-system', value: SYSTEM_PROMPT });
        sinks.requestRecord({
          type: 'tools',
          hash: 'scripted-tools',
          tools: [{ name: 'scripted_tool', description: 'Does the scripted thing', parameters: {} }],
        });
        sinks.requestRecord({
          type: 'request',
          body: {
            system: { hash: 'scripted-system' },
            messages: [{ role: 'user', hash: 'scripted-user' }],
            tools: { hash: 'scripted-tools' },
          },
          cacheMarkers: [],
        });
        yield {
          type: 'skill_load',
          skill: 'scripted-skill',
          source: 'prompt',
          subagent: null,
          coverage: { coveredLines: 3, totalLines: 3 },
        };
        yield {
          type: 'message',
          role: 'assistant',
          text: 'scripted reply',
          usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
          generationId: 'scripted-gen-1',
        };
        yield { type: 'result', status: 'success', sessionId: 'scripted-session', error: null };
      },
    }),
  }),
};

test('given a test-only harness registered by name that emits its own events, request record lines and skill loads, when a worker on it runs through the workload entry point, then its generation, skill load, request record and fingerprint are recorded and shown on the run page', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-registry-'));
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  const config: RuntimeConfig = {
    harnesses: { scripted: { command: '/not/used', args: ['--scripted'] } },
    workers: { scribe: { harness: 'scripted', model: 'z-ai/glm-5', prompt: 'go' } },
  };
  try {
    const { run } = await launchWorkload({
      config,
      worker: resolveWorker(config, 'scribe'),
      env: {
        FORGE_STATE_DIR: stateDir,
        OPENROUTER_BASE_URL: openRouter.baseUrl,
        OPENROUTER_API_KEY: 'sk-or-test',
      },
      openWorkspace: (workDir) => ({ workDir }),
      harnesses: scripted,
    });

    assert.equal(run.status, 'success');
    assert.equal(run.harness, 'scripted');
    const store = Store.open(join(stateDir, 'forge.db'));
    try {
      assert.deepEqual(
        store.listGenerations(run.id).map(({ generationId }) => generationId),
        ['scripted-gen-1'],
      );
      assert.deepEqual(
        store.listSkillLoads(run.id).map(({ skill, source }) => [skill, source]),
        [['scripted-skill', 'prompt']],
      );
      const fingerprint = store.getFingerprint(run.id);
      assert.equal(fingerprint?.fingerprint.harnessVersion, '9.9.9');
      assert.deepEqual(fingerprint?.fingerprint.harnessArgs, ['--scripted']);
      assert.notEqual(fingerprint?.fingerprint.systemPrompt, null);
      assert.equal(fingerprint?.fingerprint.tools, 'scripted-tools');
      assert.equal(fingerprint?.hash, fingerprintHash(fingerprint!.fingerprint));
      const app = createApp({
        store,
        transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
        css: '',
        logo: '',
        idiomorph: '',
        client: '',
      });
      const page = await (await app.request(`/runs/${run.id}`)).text();
      assert.match(page, /scripted reply/);
      assert.match(page, /scripted-skill/);
      assert.match(page, new RegExp(SYSTEM_PROMPT));
      assert.match(page, /scripted_tool/);
      assert.ok(requestRecordRef(run.id));
    } finally {
      store.close();
    }
  } finally {
    openRouter.close();
  }
});

test('given a pi worker on the anthropic provider that got past config resolution, when its harness is built, then it is refused because pi has no anthropic provider', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-registry-'));

  assert.throws(
    () =>
      harnessFor(builtInHarnesses, {
        name: 'pi',
        config: { command: '/not/used' },
        worker: {
          name: 'crossed',
          harness: 'pi',
          provider: 'anthropic',
          model: 'claude-opus-4-5',
          prompt: 'go',
        },
        env: {
          FORGE_BWRAP: '/not/used',
          HOME: stateDir,
          FORGE_PI_SUBAGENT_EXTENSION: '/not/used',
          FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: '/not/used',
          FORGE_PI_REQUEST_RECORD_EXTENSION: '/not/used',
        },
        harnessEnv: {},
        stateDir,
      }),
    /worker 'crossed' pairs harness 'pi' with provider 'anthropic'/,
  );
});
