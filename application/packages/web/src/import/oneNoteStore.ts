/**
 * Reads a OneNote revision store file: a section (`.one`) or a notebook's
 * table of contents (`.onetoc2`), the files inside a `.onepkg`.
 *
 * Format facts are from [MS-ONESTORE] (OneNote Revision Store File Format),
 * the section number of each structure is named where it is read. A file is
 * a tree of file node lists. The root list names the object spaces; each
 * object space has revisions; a revision declares objects (directly, or in
 * object groups) and names its root objects by role. An object is a JCID (its
 * type) and a property set, or a file data object (an embedded file or a
 * picture). References between objects are CompactIDs, which a global
 * identification table turns into ExtendedGUIDs.
 *
 * What this file returns is that graph, resolved: for each object space the
 * current revision (default context, revision role 1), its root objects by
 * role, and every object it holds by ExtendedGUID, with object references
 * already turned into ExtendedGUIDs. What the objects MEAN is [MS-ONE], read
 * in `oneNoteModel.ts`.
 *
 * Not read: the FSSHTTPB packaging ([MS-ONESTORE] 2.8), which is how a
 * section is stored on a server, refused with a typed error; and encrypted
 * object spaces (a password-protected section), which come back with
 * `encrypted: true` and no objects. CRCs and reference counts are not checked:
 * a reader that only reads does not need them, and a damaged structure still
 * fails its bounds checks.
 */

import { OneNoteError } from './oneNoteCab';

export interface ExGuid {
  guid: string;
  n: number;
}

/** `guid:n`, the map key of an ExtendedGUID. */
export function exKey(id: ExGuid): string {
  return `${id.guid}:${id.n}`;
}

const NIL_GUID = '00000000-0000-0000-0000-000000000000';

const GUID_FILE_TYPE_ONE = '7b5c52e4-d88c-4da7-aeb1-5378d02996d3';
const GUID_FILE_TYPE_ONETOC2 = '43ff2fa1-efd9-4c76-9ee2-10ea5722765f';
const GUID_FILE_FORMAT = '109add3f-911b-49f5-a5d0-1791edc8aed8';
const GUID_FILE_FORMAT_FSSHTTPB = '638de92f-a6d4-4bc1-9a36-b3fc2511a5b7';
const GUID_FDSO_HEADER = 'bde316e7-2665-4511-a4c4-8d4d0b7a9eac';

/** One property value, by PropertyID.type ([MS-ONESTORE] 2.6.6). */
export type PropValue =
  | { kind: 'none' }
  | { kind: 'bool'; v: boolean }
  | { kind: 'uint'; v: number; size: 1 | 2 | 4 }
  | { kind: 'u64'; lo: number; hi: number }
  | { kind: 'bytes'; v: Uint8Array }
  | { kind: 'oid'; v: ExGuid | null }
  | { kind: 'oids'; v: (ExGuid | null)[] }
  | { kind: 'osid'; v: ExGuid | null }
  | { kind: 'osids'; v: (ExGuid | null)[] }
  | { kind: 'ctx'; v: ExGuid | null }
  | { kind: 'ctxs'; v: (ExGuid | null)[] }
  | { kind: 'sets'; v: PropSet[] }
  | { kind: 'set'; v: PropSet };

/** A property set, keyed by PropertyID.id (the low 26 bits). */
export type PropSet = Map<number, PropValue>;

export interface OneObject {
  id: ExGuid;
  jcid: number;
  /** The property set, or null for a file data object. */
  props: PropSet | null;
  /** For a file data object: the reference string ("<ifndf>{guid}", "<file>name") and the extension. */
  file?: { ref: string; ext: string };
}

export interface ObjectSpace {
  id: ExGuid;
  encrypted: boolean;
  /** Root object ExtendedGUID key by root role ([MS-ONE] 2.1.8: 1 content, 2 metadata, 4 version metadata). */
  roots: Map<number, string>;
  objects: Map<string, OneObject>;
}

