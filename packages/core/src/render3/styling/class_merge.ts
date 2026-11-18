/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {InjectionToken} from '../../di/injection_token';
import {RuntimeError, RuntimeErrorCode} from '../../errors';
import type {ListenerOptions, Renderer2} from '../../render/api';
import type {RendererStyleFlags2} from '../../render/api_flags';
import {unwrapSafeValue} from '../../sanitization/bypass';
import {getLContext, readPatchedData} from '../context_discovery';
import {AttributeMarker} from '../interfaces/attribute_marker';
import {DirectiveDef} from '../interfaces/definition';
import {TAttributes, TNode} from '../interfaces/node';
import {RElement} from '../interfaces/renderer_dom';
import {
  getTStylingRangeNext,
  getTStylingRangePrev,
  TStylingKey,
  TStylingRange,
} from '../interfaces/styling';
import {isDestroyed} from '../interfaces/type_checks';
import {ENVIRONMENT, LView, RENDERER, TData, TVIEW, TView} from '../interfaces/view';
import {NO_CHANGE} from '../tokens';

/**
 * Merges the classes of an element into the class list that is written to the DOM.
 *
 * The classes are ordered from the lowest to the highest styling precedence, so a merger where the
 * last conflicting class wins (e.g. `tailwind-merge`) applies Angular's precedence to classes that
 * conflict without sharing a name.
 *
 * The function must be pure and deterministic: results are cached per template location, and the
 * server and the client must produce the same classes for hydration.
 *
 * @see {@link provideClassMerge}
 *
 * @experimental 22.4
 */
export type ClassMergeFn = (classes: string[]) => string;

/** Merges element classes; only provided by `provideClassMerge`. */
export const CLASS_MERGE = new InjectionToken<ClassMerger>(
  typeof ngDevMode === 'undefined' || ngDevMode ? 'CLASS_MERGE' : '',
);

/**
 * The class sources of an element from the lowest to the highest precedence: static classes (as
 * written) and class binding indexes. Angular's own styling structures sort classes alphabetically
 * (`KeyValueArray`) and group statics of several sources together, which loses the order a "last
 * one wins" merger depends on, so the sources are listed from the directive definitions instead.
 */
type ClassPlan = (string[] | number)[];

/** What Angular knows about the classes of one element. */
interface ElementClasses {
  /**
   * The merged classes Angular last wrote. Any other class on the element was added outside of
   * Angular's class bindings (animations, `classList.add`, ...) and is kept as it is.
   */
  owned: string;
  /** The `class` attribute as Angular last wrote it: `owned` plus the classes it kept. */
  written: string;
  /**
   * Classes that were on the element before Angular merged them (server rendered classes of a
   * hydrated element), sorted out on the next write: see `takeOverPendingClasses`.
   */
  pending: string[] | null;
  /**
   * Server rendered classes of an element with a `[class]` binding that the client did not produce
   * (yet): kept until the application is stable, so that a class a directive adds again (e.g.
   * `RouterLinkActive` after the initial navigation) does not flicker, then removed if unclaimed.
   */
  unsettled: string[] | null;
  /**
   * Classes added (`true`) or static classes removed (`false`) with an injected `Renderer2`, in
   * the order of the calls. They rank above every class binding.
   */
  rendererClasses: Map<string, boolean> | null;
}

/**
 * Writes the classes of elements merged with an application's merge function.
 *
 * Created by `provideClassMerge` only, so applications that do not merge classes do not include this
 * code: the rest of the runtime only checks `LViewEnvironment.classMerger`. All caches are per
 * instance because a `TView` is shared across applications that may merge differently.
 */
export class ClassMerger {
  private readonly plans = new WeakMap<TNode, ClassPlan>();
  private readonly staticClasses = new WeakMap<TNode, string>();
  /** For each `TView`, where the host binding slots of each directive start. */
  private readonly hostBindingRoots = new WeakMap<TView, Map<number, number>>();
  private readonly elements = new WeakMap<RElement, ElementClasses>();
  private readonly renderers = new WeakMap<Renderer2, Renderer2>();
  /** Hydrated elements with unsettled classes, until the application is stable. */
  private unsettledElements: {element: RElement; lView: LView; tNode: TNode}[] | null = null;

