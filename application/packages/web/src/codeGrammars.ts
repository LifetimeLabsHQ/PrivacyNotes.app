/**
 * The one lowlight setup both instances use: the editor's (editorCodeBlock.ts)
 * and the rendered view's (markdownHighlight.ts). `common` is registered at
 * once; the popular grammars it leaves out (codeGrammarsExtra.ts) come in a
 * later chunk, because the editor sits on the boot path.
 * Spec: docs/internal/design-decisions.md (code blocks name their language)
 */
import { createLowlight, common } from 'lowlight';

type CodeLowlight = ReturnType<typeof createLowlight>;

/** A lowlight instance with `common`. */
export function createCodeLowlight(): CodeLowlight {
  const lowlight = createLowlight(common);
  // The menu names ```htm as HTML and ```objective-c as Objective-C, and
  // `common` has neither alias.
  lowlight.registerAlias({ xml: ['htm'], objectivec: ['objective-c'] });
  return lowlight;
}

const loading = new WeakMap<CodeLowlight, Promise<void>>();

/** Registers the extra grammars on `lowlight`, once; later calls share it. */
export function loadExtraGrammars(lowlight: CodeLowlight): Promise<void> {
  let p = loading.get(lowlight);
  if (!p) {
    p = import('./codeGrammarsExtra').then(({ EXTRA_GRAMMARS }) => { lowlight.register(EXTRA_GRAMMARS); });
    loading.set(lowlight, p);
  }
  return p;
}