export interface RevisionStore {
  fileType: 'one' | 'onetoc2';
  guidFile: string;
  rootSpace: string;
  spaces: Map<string, ObjectSpace>;
  /** FileDataStoreObject bytes by lowercase GUID without braces. */
  fileData: Map<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

function corrupt(detail: string): OneNoteError {
  return new OneNoteError('store-corrupt', detail);
}

function hex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

/** A GUID in [MS-DTYP] layout (Data1..3 little-endian), lowercase, no braces. */
export function readGuid(b: Uint8Array, at: number): string {
  if (at < 0 || at + 16 > b.length) throw corrupt('guid past end');
  const d1 = hex(b[at + 3]!) + hex(b[at + 2]!) + hex(b[at + 1]!) + hex(b[at]!);
  const d2 = hex(b[at + 5]!) + hex(b[at + 4]!);
  const d3 = hex(b[at + 7]!) + hex(b[at + 6]!);
  let d4 = '';
  for (let i = 8; i < 10; i++) d4 += hex(b[at + i]!);
  let d5 = '';
  for (let i = 10; i < 16; i++) d5 += hex(b[at + i]!);
  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}

class Reader {
  readonly start: number;

  constructor(
    readonly b: Uint8Array,
    public pos: number,
    readonly end: number = b.length,
  ) {
    if (pos < 0 || end > b.length || pos > end) throw corrupt('range');
    this.start = pos;
  }

  need(n: number): void {
    if (n < 0 || this.pos < this.start || this.pos + n > this.end) throw corrupt('read past end');
  }

  left(): number {
    return this.end - this.pos;
  }

