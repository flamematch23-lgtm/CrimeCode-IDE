import { DIFFS_TAG_NAME } from "@pierre/diffs"

/**
 * TypeScript declaration for the <diffs-container> custom element.
 * This tells TypeScript that <diffs-container> is a valid JSX element in SolidJS.
 * Required for using the @pierre/diffs web component in .tsx files.
 *
 * NOTE: This file was originally a Unix symlink to ../../ui/src/custom-elements.d.ts
 * but was committed as plain text (mode 100644) on a machine with
 * core.symlinks=false, breaking typecheck on Windows. Keep the content in sync
 * with packages/ui/src/custom-elements.d.ts until a proper symlink or
 * cross-package import replaces it.
 */

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      [DIFFS_TAG_NAME]: HTMLAttributes<HTMLElement>
    }
  }
}

export {}
