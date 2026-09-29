import { isGithubRepository } from '@forge/shared';

export interface RepositoryConfig {
  github: string;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}

export interface ManagedRepository {
  name: string;
  github: string;
}

export const managedRepositories = (
  config: FrontierConfig,
): ManagedRepository[] =>
  Object.entries(config.repositories).map(([name, { github }]) => {
    if (!isGithubRepository(github)) {
      throw new Error(
        `repository '${name}' must name its GitHub repository as owner/name, got '${github}'`,
      );
    }
    return { name, github };
  });
