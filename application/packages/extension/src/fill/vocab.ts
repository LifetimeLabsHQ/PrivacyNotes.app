/**
 * The word lists, compiled once when the script loads: our own words, the
 * wider set, and the Chromium block for the three roles it has.
 * Spec: docs/internal/plans/click-to-fill-words.md (sections 2 and 3c)
 */
import { compile } from './text';
import {
  CARD,
  CODE,
  CODE_WEAK,
  EMAIL,
  LOGIN_CONTEXT,
  NEVER_OTHER,
  NOT_CODE,
  NOT_USERNAME,
  PASSWORD,
  PASSWORD_CONFIRM,
  PASSWORD_CURRENT,
  PASSWORD_NEW,
  SEARCH,
  SIGNUP_CONTEXT,
  TECHNICAL,
  USER,
  USERNAME,
  WIDER,
} from './words';
import { CHROMIUM_PASSWORD, CHROMIUM_USER, CHROMIUM_USERNAME } from './wordsChromium';

export const VOCAB = {
  password: compile(PASSWORD, WIDER.PASSWORD, CHROMIUM_PASSWORD),
  passwordNew: compile(PASSWORD_NEW, WIDER.PASSWORD_NEW),
  passwordConfirm: compile(PASSWORD_CONFIRM, WIDER.PASSWORD_CONFIRM),
  passwordCurrent: compile(PASSWORD_CURRENT),
  username: compile(USERNAME, WIDER.USERNAME, CHROMIUM_USERNAME),
  email: compile(EMAIL, WIDER.EMAIL),
  user: compile(USER, CHROMIUM_USER),
  technical: compile(TECHNICAL),
  notUsername: compile(NOT_USERNAME),
  code: compile(CODE, WIDER.CODE),
  codeWeak: compile(CODE_WEAK),
  notCode: compile(NOT_CODE),
  search: compile(SEARCH, WIDER.SEARCH),
  card: compile(CARD),
  neverOther: compile(NEVER_OTHER),
  login: compile(LOGIN_CONTEXT, WIDER.LOGIN_CONTEXT),
  signup: compile(SIGNUP_CONTEXT, WIDER.SIGNUP_CONTEXT),
};
