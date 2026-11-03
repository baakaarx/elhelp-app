import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Skill } from './types.js';

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] };
}

export function loadSkills(rootDir?: string): Skill[] {
  // root/skills  (when running from server/src/agent)  ->  ../../../skills
  // Also support server/skills if someone moves it
  const candidates = [
    rootDir,
    fileURLToPath(new URL('../../../skills', import.meta.url)),
    fileURLToPath(new URL('../../skills', import.meta.url)),
    join(process.cwd(), 'skills'),
  ].filter(Boolean) as string[];

  let skillsDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) { skillsDir = c; break; }
  }
  if (!skillsDir) return [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillPath = join(skillsDir, e.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const raw = readFileSync(skillPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    skills.push({
      id: e.name,
      name: frontmatter.name || e.name,
      description: frontmatter.description || '',
      filePath: skillPath,
      content: body.trim(),
      loadedAt: Date.now(),
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function describeSkillsForPrompt(skills: Skill[]): string {
  return skills.map(s => `- ${s.name} (${s.id}): ${s.description}`).join('\n');
}
