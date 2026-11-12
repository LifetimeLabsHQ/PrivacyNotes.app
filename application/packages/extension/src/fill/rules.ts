/**
 * Which field of a page is the username, which the current password and
 * which the 2FA code. Rules and words only: `autocomplete` first, then what
 * the field is called, then where it stands. Pure over what `read.ts` read;
 * it touches nothing.
 * Spec: docs/internal/plans/click-to-fill.md (section 4)
 */
import { contextOf, type Field, type Group, type Page } from './read';
import { has, without, type Prepared, type WordList } from './text';
import type { FillStep } from './types';
import { VOCAB } from './vocab';
import { SEARCH_EXCEPT } from './words';

// Spec: docs/internal/plans/click-to-fill.md (section 4.3, step 6)
const MAX_PASSWORDS = 5;
// Spec: docs/internal/plans/click-to-fill.md (section 4.4)
const CODE_MIN_WIDTH = 60;
const BOX_MAX_WIDTH = 100;
const BOXES_MIN = 4;
const BOXES_MAX = 8;
// Spec: docs/internal/plans/click-to-fill.md (section 4.2, step 5)
const IDENTITY_MIN = 3;
const IDENTITY_MAX = 100;

type Role = 'password' | 'code' | 'codeWeak' | 'never' | 'user1' | 'user2' | 'notUser' | 'user3' | 'user4' | 'plain';
type PasswordRole = 'current' | 'new' | 'confirm';
const LEVELS = ['user1', 'user2', 'user3', 'user4'] as const;

export interface Plan {
  step: FillStep;
  sure: boolean;
  reason?: 'signup' | 'readonly';
  username?: Field;
  password?: Field;
  /** One field for the whole code, or one box for each digit. */
  code?: Field[];
  /** The accounts the page shows without a field to type one into. */
  identities: string[];
}

const words = (f: Field, list: WordList): boolean => has(f.dev, list) || has(f.human, list);
const live = (f: Field): boolean => f.usable && f.visible;
const isSearch = (text: Prepared): boolean => has(without(text, SEARCH_EXCEPT), VOCAB.search);

function hasCard(group: Group): boolean {
  return group.fields.some((f) => f.auto.some((t) => t.startsWith('cc-')) || words(f, VOCAB.card));
}

/** A field for the whole code is wide enough for it and takes its length. */
function fitsCode(f: Field): boolean {
  const max = f.el.maxLength;
  return f.box.width >= CODE_MIN_WIDTH && (max < 0 || (max >= 6 && max <= 10) || max >= 20);
}

function roleOf(f: Field, card: boolean): Role {
  const otp = f.auto.includes('one-time-code');
  const codeWord = words(f, VOCAB.code);
  const notCode = words(f, VOCAB.notCode);
  const never =
    f.auto.some((t) => t.startsWith('cc-')) ||
    !!f.el.closest('[role~="search"]') ||
    isSearch(f.dev) ||
    isSearch(f.human) ||
    isSearch(f.group.formText) ||
    words(f, VOCAB.card) ||
    words(f, VOCAB.neverOther);

  if (f.kind === 'password') {
    if (otp || (codeWord && !notCode && !card)) return 'code';
    return never || (codeWord && card) ? 'never' : 'password';
  }
  const codeType = f.type === 'text' || f.type === 'number' || f.type === 'tel';
  if (otp) return 'code';
  if (codeWord && !notCode && !card && codeType) return 'code';
  if (never || (codeWord && card)) return 'never';
  const user1 = words(f, VOCAB.username);
  const user2 = f.type === 'email' || f.el.inputMode === 'email' || f.el.getAttribute('inputmode') === 'email' || f.auto.includes('email') || words(f, VOCAB.email);
  const notUser = f.personAuto || words(f, VOCAB.notUsername);
  // A password field the person unmasked with the site's "show" button.
  if (f.auto.includes('current-password')) return 'password';
  if (!user1 && !user2 && !notUser && !f.auto.includes('username') && has(f.idName, VOCAB.password)) return 'password';
  if (user1) return 'user1';
  if (user2) return 'user2';
  if (notUser) return 'notUser';
  if (words(f, VOCAB.user)) return 'user3';
  if (has(f.dev, VOCAB.technical)) return 'user4';
  if (words(f, VOCAB.codeWeak) && !notCode && !card && codeType) return 'codeWeak';
  return 'plain';
}

/** One box for each digit: narrow fields in a row, each for one character. */
function boxesOf(group: Group): Field[] | null {
  let run: Field[] = [];
  const isBox = (f: Field): boolean =>
    live(f) &&
    f.box.width < BOX_MAX_WIDTH &&
    (f.el.maxLength === 1 || f.el.inputMode === 'numeric' || f.el.getAttribute('inputmode') === 'numeric' || /^(\[0-9\]|\\d)(\{1\}|\*)?$/.test(f.el.pattern ?? ''));
  for (const f of group.fields) {
    if (isBox(f)) run.push(f);
    else if (run.length >= BOXES_MIN) break;
    else run = [];
  }
  return run.length >= BOXES_MIN && run.length <= BOXES_MAX ? run : null;
}