  u8(): number {
    this.need(1);
    return this.b[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.b[this.pos]! | (this.b[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const b = this.b;
    const p = this.pos;
    this.pos += 4;
    return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
  }

  /** An unsigned 64-bit integer; refused past 2^53, which no real offset reaches. */
  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    if (hi >= 0x200000) throw corrupt('u64 too large');
    return hi * 0x100000000 + lo;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  guid(): string {
    this.need(16);
    const g = readGuid(this.b, this.pos);
    this.pos += 16;
    return g;
  }

  exGuid(): ExGuid {
    const guid = this.guid();
    const n = this.u32();
    return { guid, n };
  }

  /** StringInStorageBuffer ([MS-ONESTORE] 2.2.3): a count of UTF-16 units, then the units. */
  storageString(): string {
    const cch = this.u32();
    if (cch > 0x100000) throw corrupt('string too long');
    const raw = this.bytes(cch * 2);
    return new TextDecoder('utf-16le').decode(raw);
  }
}

interface ChunkRef {
  stp: number;
  cb: number;
  nil: boolean;
}

function isNilGuid(id: ExGuid): boolean {
  return id.guid === NIL_GUID && id.n === 0;
}

// ---------------------------------------------------------------------------
// File nodes ([MS-ONESTORE] 2.4)
// ---------------------------------------------------------------------------

interface FileNode {
  id: number;
  ref: ChunkRef | null;
  /** The fnd bytes after the chunk reference. */
  r: Reader;
}

const FRAGMENT_MAGIC_LO = 0xf5f7f4c4;
const FRAGMENT_MAGIC_HI = 0xa4567ab1;
const FRAGMENT_FOOTER_LO = 0x8233ba4b;
const FRAGMENT_FOOTER_HI = 0x8bc215c3;

/** Per-store bounds far above a real file (`tests/oneNoteStore.test.ts`). */
const FRAGMENT_LIMIT = 1_000_000;
const NODE_LIMIT = 20_000_000;
const GID_LIMIT = 1_000_000;
const PROP_LIMIT = 1_000_000;

class Store {
  readonly b: Uint8Array;
  /** Committed FileNode count by FileNodeListID, from the transaction log. */
  private readonly committed = new Map<number, number>();
  private readonly propSets = new WeakMap<GidTable, Map<string, PropSet>>();
  private fragmentsRead = 0;
  private nodesRead = 0;
  private gidOps = 0;
  private propsRead = 0;

  constructor(bytes: Uint8Array) {
    this.b = bytes;
  }

  chargeGid(n: number): void {
    this.gidOps += n;
    if (this.gidOps > GID_LIMIT) throw corrupt('too many global ids');
  }

  chargeProps(n: number): void {
    this.propsRead += n;
    if (this.propsRead > PROP_LIMIT) throw corrupt('too many properties');
  }

  readPropSet(ref: ChunkRef, table: GidTable): PropSet {
    const key = `${ref.stp}:${ref.cb}`;
    let byChunk = this.propSets.get(table);
    const hit = byChunk?.get(key);
    if (hit) return hit;
    const parsed = readPropSetObject(this, ref, table);
    if (!byChunk) {
      byChunk = new Map();
      this.propSets.set(table, byChunk);
    }
    byChunk.set(key, parsed);
    return parsed;
  }

  /** FileChunkReference64x32 read raw, so fcrNil (all stp bits set) is recognized before the 2^53 check. */
  fcr64x32Raw(r: Reader): ChunkRef {
    const lo = r.u32();
    const hi = r.u32();
    const cb = r.u32();
    const nil = (lo === 0xffffffff && hi === 0xffffffff && cb === 0) || (lo === 0 && hi === 0 && cb === 0);
    if (nil) return { stp: 0, cb: 0, nil: true };
    if (hi >= 0x200000) throw corrupt('offset too large');
    return { stp: hi * 0x100000000 + lo, cb, nil: false };
  }

  readTransactionLog(first: ChunkRef, transactions: number): void {
    let ref = first;
    let done = 0;
    const seen = new Set<number>();
    while (done < transactions) {
      if (ref.nil || seen.has(ref.stp)) throw corrupt('transaction log ends early');
      if (ref.cb < 12) throw corrupt('transaction log too small');
      seen.add(ref.stp);
      if (seen.size > FRAGMENT_LIMIT) throw corrupt('transaction log too long');
      const r = new Reader(this.b, ref.stp, ref.stp + ref.cb);
      const entries = Math.floor((ref.cb - 12) / 8);
      for (let i = 0; i < entries && done < transactions; i++) {
        const src = r.u32();
        const sw = r.u32();
        if (src === 1) done++;
        else this.committed.set(src, sw);
      }
      if (done >= transactions) break;
      r.pos = ref.stp + ref.cb - 12;
      ref = this.fcr64x32Raw(r);
    }
  }

  private chunkRef(r: Reader, stpFormat: number, cbFormat: number): ChunkRef {
    let stp: number;
    let nil: boolean;
    switch (stpFormat) {
      case 0: {
        const lo = r.u32();
        const hi = r.u32();
        nil = lo === 0xffffffff && hi === 0xffffffff;
        if (!nil && hi >= 0x200000) throw corrupt('offset too large');
        stp = nil ? 0 : hi * 0x100000000 + lo;
        break;
      }
      case 1:
        stp = r.u32();
        nil = stp === 0xffffffff;
        break;
      case 2:
        stp = r.u16();
        nil = stp === 0xffff;
        stp *= 8;
        break;
      default:
        stp = r.u32();
        nil = stp === 0xffffffff;
        stp *= 8;
    }
    let cb: number;
    switch (cbFormat) {
      case 0:
        cb = r.u32();
        break;
      case 1: {
        const lo = r.u32();
        const hi = r.u32();
        if (hi >= 0x200000) throw corrupt('size too large');
        cb = hi * 0x100000000 + lo;
        break;
      }
      case 2:
        cb = r.u8() * 8;
        break;
      default:
        cb = r.u16() * 8;
    }
    if (nil) cb = 0;
    if (!nil && (stp + cb > this.b.length || stp < 0)) throw corrupt('chunk past end');
    return { stp, cb, nil };
  }

  /** Every committed FileNode of the list whose first fragment `first` references. */
  readList(first: ChunkRef): FileNode[] {
    const nodes: FileNode[] = [];
    if (first.nil) return nodes;
    let ref = first;
    let listId = -1;
    let limit = Infinity;
    const seen = new Set<number>();
    for (;;) {
      if (seen.has(ref.stp) || seen.size > FRAGMENT_LIMIT || ++this.fragmentsRead > FRAGMENT_LIMIT) {
        throw corrupt('fragment loop');
      }
      seen.add(ref.stp);
      if (ref.cb < 16 + 20) throw corrupt('fragment too small');
      const r = new Reader(this.b, ref.stp, ref.stp + ref.cb);
      if (r.u32() !== FRAGMENT_MAGIC_LO || r.u32() !== FRAGMENT_MAGIC_HI) throw corrupt('fragment magic');
      const id = r.u32();
      r.u32(); // nFragmentSequence
      if (listId === -1) {
        listId = id;
        limit = this.committed.get(id) ?? Infinity;
      } else if (id !== listId) {
        throw corrupt('fragment of another list');
      }
      const nodesEnd = ref.stp + ref.cb - 20;
      while (nodes.length < limit && nodesEnd - r.pos >= 4) {
        const h = r.u32();
        const nodeId = h & 0x3ff;
        const size = (h >>> 10) & 0x1fff;
        const stpFormat = (h >>> 23) & 3;
        const cbFormat = (h >>> 25) & 3;
        const baseType = (h >>> 27) & 0xf;
        if (nodeId === 0xff) break;
        if (nodeId === 0 && size === 0) break; // padding
        if (size < 4 || r.pos - 4 + size > nodesEnd) throw corrupt('file node size');
        const nr = new Reader(this.b, r.pos, r.pos - 4 + size);
        const nodeRef = baseType === 1 || baseType === 2 ? this.chunkRef(nr, stpFormat, cbFormat) : null;
        nodes.push({ id: nodeId, ref: nodeRef, r: nr });
        if (++this.nodesRead > NODE_LIMIT) throw corrupt('too many file nodes');
        r.pos += size - 4;
      }
      if (nodes.length >= limit) break;
      const tail = new Reader(this.b, ref.stp + ref.cb - 20, ref.stp + ref.cb);
      const next = this.fcr64x32Raw(tail);
      if (tail.u32() !== FRAGMENT_FOOTER_LO || tail.u32() !== FRAGMENT_FOOTER_HI) throw corrupt('fragment footer');
      if (next.nil) break;
      if (next.stp + next.cb > this.b.length) throw corrupt('next fragment past end');
      ref = next;
    }
    return nodes;
  }
}

// ---------------------------------------------------------------------------
// Global identification tables, revisions, objects
// ---------------------------------------------------------------------------

type GidTable = Map<number, string>;

interface Declaration {
  id: ExGuid;
  jcid: number | null;
  blob: ChunkRef | null;
  table: GidTable;
  file?: { ref: string; ext: string };
}

interface Revision {
  rid: string;
  dependent: string | null;
  encrypted: boolean;
  table: GidTable;
  decls: Map<string, Declaration>;
  roots: Map<number, string>;
  /** CompactID roots of a `.onetoc2` revision, resolved once its table is known. */
  compactRoots: { cid: number; role: number }[];
}

function resolveCompact(cid: number, table: GidTable): ExGuid | null {
  const n = cid & 0xff;
  const index = cid >>> 8;
  const guid = table.get(index);
  if (guid === undefined) return null;
  return { guid, n };
}

const ROLE_DEFAULT = 1;
const DEFAULT_CONTEXT = `${NIL_GUID}:0`;
const EMPTY_GID_TABLE: GidTable = new Map();

/** JCID bits ([MS-ONESTORE] 2.6.14). */
const JCID_IS_PROPERTY_SET = 0x20000;
const JCID_IS_FILE_DATA = 0x80000;

function readSpace(store: Store, gosid: ExGuid, listRef: ChunkRef): ObjectSpace {
  const manifest = store.readList(listRef);
  let revListRef: ChunkRef | null = null;
  for (const node of manifest) if (node.id === 0x010 && node.ref) revListRef = node.ref;
  const space: ObjectSpace = { id: gosid, encrypted: false, roots: new Map(), objects: new Map() };
  if (!revListRef) return space;

  const revisions = new Map<string, Revision>();
  const labels = new Map<string, string>();
  const nodes = store.readList(revListRef);
  let current: Revision | null = null;
  let table: GidTable = EMPTY_GID_TABLE;
  let pendingTable: GidTable | null = null;

  const declare = (decl: Declaration): void => {
    if (current) current.decls.set(exKey(decl.id), decl);
  };

  for (const node of nodes) {
    const r = node.r;
    switch (node.id) {
      case 0x01b: // RevisionManifestStart4FND
      case 0x01e: // RevisionManifestStart6FND
      case 0x01f: {
        // RevisionManifestStart7FND
        const rid = r.exGuid();
        const dep = r.exGuid();
        if (node.id === 0x01b) r.bytes(8); // timeCreation
        const role = r.u32();
        const odcs = r.u16();
        const ctx = node.id === 0x01f ? exKey(r.exGuid()) : DEFAULT_CONTEXT;
        const depKey = isNilGuid(dep) ? null : exKey(dep);
        const parent = depKey ? revisions.get(depKey) : undefined;
        current = {
          rid: exKey(rid),
          dependent: depKey,
          encrypted: odcs !== 0 || (parent?.encrypted ?? false),
          table: parent?.table ?? EMPTY_GID_TABLE,
          decls: new Map(),
          roots: new Map(),
          compactRoots: [],
        };
        table = current.table;
        pendingTable = null;
        revisions.set(current.rid, current);
        labels.set(`${ctx}|${role}`, current.rid);
        break;
      }
      case 0x07c: // ObjectDataEncryptionKeyV2FNDX
        if (current) current.encrypted = true;
        break;
      case 0x021: // GlobalIdTableStartFNDX
      case 0x022: // GlobalIdTableStart2FND
        pendingTable = new Map();
        break;
      case 0x024: {
        const index = r.u32();
        const guid = r.guid();
        if (pendingTable) {
          store.chargeGid(1);
          pendingTable.set(index, guid);
        }
        break;
      }
      case 0x025: {
        // GlobalIdTableEntry2FNDX: copy one entry of the dependency revision's table
        const from = r.u32();
        const to = r.u32();
        const dep = current?.dependent ? revisions.get(current.dependent) : undefined;
        const g = dep?.table.get(from);
        if (g !== undefined && pendingTable) {
          store.chargeGid(1);
          pendingTable.set(to, g);
        }
        break;
      }
      case 0x026: {
        const from = r.u32();
        const count = r.u32();
        const to = r.u32();
        if (count > 0xffffff) throw corrupt('table range');
        const dep = current?.dependent ? revisions.get(current.dependent) : undefined;
        if (dep && pendingTable && count > 0) {
          if (dep.table.size < count) {
            store.chargeGid(dep.table.size);
            const end = from + count;
            for (const [idx, g] of dep.table) {
              if (idx >= from && idx < end) pendingTable.set(to + (idx - from), g);
            }
          } else {
            store.chargeGid(count);
            for (let k = 0; k < count; k++) {
              const g = dep.table.get(from + k);
              if (g !== undefined) pendingTable.set(to + k, g);
            }
          }
        }
        break;
      }
      case 0x028: // GlobalIdTableEndFNDX
        if (pendingTable && current) {
          current.table = pendingTable;
          table = pendingTable;
        }
        pendingTable = null;
        break;
      case 0x05a: {
        // RootObjectReference3FND
        const id = r.exGuid();
        const role = r.u32();
        current?.roots.set(role, exKey(id));
        break;
      }
      case 0x059: {
        // RootObjectReference2FNDX
        const cid = r.u32();
        const role = r.u32();
        current?.compactRoots.push({ cid, role });
        break;
      }
      case 0x05c: // RevisionRoleDeclarationFND
      case 0x05d: {
        // RevisionRoleAndContextDeclarationFND
        const rid = exKey(r.exGuid());
        const role = r.u32();
        const ctx = node.id === 0x05d ? exKey(r.exGuid()) : DEFAULT_CONTEXT;
        labels.set(`${ctx}|${role}`, rid);
        break;
      }
      case 0x0b0: // ObjectGroupListReferenceFND
        if (node.ref && current) readObjectGroup(store, node.ref, declare);
        break;
      case 0x02d: // ObjectDeclarationWithRefCountFNDX
      case 0x02e: {
        const cid = r.u32();
        const jci = r.u16() & 0x3ff;
        const id = resolveCompact(cid, table);
        if (id) declare({ id, jcid: JCID_IS_PROPERTY_SET | jci, blob: node.ref, table });
        break;
      }
      case 0x041: // ObjectRevisionWithRefCountFNDX
      case 0x042: {
        const cid = r.u32();
        const id = resolveCompact(cid, table);
        if (id) declare({ id, jcid: null, blob: node.ref, table });
        break;
      }
      case 0x01c: // RevisionManifestEndFND
        if (current) {
          for (const { cid, role } of current.compactRoots) {
            const id = resolveCompact(cid, current.table);
            if (id) current.roots.set(role, exKey(id));
          }
        }
        current = null;
        pendingTable = null;
        break;
      default:
        break;
    }
  }

  const chosenKey = labels.get(`${DEFAULT_CONTEXT}|${ROLE_DEFAULT}`);
  const chosen = chosenKey ? revisions.get(chosenKey) : undefined;
  if (!chosen) return space;

  // The revision and the chain it depends on, oldest first.
  const chain: Revision[] = [];
  const seen = new Set<string>();
  for (let rev: Revision | undefined = chosen; rev && !seen.has(rev.rid); rev = rev.dependent ? revisions.get(rev.dependent) : undefined) {
    seen.add(rev.rid);
    chain.unshift(rev);
  }
  if (chain.some((rev) => rev.encrypted)) {
    space.encrypted = true;
    return space;
  }
  const decls = new Map<string, Declaration>();
  for (const rev of chain) {
    for (const [role, key] of rev.roots) space.roots.set(role, key);
    for (const [key, decl] of rev.decls) {
      const before = decls.get(key);
      decls.set(key, decl.jcid === null && before ? { ...decl, jcid: before.jcid } : decl);
    }
  }
  for (const [key, decl] of decls) {
    if (decl.jcid === null) continue;
    if (decl.file) {
      space.objects.set(key, { id: decl.id, jcid: decl.jcid, props: null, file: decl.file });
    } else if (decl.blob && !decl.blob.nil && decl.jcid & JCID_IS_PROPERTY_SET) {
      space.objects.set(key, { id: decl.id, jcid: decl.jcid, props: store.readPropSet(decl.blob, decl.table) });
    } else {
      space.objects.set(key, { id: decl.id, jcid: decl.jcid, props: new Map() });
    }
  }
  return space;
}

function readObjectGroup(store: Store, ref: ChunkRef, declare: (d: Declaration) => void): void {
  const nodes = store.readList(ref);
  let table: GidTable = EMPTY_GID_TABLE;
  let pending: GidTable | null = null;
  for (const node of nodes) {
    const r = node.r;
    switch (node.id) {
      case 0x022:
      case 0x021:
        pending = new Map();
        break;
      case 0x024: {
        const index = r.u32();
        const guid = r.guid();
        if (pending) {
          store.chargeGid(1);
          pending.set(index, guid);
        }
        break;
      }
      case 0x028:
        if (pending) table = pending;
        pending = null;
        break;
      case 0x0a4: // ObjectDeclaration2RefCountFND
      case 0x0a5: // ObjectDeclaration2LargeRefCountFND
      case 0x0c4: // ReadOnlyObjectDeclaration2RefCountFND
      case 0x0c5: {
        // ReadOnlyObjectDeclaration2LargeRefCountFND
        const cid = r.u32();
        const jcid = r.u32();
        const id = resolveCompact(cid, table);
        if (id) declare({ id, jcid, blob: node.ref, table });
        break;
      }
      case 0x072: // ObjectDeclarationFileData3RefCountFND
      case 0x073: {
        // ObjectDeclarationFileData3LargeRefCountFND
        const cid = r.u32();
        const jcid = r.u32();
        if (node.id === 0x072) r.u8();
        else r.u32();
        const fileRef = r.storageString();
        const ext = r.storageString();
        const id = resolveCompact(cid, table);
        if (id && jcid & JCID_IS_FILE_DATA) declare({ id, jcid, blob: null, table, file: { ref: fileRef, ext } });
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Property sets ([MS-ONESTORE] 2.6.1, 2.6.6, 2.6.7)
// ---------------------------------------------------------------------------

const PROP_SET_DEPTH_LIMIT = 32;

interface Streams {
  store: Store;
  oids: number[];
  osids: number[];
  ctxs: number[];
  oi: number;
  si: number;
  ci: number;
  table: GidTable;
}

function readIdStream(r: Reader, store: Store): { ids: number[]; extended: boolean; osidAbsent: boolean } {
  const h = r.u32();
  const count = h & 0xffffff;
  const extended = ((h >>> 30) & 1) === 1;
  const osidAbsent = ((h >>> 31) & 1) === 1;
  if (count * 4 > r.left()) throw corrupt('id stream past end');
  store.chargeProps(count);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(r.u32());
  return { ids, extended, osidAbsent };
}

function readPropSetObject(store: Store, ref: ChunkRef, table: GidTable): PropSet {
  const r = new Reader(store.b, ref.stp, ref.stp + ref.cb);
  const oids = readIdStream(r, store);
  let osids: number[] = [];
  let ctxs: number[] = [];
  if (!oids.osidAbsent) {
    const s = readIdStream(r, store);
    osids = s.ids;
    if (s.extended) ctxs = readIdStream(r, store).ids;
  }
  const streams: Streams = { store, oids: oids.ids, osids, ctxs, oi: 0, si: 0, ci: 0, table };
  return readPropSet(r, streams, 0);
}

function takeIds(list: number[], at: number, count: number, table: GidTable): (ExGuid | null)[] {
  if (at + count > list.length) throw corrupt('id stream short');
  const out: (ExGuid | null)[] = [];
  for (let i = 0; i < count; i++) out.push(resolveCompact(list[at + i]!, table));
  return out;
}

function readPropSet(r: Reader, s: Streams, depth: number): PropSet {
  if (depth > PROP_SET_DEPTH_LIMIT) throw corrupt('property sets nested too deep');
  const count = r.u16();
  if (count * 4 > r.left()) throw corrupt('property set past end');
  s.store.chargeProps(1 + count);
  const prids: number[] = [];
  for (let i = 0; i < count; i++) prids.push(r.u32());
  const set: PropSet = new Map();
  for (const prid of prids) {
    const id = prid & 0x3ffffff;
    const type = (prid >>> 26) & 0x1f;
    const boolValue = (prid >>> 31) === 1;
    set.set(id, readValue(r, s, type, boolValue, depth));
  }
  return set;
}

function readValue(r: Reader, s: Streams, type: number, boolValue: boolean, depth: number): PropValue {
  switch (type) {
    case 0x1:
      return { kind: 'none' };
    case 0x2:
      return { kind: 'bool', v: boolValue };
    case 0x3:
      return { kind: 'uint', v: r.u8(), size: 1 };
    case 0x4:
      return { kind: 'uint', v: r.u16(), size: 2 };
    case 0x5:
      return { kind: 'uint', v: r.u32(), size: 4 };
    case 0x6: {
      const lo = r.u32();
      const hi = r.u32();
      return { kind: 'u64', lo, hi };
    }
    case 0x7: {
      const cb = r.u32();
      if (cb >= 0x40000000) throw corrupt('property too long');
      return { kind: 'bytes', v: r.bytes(cb) };
    }
    case 0x8: {
      const v = takeIds(s.oids, s.oi, 1, s.table)[0] ?? null;
      s.oi += 1;
      return { kind: 'oid', v };
    }
    case 0x9: {
      const n = r.u32();
      const v = takeIds(s.oids, s.oi, n, s.table);
      s.oi += n;
      return { kind: 'oids', v };
    }
    case 0xa: {
      const v = takeIds(s.osids, s.si, 1, s.table)[0] ?? null;
      s.si += 1;
      return { kind: 'osid', v };
    }
    case 0xb: {
      const n = r.u32();
      const v = takeIds(s.osids, s.si, n, s.table);
      s.si += n;
      return { kind: 'osids', v };
    }
    case 0xc: {
      const v = takeIds(s.ctxs, s.ci, 1, s.table)[0] ?? null;
      s.ci += 1;
      return { kind: 'ctx', v };
    }
    case 0xd: {
      const n = r.u32();
      const v = takeIds(s.ctxs, s.ci, n, s.table);
      s.ci += n;
      return { kind: 'ctxs', v };
    }
    case 0x10: {
      const n = r.u32();
      if (n === 0) return { kind: 'sets', v: [] };
      const prid = r.u32();
      if (((prid >>> 26) & 0x1f) !== 0x11) throw corrupt('array of non-sets');
      if (n > r.left()) throw corrupt('array too long');
      const v: PropSet[] = [];
      for (let i = 0; i < n; i++) v.push(readPropSet(r, s, depth + 1));
      return { kind: 'sets', v };
    }
    case 0x11:
      return { kind: 'set', v: readPropSet(r, s, depth + 1) };
    default:
      throw corrupt(`property type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Reads one `.one` or `.onetoc2` file. Throws `OneNoteError` on a file it cannot read. */
export function readRevisionStore(bytes: Uint8Array): RevisionStore {
  if (bytes.length < 1024) throw new OneNoteError('store-not-revision-store');
  const fileType = readGuid(bytes, 0);
  const format = readGuid(bytes, 48);
  if (format === GUID_FILE_FORMAT_FSSHTTPB) throw new OneNoteError('store-fsshttpb');
  if (format !== GUID_FILE_FORMAT || (fileType !== GUID_FILE_TYPE_ONE && fileType !== GUID_FILE_TYPE_ONETOC2)) {
    throw new OneNoteError('store-not-revision-store');
  }
  const store = new Store(bytes);
  const h = new Reader(bytes, 0, 1024);
  h.pos = 96;
  const transactions = h.u32();
  h.pos = 160;
  const logRef = store.fcr64x32Raw(h);
  const rootRef = store.fcr64x32Raw(h);
  if (rootRef.nil) throw corrupt('no root list');
  if (rootRef.stp + rootRef.cb > bytes.length) throw corrupt('root list past end');
  if (!logRef.nil && transactions > 0) store.readTransactionLog(logRef, transactions);

  const root = store.readList(rootRef);
  let rootSpace = '';
  const spaceRefs: { gosid: ExGuid; ref: ChunkRef }[] = [];
  const fileData = new Map<string, Uint8Array>();
  for (const node of root) {
    if (node.id === 0x004) rootSpace = exKey(node.r.exGuid());
    else if (node.id === 0x008 && node.ref) spaceRefs.push({ gosid: node.r.exGuid(), ref: node.ref });
    else if (node.id === 0x090 && node.ref) {
      for (const fd of store.readList(node.ref)) {
        if (fd.id !== 0x094 || !fd.ref || fd.ref.nil) continue;
        const guid = fd.r.guid();
        const data = readFileDataStoreObject(bytes, fd.ref);
        if (data) fileData.set(guid, data);
      }
    }
  }
  const spaces = new Map<string, ObjectSpace>();
  for (const { gosid, ref } of spaceRefs) {
    const key = exKey(gosid);
    if (!spaces.has(key)) spaces.set(key, readSpace(store, gosid, ref));
  }
  return {
    fileType: fileType === GUID_FILE_TYPE_ONE ? 'one' : 'onetoc2',
    guidFile: readGuid(bytes, 16),
    rootSpace,
    spaces,
    fileData,
  };
}

/** FileDataStoreObject ([MS-ONESTORE] 2.6.13): the file bytes, or null on a damaged one. */
function readFileDataStoreObject(b: Uint8Array, ref: ChunkRef): Uint8Array | null {
  const r = new Reader(b, ref.stp, ref.stp + ref.cb);
  if (r.left() < 16 + 8 + 4 + 8 + 16) return null;
  if (r.guid() !== GUID_FDSO_HEADER) return null;
  const length = r.u64();
  r.pos += 12;
  if (length > r.left()) return null;
  return r.bytes(length);
}

/** The GUID inside a file data reference "<ifndf>{guid}", lowercase without braces, else null. */
export function fileDataGuid(ref: string): string | null {
  const m = /^<ifndf>\{([0-9a-fA-F-]{36})\}$/.exec(ref);
  return m?.[1] ? m[1].toLowerCase() : null;
}
