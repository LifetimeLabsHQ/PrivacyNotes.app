/**
 * The grammars beyond lowlight's `common` set, in a chunk of their own: the
 * editor sits on the boot path, and these are a few kB gz each, so they load
 * after boot (`loadExtraGrammars` in codeGrammars.ts). codeLanguages.ts lists
 * the same fences in the menu.
 * Spec: docs/internal/design-decisions.md (code blocks name their language)
 */
import apache from 'highlight.js/lib/languages/apache';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import matlab from 'highlight.js/lib/languages/matlab';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';

export const EXTRA_GRAMMARS = {
  apache, clojure, cmake, dart, dockerfile, dos, elixir, groovy, haskell,
  julia, latex, matlab, nginx, powershell, properties, protobuf, scala,
};