  constructor(
    private readonly merge: ClassMergeFn,
    private readonly handleError: (error: unknown) => void,
    private readonly whenStable: () => Promise<unknown>,
  ) {}

  /**
   * Writes the merged static classes of a new or hydrated element.
   *
   * A hydrated element (or a root component's host) already carries classes: the ones that are not
   * static stay on the element until the first class binding write sorts them out (see
   * `ElementClasses.pending`), so classes added outside of Angular do not flicker. Elements without
   * static classes are left alone, as without a merge function.
   */
  writeStaticClasses(lView: LView, tNode: TNode, element: RElement, isNewElement: boolean): void {
    if (tNode.classes === null) {
      return;
    }
    const owned = this.mergeStaticClasses(lView[TVIEW], tNode);
    const renderer = lView[RENDERER];
    if (isNewElement) {
      // The record is created on the first class write, which finds exactly these classes.
      if (owned !== '') {
        renderer.setAttribute(element, 'class', owned);
      }
      return;
    }
    const current = readClasses(element);
    let written = owned;
    let pending: string[] | null = null;
    if (current !== '') {
      const ownedSet = new Set(splitClasses(owned));
      pending = splitClasses(current).filter((className) => !ownedSet.has(className));
      if (pending.length > 0) {
        written = [owned, ...pending].join(' ').trim();
      } else {
        pending = null;
      }
    }
    this.elements.set(element, {owned, written, pending, unsettled: null, rendererClasses: null});
    if (written === current) {
      return;
    }
    if (written === '') {
      renderer.removeAttribute(element, 'class');
    } else {
      renderer.setAttribute(element, 'class', written);
    }
  }

  /**
   * Recomputes all classes of an element in precedence order and writes the merged result.
   *
   * A class set by a higher priority source moves to that position, a falsy value removes it and
   * `undefined` leaves it to lower priorities (the same rules as unmerged class bindings).
   */
  writeClasses(tView: TView, tNode: TNode, lView: LView, element: RElement): void {
    const record = this.getElementClasses(element);
    const plan = this.getPlan(tView, tNode);
    const classes = collectClasses(plan, tView.data, lView, record.rendererClasses);
    const merged = this.callMerge(classes) ?? classes.join(' ');
    const current = readClasses(element);

    let value = merged;
    // Fast path: only Angular wrote classes since the last write. Otherwise keep the classes added
    // outside of Angular's class bindings.
    if (record.pending !== null || record.written !== record.owned || current !== record.written) {
      const owned = new Set(splitClasses(record.owned));
      if (record.pending !== null) {
        const unsettled = takeOverPendingClasses(record.pending, owned, plan, tView.data);
        record.pending = null;
        if (unsettled !== null) {
          this.settleWhenStable(record, unsettled, element, lView, tNode);
        }
      }
      const mergedSet = new Set(splitClasses(merged));
      const kept = splitClasses(current).filter(
        (className) => !owned.has(className) && !mergedSet.has(className),
      );
      if (kept.length > 0) {
        value = [merged, ...kept].join(' ').trim();
      }
    }
    record.owned = merged;
    record.written = value;

    if (value === current) {
      return;
    }
    const renderer = lView[RENDERER];
    if (value === '') {
      renderer.removeAttribute(element, 'class');
    } else {
      renderer.setAttribute(element, 'class', value);
    }
  }

  /** Keeps the unsettled classes of a hydrated element until the application is stable. */
  private settleWhenStable(
    record: ElementClasses,
    unsettled: string[],
    element: RElement,
    lView: LView,
    tNode: TNode,
  ): void {
    record.unsettled = unsettled;
    if (this.unsettledElements === null) {
      this.unsettledElements = [];
      this.whenStable().then(() => this.settle());
    }
    this.unsettledElements.push({element, lView, tNode});
  }

