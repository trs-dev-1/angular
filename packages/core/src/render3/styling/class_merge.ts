/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type {ClassMergeFn} from '../../class_merge';
import {Renderer2} from '../../render/api';
import type {RendererStyleFlags2} from '../../render/api_flags';
import {INTERNAL_APPLICATION_ERROR_HANDLER} from '../../error_handler';
import {AttributeMarker} from '../interfaces/attribute_marker';
import {DirectiveDef} from '../interfaces/definition';
import {TAttributes, TNode} from '../interfaces/node';
import {Renderer} from '../interfaces/renderer';
import {RElement} from '../interfaces/renderer_dom';
import {
  getTStylingRangeNext,
  getTStylingRangePrev,
  TStylingKey,
  TStylingRange,
} from '../interfaces/styling';
import {INJECTOR, LView, RENDERER, TData, TVIEW, TView} from '../interfaces/view';
import {getLContext} from '../context_discovery';
import {NO_CHANGE} from '../tokens';

/**
 * The class sources of an element from the lowest to the highest precedence: static classes (as
 * written) and class binding indexes. Angular's own styling structures sort classes alphabetically
 * (`KeyValueArray`) and group statics of several sources together, which loses the order a "last
 * one wins" merger depends on, so the sources are listed from the directive definitions instead.
 */
type ClassPlan = (string[] | number)[];

/**
 * Writes the classes of elements merged with an application's merge function.
 *
 * Created by `provideClassMerge` only, so applications that do not merge classes do not include this
 * code: the rest of the runtime only checks `LViewEnvironment.classMerge`.
 */
export interface ClassMergeStrategy {
  /** Writes the static classes of a new or hydrated element, see `writeStaticClasses`. */
  writeStaticClasses(lView: LView, tNode: TNode, renderer: Renderer, element: RElement): void;
  /**
   * The `Renderer2` injected by directives: `addClass` / `removeClass` on elements with merged classes
   * add a class source with the highest precedence (e.g. `RouterLinkActive`, `NgClass`).
   */
  wrapRenderer(renderer: Renderer2): Renderer2;
  /** Writes all classes of an element after a class binding changed, see `writeMergedClasses`. */
  writeMergedClasses(
    tView: TView,
    tNode: TNode,
    lView: LView,
    renderer: Renderer,
    rNode: RElement,
  ): void;
}

/** Caches of one strategy. A `TView` is shared across applications, so they are not global. */
interface ClassMergeState {
  merge: ClassMergeFn;
  /** Plans per `TNode`. Only cached once the first update pass completed and all bindings are linked. */
  classPlans: WeakMap<TNode, ClassPlan>;
  /** Merged static classes per `TNode`. */
  staticClasses: WeakMap<TNode, string>;
  /** The class state of each element whose classes Angular merged. */
  elements: WeakMap<RElement, ElementClasses>;
  renderers: WeakMap<Renderer2, Renderer2>;
}

/** What Angular knows about the classes of one element. */
interface ElementClasses {
  lView: LView;
  tNode: TNode;
  /**
   * The merged classes Angular last wrote. Any other class on the element was added outside of
   * Angular's class bindings (animations, `classList.add`, ...) and is kept as it is.
   */
  owned: string;
  /** The `class` attribute as Angular last wrote it: `owned` plus the classes it kept. */
  written: string;
  /**
   * Classes that were on the element before Angular merged them (server rendered classes of a
   * hydrated element), sorted out on the next write: the ones Angular knows (static classes,
   * `[class.name]` keys) are Angular's, the others were added outside of its class bindings (e.g.
   * `RouterLinkActive` on the server) and are kept.
   */
  pending: string[] | null;
  /** Classes added with an injected `Renderer2`, in the order they were added. */
  rendererClasses: string[] | null;
}

