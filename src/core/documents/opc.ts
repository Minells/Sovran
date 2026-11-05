/**
 * Open Packaging Conventions, the ZIP layout of Office Open XML files: relationships say where each part is, so the
 * converters follow them instead of assuming fixed paths (Strict OOXML and some generators use other names).
 */
import { parseXml } from './xml';
import type { ZipArchive } from './zip';

export interface Relationship {
  id: string;
  /** The relationship type's last segment: `officeDocument`, `styles`, `hyperlink`, `slide`, … */
  type: string;
  /** Resolved part name inside the archive, or the URL itself for an external target. */
  target: string;
  external: boolean;
}

/** `word/_rels/document.xml.rels` for `word/document.xml`; `_rels/.rels` for the package itself (''). */
export function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolves a relative part name against the folder of `base`, as OPC does (`../media/a.png`). */
export function resolvePart(base: string, target: string): string {
  const segments = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const s of target.replace(/^\/+/, '').split('/')) {
    if (s === '..') segments.pop();
    else if (s && s !== '.') segments.push(s);
  }
  return segments.join('/');
}

export function readRelationships(zip: ZipArchive, part: string): Relationship[] {
  const xml = zip.text(relsPath(part));
  if (!xml) return [];
  const out: Relationship[] = [];
  for (const ev of parseXml(xml)) {
    if (ev.type !== 'open' || !ev.name.endsWith('Relationship')) continue;
    const { Id: id, Type: type = '', Target: target = '', TargetMode: mode } = ev.attrs;
    if (!id) continue;
    const external = mode === 'External';
    out.push({
      id,
      type: type.slice(type.lastIndexOf('/') + 1),
      target: external ? target : resolvePart(part, target),
      external,
    });
  }
  return out;
}

/** The package's main part (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`), if it has one. */
export function mainPart(zip: ZipArchive): string | undefined {
  const main = readRelationships(zip, '').find((r) => r.type === 'officeDocument' && !r.external);
  return main ? (zip.find(main.target) ?? main.target) : undefined;
}