  /** Removes the unsettled classes that are still not produced by any class source. */
  private settle(): void {
    const unsettledElements = this.unsettledElements!;
    this.unsettledElements = null;
    for (const {element, lView, tNode} of unsettledElements) {
      const record = this.elements.get(element);
      if (record?.unsettled == null || isDestroyed(lView)) {
        continue;
      }
      // Counted as Angular's, the classes that the merge no longer produces are removed.
      record.owned = [record.owned, ...record.unsettled].join(' ');
      record.unsettled = null;
      this.writeClasses(lView[TVIEW], tNode, lView, element);
    }
  }

  /**
   * The `Renderer2` injected by directives: `addClass` / `removeClass` on elements with merged classes
   * add a class source with the highest precedence (e.g. `RouterLinkActive`, `NgClass`).
   */
  wrapRenderer(renderer: Renderer2): Renderer2 {
    let wrapped = this.renderers.get(renderer);
    if (wrapped === undefined) {
      this.renderers.set(renderer, (wrapped = new ClassMergeRenderer(renderer, this)));
    }
    return wrapped;
  }

  /**
   * Applies `Renderer2.addClass` (`added`) or `removeClass` to an element whose classes this merger
   * writes. Returns `false` for other elements, which are left to the renderer.
   */
  setRendererClass(element: RElement, className: string, added: boolean): boolean {
    const context = this.findContext(element);
    if (context === null) {
      return false;
    }
    const {lView, tNode} = context;
    const record = this.getElementClasses(element);
    const rendererClasses = (record.rendererClasses ??= new Map());
    const current = rendererClasses.get(className);
    if (added) {
      if (current === true) {
        return true;
      }
      if (current === false) {
        // Restores a static class removed through the renderer.
        rendererClasses.delete(className);
      } else if (isStaticClass(lView[TVIEW], tNode, className)) {
        // Already applied with its own precedence (`NgClass` re-adds the `class` attribute it
        // receives as an input).
        return true;
      } else {
        rendererClasses.set(className, true);
      }
    } else if (current === true) {
      rendererClasses.delete(className);
    } else if (current === undefined && isStaticClass(lView[TVIEW], tNode, className)) {
      rendererClasses.set(className, false);
    } else {
      // Not a class source of the element: removed from the DOM like without merging.
      return false;
    }
    this.writeClasses(lView[TVIEW], tNode, lView, element);
    return true;
  }

  /**
   * The view and node of an element whose classes this merger writes, or `null` for elements
   * Angular did not create, elements of destroyed views and elements of an environment that merges
   * differently (another application, or a part of the application without `provideClassMerge`).
   */
  private findContext(element: RElement): {lView: LView; tNode: TNode} | null {
    // Elements created by Angular are always patched; skipping the others before the lookup avoids
    // walking up the DOM, and asserting on nodes that are not DOM nodes (custom renderers).
    if (element == null || typeof element !== 'object' || readPatchedData(element) === null) {
      return null;
    }
    const context = getLContext(element);
    const lView = context?.lView;
    if (!lView || lView[ENVIRONMENT].classMerger !== this) {
      return null;
    }
    const tNode = lView[TVIEW].data[context!.nodeIndex] as TNode | null;
    return tNode ? {lView, tNode} : null;
  }

  /** The class record of an element, created on the first write. */
  private getElementClasses(element: RElement): ElementClasses {
    let record = this.elements.get(element);
    if (record === undefined) {
      const current = splitClasses(readClasses(element));
      record = {
        owned: '',
        written: current.join(' '),
        pending: current.length > 0 ? current : null,
        unsettled: null,
        rendererClasses: null,
      };
      this.elements.set(element, record);
    }
    return record;
  }

