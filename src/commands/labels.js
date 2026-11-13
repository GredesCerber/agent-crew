// crew labels sync — create/update labels in the GitHub repo (status:*, area:*, tier:*, risk:*, agent:*).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok } from '../core/output.js';
import { gh } from '../core/exec.js';
import { HARNESS_ROOT, loadConfig } from '../core/config.js';

export function allLabels(config) {
  const base = JSON.parse(readFileSync(join(HARNESS_ROOT, 'templates', 'labels.json'), 'utf8'));
  const areas = Object.keys(config.areas ?? {}).map((a) => ({ name: `area:${a}`, color: 'c5def5', description: `area ${a}` }));
  const agents = (config.hosts ?? []).map((h) => ({ name: `agent:${h}`, color: 'ededed', description: `done by agent ${h}` }));
  return [...base, ...areas, ...agents];
}

export default {
  name: 'labels sync',
  summary: 'Create status, area, tier and agent labels in the GitHub repo',
  agent: false,
  args: [],
  run() {
    const { config, root } = loadConfig();
    const labels = allLabels(config);
    for (const l of labels) {
      gh(['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force'], { cwd: root });
    }
    return ok(`Labels synced: ${labels.length}`, { artifacts: { labels: labels.map((l) => l.name) } });
  },
};