interface Read {
  group: Group;
  roles: Map<Field, Role>;
  passwords: Map<Field, PasswordRole>;
  /** The first current password a person can type into. */
  current?: Field;
  signup: boolean;
  readonly: boolean;
  /** The boxes of a code, when the group is sure they are one. */
  boxes: Field[] | null;
}

function passwordRoles(fields: readonly Field[]): Map<Field, PasswordRole> {
  const out = new Map<Field, PasswordRole>();
  const many = fields.length >= 2;
  const lone = fields.length === 1;
  for (const f of fields) {
    const current = words(f, VOCAB.passwordCurrent);
    if (f.auto.includes('current-password')) out.set(f, 'current');
    else if (f.auto.includes('new-password')) out.set(f, lone && f.webauthn ? 'current' : 'new');
    else if (many && words(f, VOCAB.passwordConfirm)) out.set(f, 'confirm');
    else if (words(f, VOCAB.passwordNew) && !current) out.set(f, 'new');
    else if (current) out.set(f, 'current');
  }
  const byToken = fields.some((f) => f.auto.includes('current-password'));
  let first = !byToken;
  for (const f of fields) {
    if (out.has(f)) continue;
    out.set(f, first ? 'current' : 'new');
    first = false;
  }
  return out;
}

function readGroup(group: Group): Read {
  const card = hasCard(group);
  const roles = new Map<Field, Role>();
  for (const f of group.fields) roles.set(f, roleOf(f, card));

  const boxes = boxesOf(group);
  const boxSet = new Set(boxes ?? []);

  // A word in three or more fields is a shared prefix, not a name.
  for (const level of LEVELS) {
    const at = group.fields.filter((f) => live(f) && roles.get(f) === level);
    if (at.length >= 3) for (const f of at) roles.set(f, 'plain');
  }

  const all = group.fields.filter((f) => roles.get(f) === 'password' && !boxSet.has(f));
  const shown = all.filter(live);
  const passwords = shown.length <= MAX_PASSWORDS ? passwordRoles(shown) : new Map<Field, PasswordRole>();
  const first = shown[0];
  let signup = false;
  let current: Field | undefined;
  if (first && passwords.size) {
    const context = contextOf(first);
    const explicit = shown.some((f) => f.auto.includes('current-password') || words(f, VOCAB.passwordCurrent));
    const currents = shown.filter((f) => passwords.get(f) === 'current');
    const confirms = shown.filter((f) => passwords.get(f) === 'confirm').length;
    signup =
      !explicit &&
      ((confirms > 0 && shown.length - confirms === 1) || !currents.length || (has(context, VOCAB.signup) && !has(context, VOCAB.login)));
    current = signup ? undefined : currents[0];
  }

  let boxesSure = false;
  if (boxes?.[0]) {
    const context = contextOf(boxes[0]);
    const own = boxes.some((f) => words(f, VOCAB.code) || words(f, VOCAB.codeWeak));
    const cancelled = has(context, VOCAB.notCode) || boxes.some((f) => words(f, VOCAB.notCode)) || card;
    const onlyText = group.fields.filter((f) => live(f) && f.kind === 'text').every((f) => boxSet.has(f));
    boxesSure = !cancelled && !shown.length && (own || onlyText || has(context, VOCAB.code) || has(context, VOCAB.codeWeak));
  }

  return {
    group,
    roles,
    passwords,
    current,
    signup,
    readonly: !shown.length && all.some((f) => f.visible && !f.usable),
    boxes: boxesSure ? boxes : null,
  };
}

/** The text fields a username can be: not a code, not a search box, not a name. */
function usernameCandidates(read: Read, boxSet: ReadonlySet<Field>): Field[] {
  return read.group.fields.filter((f) => {
    const role = read.roles.get(f);
    return live(f) && f.kind === 'text' && !boxSet.has(f) && role !== 'password' && role !== 'code' && role !== 'never' && role !== 'notUser';
  });
}

function pickUsername(read: Read, password: Field, formless: readonly Read[]): Field | undefined {
  const boxSet = new Set(read.boxes ?? []);
  const inGroup = usernameCandidates(read, boxSet);
  const tokened = inGroup.filter((f) => f.auto.includes('username'));
  if (tokened.length === 1) return tokened[0];
  let before = inGroup.filter((f) => f.index < password.index);
  let roles = read.roles;
  if (!before.length && read.group.form) {
    // A field outside the form, before it: some sites keep the username there.
    for (const other of formless) {
      const more = usernameCandidates(other, new Set(other.boxes ?? [])).filter((f) => f.index < password.index);
      if (more.length) {
        before = more;
        roles = other.roles;
      }
    }
  }
  for (const level of LEVELS) {
    const at = before.filter((f) => roles.get(f) === level);
    const nearest = at[at.length - 1];
    if (nearest) return nearest;
  }
  return before[before.length - 1];
}

