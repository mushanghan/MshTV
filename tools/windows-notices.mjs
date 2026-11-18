import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(resolve(process.argv[2]), 'licenses');
mkdirSync(output, { recursive: true });
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const inventory = [
  'MshTV win-x64 bundled dependency inventory',
  'The setup is built with Inno Setup 6.7.3. https://jrsoftware.org/isinfo.php',
  existsSync(join(output, '..', 'server', 'media-tools', 'ffmpeg.exe'))
    ? 'FFmpeg and ffprobe are bundled under LGPL-2.1-or-later. See licenses/ffmpeg for notices and corresponding sources.'
    : 'FFmpeg and ffprobe are optional external tools. They are absent from this setup.',
  '',
];
copyFileSync(join(root, 'LICENSE'), join(output, 'MshTV-LICENSE.txt'));

function notices(source, group, label) {
  const files = readdirSync(source, { withFileTypes: true })
    .filter(file => file.isFile() && /^(licen[cs]e|copying|notice|third[-_ ]?party)/i.test(file.name));
  for (const file of files) {
    const name = join(output, group, label);
    mkdirSync(name, { recursive: true });
    copyFileSync(join(source, file.name), join(name, basename(file.name)));
  }
  return files.map(file => file.name).join(', ');
}

const runtimePacks = new Map();
for (const name of ['MshTV.Launcher', 'MshTV.Server']) {
  const assets = json(join(root, 'src', name, 'obj/project.assets.json'));
  const target = Object.entries(assets.targets).find(([framework]) => framework.endsWith('/win-x64'))?.[1];
  if (!target) throw new Error('Missing win-x64 target: ' + name);
  for (const [id, item] of Object.entries(target)) {
    if (item.type !== 'package' || runtimePacks.has(id)) continue;
    const path = Object.keys(assets.packageFolders).map(folder => join(folder, assets.libraries[id].path)).find(existsSync);
    if (!path) throw new Error('Missing package: ' + id);
    runtimePacks.set(id, path);
  }
  const depsPath = join(output, '..', name === 'MshTV.Launcher' ? 'MshTV.deps.json' : 'server/MshTV.Server.deps.json');
  const deps = json(depsPath);
  for (const key of Object.keys(deps.libraries).filter(id => /\.runtime\.win-x64\//i.test(id))) {
    const id = key.replace(/^runtimepack\./i, '');
    const path = Object.keys(assets.packageFolders).map(folder => join(folder, id.toLowerCase())).find(existsSync);
    if (!path) throw new Error('Missing self-contained runtime: ' + id);
    runtimePacks.set(id, path);
  }
}
inventory.push('Windows runtime and backend');
for (const [id, path] of [...runtimePacks].sort()) {
  const nuspec = readdirSync(path).find(file => file.endsWith('.nuspec'));
  const meta = nuspec ? readFileSync(join(path, nuspec), 'utf8') : '';
  const license = meta.match(/<license\b[^>]*>([^<]+)/)?.[1] ?? meta.match(/<licenseUrl>([^<]+)/)?.[1] ?? '';
  inventory.push(id + ' | ' + [license, notices(path, 'dotnet', id.replace('/', '_'))].filter(Boolean).join(' | '));
}
inventory.push('', 'WebUI dependencies');
const web = join(root, 'apps/web');
for (const [location, lock] of Object.entries(json(join(web, 'package-lock.json')).packages)) {
  if (!location || lock.dev) continue;
  const path = join(web, location);
  if (!existsSync(path)) continue;
  const name = location.split('node_modules/').at(-1);
  const files = notices(path, 'web', name.replace(/[\/]/g, '_') + '_' + lock.version);
  const license = json(join(path, 'package.json')).license;
  inventory.push(name + '/' + lock.version + ' | ' + [license, files].filter(Boolean).join(' | '));
}
writeFileSync(join(output, 'THIRD-PARTY.txt'), inventory.join('\n') + '\n');