export function createClassMergeStrategy(merge: ClassMergeFn): ClassMergeStrategy {
  const state: ClassMergeState = {
    merge,
    classPlans: new WeakMap(),
    staticClasses: new WeakMap(),
    elements: new WeakMap(),
    renderers: new WeakMap(),
  };
  return {
    writeStaticClasses: (lView, tNode, renderer, element) =>
      writeStaticClasses(state, lView, tNode, renderer, element),
    wrapRenderer: (renderer) => {
      let wrapped = state.renderers.get(renderer);
      if (wrapped === undefined) {
        state.renderers.set(renderer, (wrapped = new ClassMergeRenderer(renderer, state)));
      }
      return wrapped;
    },
    writeMergedClasses: (tView, tNode, lView, renderer, rNode) =>
      writeMergedClasses(state, tView, tNode, lView, renderer, rNode),
  };
}

/**
 * Merges the static classes of an element.
 *
 * Only elements with host classes are merged: classes that come from the `class` attribute alone are
 * written as they are. The result is cached on the `TNode`, so it is computed once per template
 * location rather than once per element.
 */
function mergeStaticClasses(
  state: ClassMergeState,
  lView: LView,
  tNode: TNode,
  classes: string,
): string {
  if (classes === tNode.classesWithoutHost) {
    return classes;
  }
  let merged = state.staticClasses.get(tNode);
  if (merged === undefined) {
    const tData = lView[TVIEW].data;
    const sources: string[] = [];
    for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
      collectStaticClasses(sources, (tData[i] as DirectiveDef<unknown>).hostAttrs);
    }
    collectStaticClasses(sources, tNode.attrs);
    const result = callClassMerge(state.merge, sources, lView);
    if (result === null) {
      return sources.join(' ');
    }
    state.staticClasses.set(tNode, (merged = result));
  }
  return merged;
}

/**
 * Writes the merged static classes of an element and records them as Angular's.
 *
 * A new element has no classes yet. A hydrated one carries the server rendered classes: the ones
 * that are not static stay on the element until the first class binding write sorts them out (see
 * `ElementClasses.pending`), so classes added outside of Angular do not flicker. Elements without
 * static classes are left alone, as without a merge function.
 */
function writeStaticClasses(
  state: ClassMergeState,
  lView: LView,
  tNode: TNode,
  renderer: Renderer,
  element: RElement,
): void {
  if (tNode.classes === null) {
    return;
  }
  const owned = mergeStaticClasses(state, lView, tNode, tNode.classes);
  let written = owned;
  let pending: string[] | null = null;
  const current = readClasses(element);
  if (current) {
    const ownedSet = new Set(splitClasses(owned));
    pending = splitClasses(current).filter((className) => !ownedSet.has(className));
    if (pending.length > 0) {
      written = [owned, ...pending].join(' ').trim();
    } else {
      pending = null;
    }
  }
  state.elements.set(element, {lView, tNode, owned, written, pending, rendererClasses: null});
  if (written === '') {
    renderer.removeAttribute(element, 'class');
  } else {
    renderer.setAttribute(element, 'class', written);
  }
}

/** The class state of an element, created on the first merge for an element without static classes. */
function getElementClasses(
  state: ClassMergeState,
  lView: LView,
  tNode: TNode,
  element: RElement,
): ElementClasses {
  let classes = state.elements.get(element);
  if (classes === undefined) {
    const current = splitClasses(readClasses(element));
    classes = {
      lView,
      tNode,
      owned: '',
      written: current.join(' '),
      pending: current.length > 0 ? current : null,
      rendererClasses: null,
    };
    state.elements.set(element, classes);
  }
  return classes;
}

/**
 * Recomputes all classes of an element in precedence order and writes the merged result.
 *
 * A class set by a higher priority source moves to that position, a falsy value removes it and
 * `undefined` leaves it to lower priorities (the same rules as unmerged class bindings).
 */