/** The account a page shows on its password step, in a locked or hidden field. */
function identitiesOf(read: Read): string[] {
  const out: string[] = [];
  const fits = (v: string): boolean => v.length >= IDENTITY_MIN && v.length <= IDENTITY_MAX;
  for (const f of read.group.fields) {
    const role = read.roles.get(f);
    const value = f.el.value.trim();
    if ((role === 'user1' || role === 'user2') && !live(f) && fits(value)) out.push(value);
  }
  for (const h of read.group.hidden) {
    if ((has(h.idName, VOCAB.username) || has(h.idName, VOCAB.email)) && fits(h.value)) out.push(h.value);
  }
  return out;
}

const firstIndex = (read: Read): number => read.group.fields[0]?.index ?? 0;

/** The focused group first, then the one that says "sign in", then the first. */
function best(reads: readonly Read[], active: Element | null): Read | undefined {
  const focused = reads.find((r) => r.group.fields.some((f) => f.el === active));
  if (focused) return focused;
  const named = reads.find((r) => {
    const anchor = r.current ?? r.group.fields.find(live);
    if (!anchor) return false;
    const context = contextOf(anchor);
    return has(context, VOCAB.login) && !has(context, VOCAB.signup);
  });
  return named ?? [...reads].sort((a, b) => firstIndex(a) - firstIndex(b))[0];
}

/** A group where an email or username alone would be a new account or a newsletter. */
function notSignIn(read: Read, anchor: Field): boolean {
  const context = contextOf(anchor);
  return read.signup || has(context, VOCAB.neverOther) || (has(context, VOCAB.signup) && !has(context, VOCAB.login));
}

export function analyze(page: Page, active: Element | null): Plan {
  const reads = page.groups.map(readGroup);
  const reason = reads.some((r) => r.signup) ? 'signup' : reads.some((r) => r.readonly) ? 'readonly' : undefined;

  // 1. A current password: the sign-in form.
  const login = best(reads.filter((r) => r.current), active);
  if (login?.current) {
    const password = login.current;
    const username = pickUsername(login, password, reads.filter((r) => !r.group.form && r !== login));
    const single = login.group.fields.find((f) => live(f) && login.roles.get(f) === 'code' && fitsCode(f));
    return {
      step: 'login',
      sure: true,
      username,
      password,
      code: single ? [single] : (login.boxes ?? undefined),
      identities: username ? [] : identitiesOf(login),
    };
  }

  const none: Plan = { step: 'none', sure: false, reason, identities: [] };

  // 2. A code field that says so.
  const codeIn = (role: Role) =>
    reads.flatMap((r) => r.group.fields.filter((f) => live(f) && r.roles.get(f) === role && fitsCode(f) && !new Set(r.boxes ?? []).has(f)));
  const sureCode = codeIn('code');
  const focusedCode = sureCode.find((f) => f.el === active) ?? sureCode[0];
  if (focusedCode) return { step: 'code', sure: true, code: [focusedCode], identities: [] };
  const boxes = best(reads.filter((r) => r.boxes), active)?.boxes;
  if (boxes) return { step: 'code', sure: true, code: boxes, identities: [] };

  // 3. A username field that says so.
  const sureUser: { read: Read; field: Field }[] = [];
  for (const read of reads) {
    const candidates = usernameCandidates(read, new Set(read.boxes ?? []));
    const tokened = candidates.filter((f) => f.auto.includes('username'));
    const field =
      (tokened.length === 1 ? tokened[0] : undefined) ??
      candidates.find((f) => read.roles.get(f) === 'user1') ??
      candidates.find((f) => read.roles.get(f) === 'user2');
    if (field && !notSignIn(read, field)) sureUser.push({ read, field });
  }
  const user = best(sureUser.map((u) => u.read), active);
  const userField = sureUser.find((u) => u.read === user)?.field;
  if (userField) return { step: 'username', sure: true, username: userField, identities: [] };

  // 4. A weak word for a code, then for a username.
  const weakCode = codeIn('codeWeak');
  const focusedWeak = weakCode.find((f) => f.el === active) ?? weakCode[0];
  if (focusedWeak) return { step: 'code', sure: false, code: [focusedWeak], identities: [] };

  for (const read of reads) {
    const candidates = usernameCandidates(read, new Set(read.boxes ?? [])).filter((f) => read.roles.get(f) !== 'codeWeak');
    const anchor = candidates[0];
    if (!anchor || notSignIn(read, anchor) || !has(contextOf(anchor), VOCAB.login)) continue;
    const named = candidates.find((f) => read.roles.get(f) === 'user3') ?? candidates.find((f) => read.roles.get(f) === 'user4');
    const field = named ?? (candidates.length === 1 ? anchor : undefined);
    if (field) return { step: 'username', sure: false, username: field, identities: [] };
  }
  return none;
}
