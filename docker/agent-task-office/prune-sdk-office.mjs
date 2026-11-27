/** 装配原生 Office 沙箱所用的 DSH SDK，移除重复的 Office 后端。 */
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const modules = join(process.cwd(), 'node_modules', '@deepseek-ai');
const profile = join(modules, 'dsh-sdk-app', 'cordis.patch.yml');
const registrations = ['office-kit', 'tool-office', 'skill-office'];
let content = await readFile(profile, 'utf8');
for (const id of registrations) {
  const matcher = new RegExp('^    - id: ' + id + '\\r?\\n(?: {6}[^\\n]*\\n)*', 'gm');
  if (Array.from(content.matchAll(matcher)).length !== 1) {
    throw new Error('Expected a single SDK registration for ' + id);
  }
  content = content.replace(matcher, '');
}
await writeFile(profile, content);

// SDK 客户端的协议仍依赖 dsh-office-kit/remote，因此保留该包。
const entries = await readdir(modules);
const officePackages = ['dsh-skill-office', 'dsh-tool-office', 'libreoffice-kit', 'libreoffice-kit-wasm'];
for (const name of officePackages) {
  if (!entries.includes(name)) throw new Error('Missing expected dependency ' + name);
}
const remove = entries.filter(name => officePackages.includes(name) || name.startsWith('libreoffice-kit-'));
await Promise.all(remove.map(name => rm(join(modules, name), { recursive: true })));