  /** The class plan of an element, cached once the first update pass linked all its bindings. */
  private getPlan(tView: TView, tNode: TNode): ClassPlan {
    let plan = this.plans.get(tNode);
    if (plan === undefined) {
      plan = createClassPlan(tView, tNode, this.getHostBindingRoots(tView));
      if (!tView.firstUpdatePass) {
        this.plans.set(tNode, plan);
      }
    }
    return plan;
  }

  /** Where the host binding slots of each directive of a `TView` start, by directive index. */
  private getHostBindingRoots(tView: TView): Map<number, number> {
    let roots = this.hostBindingRoots.get(tView);
    if (roots === undefined) {
      roots = new Map();
      const opCodes = tView.hostBindingOpCodes;
      if (opCodes !== null) {
        for (let i = 0; i < opCodes.length; i++) {
          const opCode = opCodes[i] as number;
          // Negative opcodes select an element; others are a directive index followed by its
          // binding root and its host bindings function.
          if (opCode >= 0) {
            roots.set(opCode, opCodes[i + 1] as number);
            i += 2;
          }
        }
      }
      // The op codes are complete once the first creation pass is done.
      if (!tView.firstCreatePass) {
        this.hostBindingRoots.set(tView, roots);
      }
    }
    return roots;
  }

  /**
   * Merges the static classes of an element.
   *
   * Only elements with host classes are merged: classes that come from the `class` attribute alone are
   * written as they are. The result is cached on the `TNode`, so it is computed once per template
   * location rather than once per element.
   */
  private mergeStaticClasses(tView: TView, tNode: TNode): string {
    const classes = tNode.classes!;
    if (classes === tNode.classesWithoutHost) {
      return classes;
    }
    let merged = this.staticClasses.get(tNode);
    if (merged === undefined) {
      const sources = new Map<string, boolean>();
      for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
        setStaticClasses(sources, (tView.data[i] as DirectiveDef<unknown>).hostAttrs);
      }
      setStaticClasses(sources, tNode.attrs);
      const list = Array.from(sources.keys());
      const result = this.callMerge(list);
      if (result === null) {
        return list.join(' ');
      }
      this.staticClasses.set(tNode, (merged = result));
    }
    return merged;
  }

  /**
   * Calls the merge function. An error goes to the application's error handler and `null` is returned
   * so the caller writes the classes unmerged rather than leaving the element without classes.
   */
  private callMerge(classes: string[]): string | null {
    try {
      const merged = this.merge(classes);
      if (ngDevMode && typeof merged !== 'string') {
        throw new RuntimeError(
          RuntimeErrorCode.INVALID_CLASS_MERGE_RESULT,
          `The function passed to \`provideClassMerge\` must return a string, got ${typeof merged}.`,
        );
      }
      return merged;
    } catch (error) {
      this.handleError(error);
      return null;
    }
  }
}

/**
 * Delegates to the injected renderer, except that `addClass` / `removeClass` on an element whose
 * classes are merged add or remove a class source and rewrite the element's classes.
 */
class ClassMergeRenderer implements Renderer2 {
  constructor(
    private readonly delegate: Renderer2,
    private readonly merger: ClassMerger,
  ) {}

  get data() {
    return this.delegate.data;
  }

  // A getter: some renderers set `destroyNode` later (e.g. once animations are loaded).
  get destroyNode() {
    return this.delegate.destroyNode;
  }

  addClass(el: any, name: string): void {
    // Invalid names are left to the renderer, which reports them.
    if (!isClassName(name) || !this.merger.setRendererClass(el, name, true)) {
      this.delegate.addClass(el, name);
    }
  }

  removeClass(el: any, name: string): void {
    if (!isClassName(name) || !this.merger.setRendererClass(el, name, false)) {
      this.delegate.removeClass(el, name);
    }
  }