function writeMergedClasses(
  state: ClassMergeState,
  tView: TView,
  tNode: TNode,
  lView: LView,
  renderer: Renderer,
  rNode: RElement,
): void {
  const element = getElementClasses(state, lView, tNode, rNode);
  let plan = state.classPlans.get(tNode);
  if (plan === undefined) {
    plan = createClassPlan(tView, tNode);
    if (!tView.firstUpdatePass) {
      state.classPlans.set(tNode, plan);
    }
  }

  const tData = tView.data;
  const classes = new Map<string, true>();
  for (const entry of plan) {
    if (typeof entry !== 'number') {
      for (const className of entry) {
        setClass(classes, className, true);
      }
      continue;
    }
    const rawKey = tData[entry] as TStylingKey;
    const key = Array.isArray(rawKey) ? rawKey[1] : rawKey;
    if (key === false) {
      // Shadowed by a directive `@Input('class')`.
      continue;
    }
    if (key === null) {
      // `[class]`: read the value as bound (`lView[index]`), not the sorted `KeyValueArray`.
      const value = lView[entry];
      if (value !== NO_CHANGE) {
        setClassMapValue(classes, value);
      }
    } else {
      const value = lView[entry + 1];
      if (value !== NO_CHANGE) {
        setClass(classes, key as string, value);
      }
    }
  }

  // Classes added with an injected `Renderer2` rank above every binding.
  if (element.rendererClasses !== null) {
    for (const className of element.rendererClasses) {
      setClass(classes, className, true);
    }
  }

  const list = Array.from(classes.keys());
  const merged = callClassMerge(state.merge, list, lView) ?? list.join(' ');

  const current = readClasses(rNode) ?? '';
  let value = merged;
  // Fast path: nothing but Angular has written classes since the last write. Otherwise keep the
  // classes added outside of Angular's class bindings.
  if (
    element.pending !== null ||
    element.written !== element.owned ||
    current !== element.written
  ) {
    const owned = new Set(splitClasses(element.owned));
    if (element.pending !== null) {
      const known = knownClasses(plan, tData);
      for (const className of element.pending) {
        if (known.has(className)) {
          owned.add(className);
        }
      }
      element.pending = null;
    }
    const mergedSet = new Set(splitClasses(merged));
    const kept = splitClasses(current).filter(
      (className) => !owned.has(className) && !mergedSet.has(className),
    );
    if (kept.length > 0) {
      value = [merged, ...kept].join(' ').trim();
    }
  }
  element.owned = merged;
  element.written = value;

  if (value === current) {
    return;
  }
  if (value === '') {
    renderer.removeAttribute(rNode, 'class');
  } else {
    renderer.setAttribute(rNode, 'class', value);
  }
}

/**
 * Delegates to the injected renderer, except that `addClass` / `removeClass` on an element whose
 * classes are merged add or remove a class source and rewrite the element's classes.
 */
class ClassMergeRenderer extends Renderer2 {
  constructor(
    private readonly delegate: Renderer2,
    private readonly state: ClassMergeState,
  ) {
    super();
    const destroyNode = delegate.destroyNode;
    this.destroyNode = destroyNode ? (node) => destroyNode.call(delegate, node) : null;
  }

  override get data() {
    return this.delegate.data;
  }

  override addClass(el: any, name: string): void {
    const element = findElementClasses(this.state, el);
    // A static class of the element is already applied with its own precedence (`NgClass` re-adds
    // the `class` attribute it receives as an input).
    if (element === null || isStaticClass(this.state, element, name)) {
      if (element === null) {
        this.delegate.addClass(el, name);
      }
      return;
    }
    const list = element.rendererClasses ?? [];
    if (!list.includes(name)) {
      element.rendererClasses = [...list, name];
      rewriteClasses(this.state, el, element);
    }
  }

  override removeClass(el: any, name: string): void {
    const element = this.state.elements.get(el);
    const list = element?.rendererClasses;
    if (!list || !list.includes(name)) {
      this.delegate.removeClass(el, name);
      return;
    }
    element!.rendererClasses = list.filter((className) => className !== name);
    rewriteClasses(this.state, el, element!);
  }

