export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string };
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
  dispatch?: { gitIdentity?: { name: string; email: string } };
}