  destroy(): void {
    this.delegate.destroy();
  }
  createElement(name: string, namespace?: string | null) {
    return this.delegate.createElement(name, namespace);
  }
  createComment(value: string) {
    return this.delegate.createComment(value);
  }
  createText(value: string) {
    return this.delegate.createText(value);
  }
  appendChild(parent: any, newChild: any): void {
    this.delegate.appendChild(parent, newChild);
  }
  insertBefore(parent: any, newChild: any, refChild: any, isMove?: boolean): void {
    this.delegate.insertBefore(parent, newChild, refChild, isMove);
  }
  removeChild(
    parent: any,
    oldChild: any,
    isHostElement?: boolean,
    requireSynchronousElementRemoval?: boolean,
  ): void {
    this.delegate.removeChild(parent, oldChild, isHostElement, requireSynchronousElementRemoval);
  }
  selectRootElement(selectorOrNode: any, preserveContent?: boolean) {
    return this.delegate.selectRootElement(selectorOrNode, preserveContent);
  }
  parentNode(node: any) {
    return this.delegate.parentNode(node);
  }
  nextSibling(node: any) {
    return this.delegate.nextSibling(node);
  }
  setAttribute(el: any, name: string, value: string, namespace?: string | null): void {
    this.delegate.setAttribute(el, name, value, namespace);
  }
  removeAttribute(el: any, name: string, namespace?: string | null): void {
    this.delegate.removeAttribute(el, name, namespace);
  }
  setStyle(el: any, style: string, value: any, flags?: RendererStyleFlags2): void {
    this.delegate.setStyle(el, style, value, flags);
  }
  removeStyle(el: any, style: string, flags?: RendererStyleFlags2): void {
    this.delegate.removeStyle(el, style, flags);
  }
  setProperty(el: any, name: string, value: any): void {
    this.delegate.setProperty(el, name, value);
  }
  setValue(node: any, value: string): void {
    this.delegate.setValue(node, value);
  }
  listen(
    target: any,
    eventName: string,
    callback: (event: any) => boolean | void,
    options?: ListenerOptions,
  ): () => void {
    return this.delegate.listen(target, eventName, callback, options);
  }
}

/**
 * Lists the class sources of an element: for each directive (host directives, then the component,
 * then the other directives in matching order) its static host classes then its host class
 * bindings, then the template's static classes and class bindings.
 */
function createClassPlan(
  tView: TView,
  tNode: TNode,
  hostBindingRoots: Map<number, number>,
): ClassPlan {
  const tData = tView.data;

  // The class bindings in priority order (see `style_binding_list.ts`). With template bindings the
  // range `next` is the template tail, otherwise `prev` is the last host binding: the list's tail.
  const bindings: number[] = [];
  let index =
    getTStylingRangeNext(tNode.classBindings) || getTStylingRangePrev(tNode.classBindings);
  while (index !== 0) {
    bindings.push(index);
    index = getTStylingRangePrev(tData[index + 1] as TStylingRange);
  }
  bindings.reverse();

  const plan: ClassPlan = [];
  for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
    const def = tData[i] as DirectiveDef<unknown>;
    const statics = getStaticClasses(def.hostAttrs);
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
  const templateStatics = getStaticClasses(tNode.attrs);
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

/** Applies the plan's sources in order, then the renderer classes; returns the resulting classes. */
function collectClasses(
  plan: ClassPlan,
  tData: TData,
  lView: LView,
  rendererClasses: Map<string, boolean> | null,
): string[] {
  const classes = new Map<string, boolean>();
  for (const entry of plan) {
    if (typeof entry !== 'number') {
      for (const className of entry) {
        setClass(classes, className, true);
      }
      continue;
    }
    const key = getClassKey(tData, entry);
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
        setClass(classes, key, value);
      }
    }
  }
  rendererClasses?.forEach((value, className) => setClass(classes, className, value));
  return Array.from(classes.keys());
}

/**
 * Sorts the server rendered classes of a hydrated element into Angular's classes (removed when the
 * client no longer produces them) and the others, which are kept.
 *
 * Statics and `[class.name]` keys are known by name. A `[class]` value is not: on an element with a
 * `[class]` binding the other server rendered classes may be stale `[class]` values, so they are
 * returned to be settled once the application is stable (see `ElementClasses.unsettled`).
 */
