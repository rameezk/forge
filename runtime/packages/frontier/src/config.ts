export interface RepositoryConfig {
  github: string;
  worker?: string;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
  dispatch?: { gitIdentity?: { name: string; email: string } };
}
