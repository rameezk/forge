import type { RunSkillLoad } from '@forge/shared';

export interface SkillSummary {
  skill: string;
  prompt: boolean;
  parent: boolean;
  subagents: number;
}

export const summarizeSkillLoads = (loads: RunSkillLoad[]): SkillSummary[] => {
  const summaries = new Map<string, SkillSummary>();
  for (const { skill, source, subagent } of loads) {
    const summary = summaries.get(skill) ?? {
      skill,
      prompt: false,
      parent: false,
      subagents: 0,
    };
    summaries.set(skill, summary);
    if (subagent !== null) {
      summary.subagents += 1;
    } else if (source === 'prompt') {
      summary.prompt = true;
    } else {
      summary.parent = true;
    }
  }
  return [...summaries.values()].sort((a, b) => a.skill.localeCompare(b.skill));
};