function takeOverPendingClasses(
  pending: string[],
  owned: Set<string>,
  plan: ClassPlan,
  tData: TData,
): string[] | null {
  const known = new Set<string>();
  let hasClassMap = false;
  for (const entry of plan) {
    if (typeof entry !== 'number') {
      entry.forEach((className) => known.add(className));
      continue;
    }
    const key = getClassKey(tData, entry);
    if (key === null) {
      hasClassMap = true;
    } else if (key !== false) {
      known.add(key);
    }
  }
  const unsettled: string[] = [];
  for (const className of pending) {
    if (known.has(className)) {
      owned.add(className);
    } else if (hasClassMap) {
      unsettled.push(className);
    }
  }
  return unsettled.length > 0 ? unsettled : null;
}

/** The class name of a `[class.name]` binding, `null` for `[class]`, `false` when shadowed. */
function getClassKey(tData: TData, bindingIndex: number): string | null | false {
  const key = tData[bindingIndex] as TStylingKey;
  return (Array.isArray(key) ? key[1] : key) as string | null | false;
}

function isStaticClass(tView: TView, tNode: TNode, className: string): boolean {
  for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
    if (getStaticClasses((tView.data[i] as DirectiveDef<unknown>).hostAttrs).includes(className)) {
      return true;
    }
  }
  return getStaticClasses(tNode.attrs).includes(className);
}

function getStaticClasses(attrs: TAttributes | null): string[] {
  const classes: string[] = [];
  if (attrs !== null) {
    let marker = AttributeMarker.ImplicitAttributes;
    for (const item of attrs) {
      if (typeof item === 'number') {
        marker = item;
      } else if (marker === AttributeMarker.Classes) {
        classes.push(item as string);
      }
    }
  }
  return classes;
}

function setStaticClasses(classes: Map<string, boolean>, attrs: TAttributes | null): void {
  for (const className of getStaticClasses(attrs)) {
    setClass(classes, className, true);
  }
}

/**
 * Applies a `[class]` value with the same rules as `toStylingKeyValueArray`: a string is split on
 * whitespace, array and `Set` items and object keys are stringified (see `classKeyValueArraySet`).
 */
function setClassMapValue(classes: Map<string, boolean>, value: unknown): void {
  const unwrapped = unwrapSafeValue(value);
  if (typeof unwrapped === 'string') {
    for (const className of splitClasses(unwrapped)) {
      setClass(classes, className, true);
    }
  } else if (Array.isArray(unwrapped) || unwrapped instanceof Set) {
    for (const item of unwrapped) {
      setClassKey(classes, item, true);
    }
  } else if (unwrapped != null && typeof unwrapped === 'object') {
    for (const key in unwrapped) {
      if (unwrapped.hasOwnProperty(key)) {
        setClassKey(classes, key, (unwrapped as Record<string, unknown>)[key]);
      }
    }
  }
}

/** Empty keys and keys with spaces are ignored, like `classKeyValueArraySet`. */
function setClassKey(classes: Map<string, boolean>, key: unknown, value: unknown): void {
  const className = String(key);
  if (isClassName(className)) {
    setClass(classes, className, value);
  }
}

/** Sets a class at the highest precedence so far (truthy), removes it (falsy) or ignores `undefined`. */
function setClass(classes: Map<string, boolean>, className: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  classes.delete(className);
  if (value) {
    classes.set(className, true);
  }
}

function isClassName(value: string): boolean {
  return value !== '' && !/\s/.test(value);
}

/**
 * The `class` attribute of an element, or `''` when the renderer's elements cannot be read (a custom
 * renderer): classes added outside of Angular are then not preserved.
 */
function readClasses(element: RElement): string {
  return (typeof element.getAttribute === 'function' && element.getAttribute('class')) || '';
}

function splitClasses(value: string): string[] {
  return value ? value.split(/\s+/).filter((className) => className !== '') : [];
}
