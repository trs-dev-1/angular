/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ApplicationRef} from './application/application_ref';
import {EnvironmentProviders, inject, makeEnvironmentProviders} from './di/index';
import {INTERNAL_APPLICATION_ERROR_HANDLER} from './error_handler';
import {CLASS_MERGE, ClassMergeFn, ClassMerger} from './render3/styling/class_merge';

export type {ClassMergeFn};

/**
 * Merges the classes an element receives from several sources with the given function before
 * Angular writes them to the DOM, for example to resolve conflicting utility classes.
 *
 * Angular passes the classes of an element from the lowest to the highest precedence:
 * 1. host classes of host directives, before the directive or component that declares them,
 * 2. host classes of the component,
 * 3. host classes of the other directives, in matching order,
 * 4. the classes of the element in the template,
 * 5. classes added with `Renderer2.addClass` (e.g. by `RouterLinkActive` or `NgClass`).
 *
 * Within each source, static classes come first, then the `[class]` binding, then the
 * `[class.name]` bindings in the order they are written. The result is written to the `class`
 * attribute at once.
 *
 * The function must be pure and deterministic. Angular caches the merged static classes of each
 * template location, and with hydration the server and the client must produce the same classes,
 * so provide the same function in both.
 *
 * The merge function applies to the components created in the environment that provides it,
 * typically the whole application when it is provided in the application config. It does not
 * apply to `[style]` bindings, nor to elements whose classes come only from their own `class`
 * attribute. Classes added outside of Angular (e.g. with `classList.add`) are kept as they are and
 * are not merged.
 *
 * @usageNotes
 *
 * ```ts
 * import {twMerge} from 'tailwind-merge';
 *
 * bootstrapApplication(App, {
 *   providers: [provideClassMerge((classes) => twMerge(classes))],
 * });
 * ```
 *
 * With a component that declares `host: {class: 'px-4 py-2'}`, `<my-button class="px-2" />`
 * renders `class="py-2 px-2"`.
 *
 * @see [Merging conflicting CSS classes](guide/templates/binding#merging-conflicting-css-classes)
 *
 * @experimental 22.4
 */
export function provideClassMerge(merge: ClassMergeFn): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: CLASS_MERGE,
      useFactory: () => {
        const appRef = inject(ApplicationRef);
        return new ClassMerger(merge, inject(INTERNAL_APPLICATION_ERROR_HANDLER), () =>
          appRef.whenStable(),
        );
      },
    },
  ]);
}
