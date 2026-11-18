/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentProviders, InjectionToken, makeEnvironmentProviders} from './di/index';
import {ClassMergeStrategy, createClassMergeStrategy} from './render3/styling/class_merge';

/**
 * Merges the classes of an element into the class list that is written to the DOM.
 *
 * The classes are ordered from the lowest to the highest styling precedence, so a merger where the
 * last conflicting class wins (e.g. `tailwind-merge`) applies the documented precedence to classes
 * that conflict without sharing a name.
 *
 * @publicApi
 */
export type ClassMergeFn = (classes: string[]) => string;

/**
 * How element classes are merged, or `null` when they are not.
 */
export const CLASS_MERGE = new InjectionToken<ClassMergeStrategy | null>(
  typeof ngDevMode === 'undefined' || ngDevMode ? 'CLASS_MERGE' : '',
  {
    factory: () => null,
  },
);

/**
 * Merges the classes of elements that receive classes from more than one source (component and
 * directive host classes, the `class` attribute, `[class]` and `[class.name]` bindings) with the
 * given function before they are written to the DOM.
 *
 * Elements whose classes come only from their own `class` attribute are left untouched.
 *
 * @publicApi
 */
export function provideClassMerge(merge: ClassMergeFn): EnvironmentProviders {
  return makeEnvironmentProviders([
    {provide: CLASS_MERGE, useFactory: () => createClassMergeStrategy(merge)},
  ]);
}
