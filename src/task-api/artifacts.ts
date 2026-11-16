/** 在任务结束后，读取一次性执行器的 run-* 产物目录。 */
import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingPath, isPathSegment, TaskApiError } from './inputs.js';

interface Artifact {
  path: string;
  size: number;
}

async function stat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

async function collect(dir: string, segments: string[], files: Artifact[]): Promise<void> {
  const entries = await readdir(dir);
  for (const name of entries.sort()) {
    if (!isPathSegment(name) || (segments.length === 0 && !name.startsWith('run-'))) continue;
    const path = join(dir, name);
    const child = [...segments, name];
    const info = await stat(path);
    if (info?.isDirectory()) await collect(path, child, files);
    if (segments.length > 0 && info?.isFile() && info.nlink === 1) {
      files.push({ path: child.join('/'), size: info.size });
    }
  }
}

/** 列出已结束任务的普通产物文件。尚未创建产物目录时返回空列表。 */
export async function listArtifacts(root: string): Promise<Artifact[]> {
  const files: Artifact[] = [];
  if ((await stat(root))?.isDirectory()) await collect(root, [], files);
  return files;
}

/** 验证下载路径并返回文件位置与大小。越界、链接和不存在的文件返回 HTTP 404。 */
export async function findArtifact(root: string, segments: string[]): Promise<{ path: string; size: number }> {
  const missing = new TaskApiError(404, 'Artifact not found');
  if (segments.length < 2 || !segments[0].startsWith('run-') || !segments.every(isPathSegment)) throw missing;
  let path = root;
  for (const segment of segments) {
    if (!(await stat(path))?.isDirectory()) throw missing;
    path = join(path, segment);
  }
  const info = await stat(path);
  if (!info?.isFile() || info.nlink !== 1) throw missing;
  return { path, size: info.size };
}
