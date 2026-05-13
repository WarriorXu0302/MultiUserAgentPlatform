import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpState: { root: string; originalCwd: string } = { root: '', originalCwd: '' };

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get GROUPS_DIR(): string {
      return path.join(tmpState.root, 'groups');
    },
  };
});

const { composeGroupClaudeMd } = await import('./claude-md-compose.js');
const { writeContainerConfig } = await import('./container-config.js');

beforeEach(() => {
  tmpState.originalCwd = process.cwd();
  tmpState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontlane-compose-'));
  fs.mkdirSync(path.join(tmpState.root, 'groups'), { recursive: true });
  fs.mkdirSync(path.join(tmpState.root, 'container', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpState.root, 'container', 'agent-runner', 'src', 'mcp-tools'), { recursive: true });
  process.chdir(tmpState.root);
});

afterEach(() => {
  process.chdir(tmpState.originalCwd);
  fs.rmSync(tmpState.root, { recursive: true, force: true });
});

function seedSkill(name: string, withInstructions: boolean): void {
  const dir = path.join(tmpState.root, 'container', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  if (withInstructions) {
    fs.writeFileSync(path.join(dir, 'instructions.md'), `# ${name} instructions\n`);
  }
}

function fragmentNames(folder: string): string[] {
  const dir = path.join(tmpState.root, 'groups', folder, '.claude-fragments');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

describe('composeGroupClaudeMd — skill subset (container.json#skills)', () => {
  it('includes every skill with instructions.md when skills="all"', () => {
    seedSkill('arxiv', true);
    seedSkill('lark-base', true);
    seedSkill('rag-upload', false);

    writeContainerConfig('worker-a', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    composeGroupClaudeMd({
      id: 'ag-test-a',
      name: 'Test A',
      folder: 'worker-a',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const frags = fragmentNames('worker-a').filter((n) => n.startsWith('skill-'));
    expect(frags).toEqual(['skill-arxiv.md', 'skill-lark-base.md']);
  });

  it('includes only listed skills when skills is an array', () => {
    seedSkill('arxiv', true);
    seedSkill('lark-base', true);
    seedSkill('lark-im', true);
    seedSkill('semantic-scholar', true);

    writeContainerConfig('worker-knowledge', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: ['arxiv', 'semantic-scholar'],
    });

    composeGroupClaudeMd({
      id: 'ag-test-k',
      name: 'Knowledge',
      folder: 'worker-knowledge',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const frags = fragmentNames('worker-knowledge').filter((n) => n.startsWith('skill-'));
    expect(frags).toEqual(['skill-arxiv.md', 'skill-semantic-scholar.md']);
  });

  it('silently skips array entries that lack instructions.md', () => {
    seedSkill('arxiv', true);
    seedSkill('rag-upload', false);

    writeContainerConfig('worker-mixed', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: ['arxiv', 'rag-upload', 'nonexistent'],
    });

    composeGroupClaudeMd({
      id: 'ag-test-m',
      name: 'Mixed',
      folder: 'worker-mixed',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const frags = fragmentNames('worker-mixed').filter((n) => n.startsWith('skill-'));
    expect(frags).toEqual(['skill-arxiv.md']);
  });

  it('reconciles fragment dir when skills config shrinks', () => {
    seedSkill('arxiv', true);
    seedSkill('lark-base', true);

    // First spawn with skills='all'
    writeContainerConfig('worker-shrink', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });
    composeGroupClaudeMd({
      id: 'ag-test-s',
      name: 'Shrink',
      folder: 'worker-shrink',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    expect(fragmentNames('worker-shrink').filter((n) => n.startsWith('skill-'))).toEqual([
      'skill-arxiv.md',
      'skill-lark-base.md',
    ]);

    // Re-compose with skills=['arxiv'] — lark-base fragment should be pruned
    writeContainerConfig('worker-shrink', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: ['arxiv'],
    });
    composeGroupClaudeMd({
      id: 'ag-test-s',
      name: 'Shrink',
      folder: 'worker-shrink',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    expect(fragmentNames('worker-shrink').filter((n) => n.startsWith('skill-'))).toEqual(['skill-arxiv.md']);
  });
});