  override destroy(): void {
    this.delegate.destroy();
  }
  override createElement(name: string, namespace?: string | null) {
    return this.delegate.createElement(name, namespace);
  }
  override createComment(value: string) {
    return this.delegate.createComment(value);
  }
  override createText(value: string) {
    return this.delegate.createText(value);
  }
  override appendChild(parent: any, newChild: any): void {
    this.delegate.appendChild(parent, newChild);
  }
  override insertBefore(parent: any, newChild: any, refChild: any, isMove?: boolean): void {
    this.delegate.insertBefore(parent, newChild, refChild, isMove);
  }
  override removeChild(
    parent: any,
    oldChild: any,
    isHostElement?: boolean,
    requireSynchronousElementRemoval?: boolean,
  ): void {
    this.delegate.removeChild(parent, oldChild, isHostElement, requireSynchronousElementRemoval);
  }
  override selectRootElement(selectorOrNode: any, preserveContent?: boolean) {
    return this.delegate.selectRootElement(selectorOrNode, preserveContent);
  }
  override parentNode(node: any) {
    return this.delegate.parentNode(node);
  }
  override nextSibling(node: any) {
    return this.delegate.nextSibling(node);
  }
  override setAttribute(el: any, name: string, value: string, namespace?: string | null): void {
    this.delegate.setAttribute(el, name, value, namespace);
  }
  override removeAttribute(el: any, name: string, namespace?: string | null): void {
    this.delegate.removeAttribute(el, name, namespace);
  }
  override setStyle(el: any, style: string, value: any, flags?: RendererStyleFlags2): void {
    this.delegate.setStyle(el, style, value, flags);
  }
  override removeStyle(el: any, style: string, flags?: RendererStyleFlags2): void {
    this.delegate.removeStyle(el, style, flags);
  }
  override setProperty(el: any, name: string, value: any): void {
    this.delegate.setProperty(el, name, value);
  }
  override setValue(node: any, value: string): void {
    this.delegate.setValue(node, value);
  }
  override listen(
    target: any,
    eventName: string,
    callback: (event: any) => boolean | void,
    options?: any,
  ) {
    return this.delegate.listen(target, eventName, callback, options);
  }
}

/** The class state of an element created by Angular, or `null` for other elements. */
function findElementClasses(state: ClassMergeState, el: RElement): ElementClasses | null {
  const known = state.elements.get(el);
  if (known !== undefined) {
    return known;
  }
  const context = getLContext(el);
  if (context === null || context.lView === null) {
    return null;
  }
  const lView = context.lView;
  const tNode = lView[TVIEW].data[context.nodeIndex] as TNode | null;
  return tNode ? getElementClasses(state, lView, tNode, el) : null;
}

function isStaticClass(
  state: ClassMergeState,
  element: ElementClasses,
  className: string,
): boolean {
  const tView = element.lView[TVIEW];
  const plan = state.classPlans.get(element.tNode) ?? createClassPlan(tView, element.tNode);
  return plan.some((entry) => typeof entry !== 'number' && entry.includes(className));
}

function rewriteClasses(state: ClassMergeState, el: RElement, element: ElementClasses): void {
  const lView = element.lView;
  writeMergedClasses(state, lView[TVIEW], element.tNode, lView, lView[RENDERER], el);
}

/** The classes an element's sources can set whatever their values: statics and `[class.name]` keys. */
function knownClasses(plan: ClassPlan, tData: TData): Set<string> {
  const known = new Set<string>();
  for (const entry of plan) {
    if (typeof entry !== 'number') {
      entry.forEach((className) => known.add(className));
    } else {
      const rawKey = tData[entry] as TStylingKey;
      const key = Array.isArray(rawKey) ? rawKey[1] : rawKey;
      if (typeof key === 'string') {
        known.add(key);
      }
    }
  }
  return known;
}

/**
 * Calls the merge function. An error goes to the application's error handler and `null` is returned
 * so the caller writes the classes unmerged rather than leaving the element without classes.
 */
function callClassMerge(classMerge: ClassMergeFn, classes: string[], lView: LView): string | null {
  try {
    return classMerge(classes);
  } catch (error) {
    let errorHandler: ((error: unknown) => void) | null = null;
    try {
      errorHandler = lView[INJECTOR]?.get(INTERNAL_APPLICATION_ERROR_HANDLER, null) ?? null;
    } catch {}
    if (errorHandler === null) {
      throw error;
    }
    errorHandler(error);
    return null;
  }
}

