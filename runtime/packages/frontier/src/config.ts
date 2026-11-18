export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string; feedback?: string; conflict?: string };
  grading?: boolean;
  description?: string;
  autoApprove?: boolean;
  priority?: number;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
