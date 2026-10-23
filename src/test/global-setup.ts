import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject) {
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, ...project.config.env },
  });
}