/**
 * Lists the class sources of an element: for each directive (component first) its static host
 * classes then its host class bindings, then the template's static classes and class bindings.
 */
function createClassPlan(tView: TView, tNode: TNode): ClassPlan {
  const tData = tView.data;

  // The class bindings in priority order (see `style_binding_list.ts`). With template bindings the
  // range `next` is the template tail, otherwise `prev` is the last host binding: the list's tail.
  const bindings: number[] = [];
  let index =
    getTStylingRangeNext(tNode.classBindings) || getTStylingRangePrev(tNode.classBindings);
  while (index !== 0) {
    bindings.unshift(index);
    index = getTStylingRangePrev(tData[index + 1] as TStylingRange);
  }

  // Where the host binding slots of each directive on this element start.
  const hostBindingRoots = new Map<number, number>();
  const opCodes = tView.hostBindingOpCodes;
  if (opCodes !== null) {
    let isCurrentElement = false;
    for (let i = 0; i < opCodes.length; i++) {
      const opCode = opCodes[i] as number;
      if (opCode < 0) {
        isCurrentElement = ~opCode === tNode.index;
      } else {
        const bindingRoot = opCodes[++i] as number;
        i++; // the host bindings function
        if (isCurrentElement) {
          hostBindingRoots.set(opCode, bindingRoot);
        }
      }
    }
  }

  const plan: ClassPlan = [];
  for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
    const def = tData[i] as DirectiveDef<unknown>;
    const statics: string[] = [];
    collectStaticClasses(statics, def.hostAttrs);
    if (statics.length > 0) {
      plan.push(statics);
    }
    const bindingRoot = hostBindingRoots.get(i);
    if (bindingRoot !== undefined) {
      for (const binding of bindings) {
        if (binding >= bindingRoot && binding < bindingRoot + def.hostVars) {
          plan.push(binding);
        }
      }
    }
  }
  const templateStatics: string[] = [];
  collectStaticClasses(templateStatics, tNode.attrs);
  if (templateStatics.length > 0) {
    plan.push(templateStatics);
  }
  for (const binding of bindings) {
    if (binding < tView.expandoStartIndex) {
      plan.push(binding);
    }
  }
  return plan;
}

function collectStaticClasses(classes: string[], attrs: TAttributes | null): void {
  if (attrs === null) {
    return;
  }
  let marker = AttributeMarker.ImplicitAttributes;
  for (let i = 0; i < attrs.length; i++) {
    const item = attrs[i];
    if (typeof item === 'number') {
      marker = item;
    } else if (marker === AttributeMarker.Classes) {
      classes.push(item as string);
    }
  }
}

/**
 * Applies a `[class]` value with the same rules as `toStylingKeyValueArray`: a string is split on
 * whitespace, array and `Set` items and object keys are stringified (see `classKeyValueArraySet`).
 */
function setClassMapValue(classes: Map<string, true>, value: unknown): void {
  if (typeof value === 'string') {
    for (const className of splitClasses(value)) {
      setClass(classes, className, true);
    }
  } else if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) {
      setClassKey(classes, item, true);
    }
  } else if (value != null && typeof value === 'object') {
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        setClassKey(classes, key, (value as Record<string, unknown>)[key]);
      }
    }
  }
}

/** Empty keys and keys with spaces are ignored, like `classKeyValueArraySet`. */
function setClassKey(classes: Map<string, true>, key: unknown, value: unknown): void {
  const className = String(key);
  if (className !== '' && !className.includes(' ')) {
    setClass(classes, className, value);
  }
}

function setClass(classes: Map<string, true>, className: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  classes.delete(className);
  if (value) {
    classes.set(className, true);
  }
}

/**
 * The `class` attribute of an element, or `undefined` when the renderer's elements cannot be read
 * (a custom renderer): classes added outside of Angular are then not preserved.
 */
function readClasses(element: RElement): string | null | undefined {
  return typeof element.getAttribute === 'function' ? element.getAttribute('class') : undefined;
}

function splitClasses(value: string | null | undefined): string[] {
  return value ? value.split(/\s+/).filter((className) => className !== '') : [];
}
