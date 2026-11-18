/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {NgClass} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ComponentRef,
  createComponent,
  createEnvironmentInjector,
  Directive,
  ElementRef,
  EnvironmentInjector,
  ErrorHandler,
  inject,
  Input,
  provideClassMerge,
  Renderer2,
  signal,
  Type,
  ViewContainerRef,
  WritableSignal,
} from '../../src/core';
import {getDirectives} from '../../src/render3/util/discovery_utils';
import {TestBed} from '../../testing';

type ClassMapValue = string | string[] | Record<string, boolean> | null | undefined;

interface ClassSource {
  /** The static `class` of the source. */
  statics: string;
  /** The `[class]` binding. */
  map: WritableSignal<ClassMapValue>;
  /** The `[class.<prop>]` binding. */
  prop: WritableSignal<boolean | undefined>;
}

/**
 * The class sources of the element under test, in the documented precedence order (lowest first):
 * the component's host directive (host directives run before their host), the component host, the
 * directives in matching order, then the template.
 *
 * Classes are named `<group>-<name>`: two classes of one group conflict (see `lastWins`), and
 * `shared` is set by several sources to compare the same-name precedence with unmerged Angular.
 */
const SOURCE_NAMES = ['hd', 'cmp', 'dirA', 'dirB', 'tpl'] as const;
type SourceName = (typeof SOURCE_NAMES)[number];
const PROPS: Record<SourceName, string> = {
  cmp: 'g2-cmpp',
  hd: 'g1-hdp',
  dirA: 'g3-dirAp',
  dirB: 'g1-dirBp',
  tpl: 'g3-tplp',
};
const sources = {} as Record<SourceName, ClassSource>;

function resetSources() {
  const statics: Record<SourceName, string> = {
    cmp: 'g1-cmps g2-cmps',
    hd: 'g2-hds g3-hds',
    dirA: 'g1-dirAs shared',
    dirB: 'g3-dirBs',
    tpl: 'g2-tpls shared',
  };
  for (const name of SOURCE_NAMES) {
    sources[name] = {statics: statics[name], map: signal(undefined), prop: signal(undefined)};
  }
}
resetSources();

@Directive({
  selector: '[hd]',
  host: {'class': 'g2-hds g3-hds', '[class]': 'map()', '[class.g1-hdp]': 'prop()'},
})
class HostDir {
  map = sources.hd.map;
  prop = sources.hd.prop;
}

@Component({
  selector: 'x-cmp',
  template: '',
  hostDirectives: [HostDir],
  host: {'class': 'g1-cmps g2-cmps', '[class]': 'map()', '[class.g2-cmpp]': 'prop()'},
})
class XCmp {
  map = sources.cmp.map;
  prop = sources.cmp.prop;
}

@Directive({
  selector: '[dirA]',
  host: {'class': 'g1-dirAs shared', '[class]': 'map()', '[class.g3-dirAp]': 'prop()'},
})
class DirA {
  map = sources.dirA.map;
  prop = sources.dirA.prop;
}

@Directive({
  selector: '[dirB]',
  host: {'class': 'g3-dirBs', '[class]': 'map()', '[class.g1-dirBp]': 'prop()'},
})
class DirB {
  map = sources.dirB.map;
  prop = sources.dirB.prop;
}

@Component({
  selector: 'all-sources',
  imports: [XCmp, DirA, DirB],
  template: `<x-cmp dirA dirB class="g2-tpls shared" [class]="map()" [class.g3-tplp]="prop()" />`,
})
class AllSources {
  map = sources.tpl.map;
  prop = sources.tpl.prop;
}

/** A merger where the last class of a group (the part before the first `-`) wins, like twMerge. */
function lastWins(classes: string[]): string {
  const byGroup = new Map<string, string>();
  for (const className of classes) {
    const group = className.includes('-') ? className.slice(0, className.indexOf('-')) : className;
    byGroup.delete(group);
    byGroup.set(group, className);
  }
  return Array.from(byGroup.values()).join(' ');
}

const identity = (classes: string[]) => classes.join(' ');

/** The expected classes: the sources applied in the documented precedence order, then merged. */
function expectedClasses(merge: (classes: string[]) => string): string {
  const classes = new Map<string, true>();
  const set = (className: string, value: unknown) => {
    if (value === undefined) return;
    classes.delete(className);
    if (value) classes.set(className, true);
  };
  for (const name of SOURCE_NAMES) {
    const source = sources[name];
    source.statics.split(' ').forEach((className) => set(className, true));
    const map = source.map();
    if (typeof map === 'string') {
      map
        .split(/\s+/)
        .filter(Boolean)
        .forEach((className) => set(className, true));
    } else if (Array.isArray(map)) {
      map.forEach((className) => set(className, true));
    } else if (map) {
      Object.keys(map).forEach((className) => set(className, map[className]));
    }
    set(PROPS[name], source.prop());
  }
  return merge(Array.from(classes.keys()));
}

function sorted(className: string): string {
  return className.split(/\s+/).filter(Boolean).sort().join(' ');
}

/** Deterministic PRNG so a failing sequence can be replayed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMapValue(next: () => number, name: SourceName): ClassMapValue {
  const pool = [`g1-${name}m1`, `g2-${name}m2`, `g3-${name}m3`, 'shared', 'g1-shared'];
  const pick = () => pool.filter(() => next() < 0.5);
  switch (Math.floor(next() * 6)) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return '';
    case 3:
      return pick().join(' ');
    case 4:
      return pick();
    default:
      return Object.fromEntries(pool.filter(() => next() < 0.6).map((c) => [c, next() < 0.5]));
  }
}

function randomPropValue(next: () => number): boolean | undefined {
  return [undefined, true, false][Math.floor(next() * 3)];
}

/** Creates a root component in an environment that provides the given merge function. */
function createWithMerge<T>(
  type: Type<T>,
  merge: ((classes: string[]) => string) | null,
  extraProviders: unknown[] = [],
): ComponentRef<T> {
  const environmentInjector = createEnvironmentInjector(
    [merge ? provideClassMerge(merge) : [], ...(extraProviders as [])],
    TestBed.inject(EnvironmentInjector),
  );
  const ref = createComponent(type, {environmentInjector});
  ref.changeDetectorRef.detectChanges();
  return ref;
}

function hostOf(ref: ComponentRef<unknown>, selector: string): HTMLElement {
  return (ref.location.nativeElement as HTMLElement).querySelector(selector)!;
}

describe('class merge', () => {
  beforeEach(() => resetSources());

  describe('randomized updates over every class source', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      it(`should match unmerged Angular and the documented precedence (seed ${seed})`, () => {
        const next = random(seed);
        const unmerged = createWithMerge(AllSources, null);
        const identityMerged = createWithMerge(AllSources, identity);
        const lastWinsMerged = createWithMerge(AllSources, lastWins);

        for (let step = 0; step < 300; step++) {
          const updates = 1 + Math.floor(next() * 3);
          for (let i = 0; i < updates; i++) {
            const name = SOURCE_NAMES[Math.floor(next() * SOURCE_NAMES.length)];
            if (next() < 0.5) {
              sources[name].map.set(randomMapValue(next, name));
            } else {
              sources[name].prop.set(randomPropValue(next));
            }
          }
          for (const ref of [unmerged, identityMerged, lastWinsMerged]) {
            ref.changeDetectorRef.detectChanges();
          }

          const context = `seed ${seed}, step ${step}`;
          const unmergedClasses = hostOf(unmerged, 'x-cmp').className;
          // (a) Same classes as Angular without merging.
          expect(sorted(hostOf(identityMerged, 'x-cmp').className))
            .withContext(`${context} (a) identity merge vs unmerged`)
            .toBe(sorted(unmergedClasses));
          // The documented order, restated here, agrees with unmerged Angular on the class set...
          expect(sorted(expectedClasses(identity)))
            .withContext(`${context} reference vs unmerged`)
            .toBe(sorted(unmergedClasses));
          // (b) ...and decides the conflicts.
          expect(hostOf(lastWinsMerged, 'x-cmp').className)
            .withContext(`${context} (b) lastWins vs reference`)
            .toBe(expectedClasses(lastWins));
        }
      });
    }
  });

  describe('precedence between sources', () => {
    it('should let the template beat directives, and directives beat the component', () => {
      const ref = createWithMerge(AllSources, lastWins);
      const element = hostOf(ref, 'x-cmp');
      // g1: cmp static < dirA static; g2: hd static < cmp static < template static; g3: hd < dirB.
      expect(element.className).toBe(expectedClasses(lastWins));
      expect(element.className.split(' ')).toContain('g1-dirAs');
      expect(element.className.split(' ')).toContain('g2-tpls');
      expect(element.className.split(' ')).toContain('g3-dirBs');
    });

    it('should keep the order of the classes inside one [class] value', () => {
      @Component({template: `<div [class]="value"></div>`})
      class Cmp {
        value = 'g1-base g1-variant g2-x';
      }
      const ref = createWithMerge(Cmp, lastWins);
      expect(hostOf(ref, 'div').className).toBe('g1-variant g2-x');
    });

    it('should keep the order of the static classes of several sources', () => {
      @Directive({selector: '[warn]', host: {class: 'g1-warn'}})
      class Warn {}
      @Component({selector: 'chip', template: '', host: {'[class]': `'g2-chip'`}})
      class Chip {}
      @Component({imports: [Chip, Warn], template: `<chip warn class="g1-consumer"></chip>`})
      class Cmp {}
      const ref = createWithMerge(Cmp, lastWins);
      expect(hostOf(ref, 'chip').className).toBe('g2-chip g1-consumer');
    });

    it('should merge static classes when there are no bindings', () => {
      @Component({selector: 'badge', template: '', host: {class: 'g1-default g2-size'}})
      class Badge {}
      @Component({imports: [Badge], template: `<badge class="g1-consumer"></badge>`})
      class Cmp {}
      const ref = createWithMerge(Cmp, lastWins);
      expect(hostOf(ref, 'badge').className).toBe('g2-size g1-consumer');
    });

    it('should leave elements whose classes come only from their own class attribute', () => {
      @Component({template: `<div class="g1-a g1-b"></div>`})
      class Cmp {}
      const ref = createWithMerge(Cmp, lastWins);
      expect(hostOf(ref, 'div').className).toBe('g1-a g1-b');
    });
  });

  describe('special elements and inputs', () => {
    it('should skip a [class] binding shadowed by an @Input("class")', () => {
      @Directive({selector: '[takesClass]'})
      class TakesClass {
        @Input('class') klass: unknown;
      }
      @Component({
        imports: [TakesClass],
        template: `<div takesClass class="g1-static" [class]="map" [class.g1-prop]="prop"></div>`,
      })
      class Cmp {
        map = 'g1-map';
        prop = true;
      }
      const unmerged = createWithMerge(Cmp, null);
      const merged = createWithMerge(Cmp, identity);
      expect(sorted(hostOf(merged, 'div').className)).toBe(
        sorted(hostOf(unmerged, 'div').className),
      );
      const takesClass = createWithMerge(Cmp, lastWins);
      expect(
        hostOf(takesClass, 'div')
          .className.split(' ')
          .filter((c) => c.startsWith('g1-')).length,
      ).toBe(1);
    });

    it('should merge the classes of SVG elements', () => {
      @Directive({selector: '[svgDir]', host: {class: 'g1-dir'}})
      class SvgDir {}
      @Component({
        imports: [SvgDir],
        template: `<svg svgDir class="g1-static" [class.g1-prop]="prop"></svg>`,
      })
      class Cmp {
        prop = false;
      }
      const ref = createWithMerge(Cmp, lastWins);
      const svg = hostOf(ref, 'svg');
      expect(svg.getAttribute('class')).toBe('g1-static');
      ref.instance.prop = true;
      ref.changeDetectorRef.detectChanges();
      expect(svg.getAttribute('class')).toBe('g1-prop');
    });

    it('should ignore class bindings on ng-container', () => {
      @Component({
        template: `<ng-container [class]="'g1-a'"><span class="g1-b"></span></ng-container>`,
      })
      class Cmp {}
      const ref = createWithMerge(Cmp, lastWins);
      expect(hostOf(ref, 'span').className).toBe('g1-b');
    });
  });

  describe('dynamic views', () => {
    it('should merge the host classes of the root component', () => {
      @Component({
        selector: 'root',
        template: '',
        host: {'class': 'g1-static', '[class.g1-prop]': 'prop'},
      })
      class Root {
        prop = true;
      }
      const ref = createWithMerge(Root, lastWins);
      expect((ref.location.nativeElement as HTMLElement).className).toBe('g1-prop');
    });

    it('should merge components created through a ViewContainerRef', () => {
      @Component({template: ''})
      class Container {
        vcr = inject(ViewContainerRef);
      }
      const ref = createWithMerge(Container, lastWins);
      const child = ref.instance.vcr.createComponent(XCmp);
      sources.cmp.map.set('g1-map');
      child.changeDetectorRef.detectChanges();
      expect((child.location.nativeElement as HTMLElement).className).toBe(
        lastWins(['g2-hds', 'g3-hds', 'g1-cmps', 'g2-cmps', 'g1-map']),
      );
    });

    it('should merge elements recreated by @if and @for', () => {
      @Component({
        imports: [XCmp],
        template: `
          @if (show()) {
            <x-cmp class="g1-if" />
          }
          @for (item of items(); track item) {
            <x-cmp [class]="item" />
          }
        `,
      })
      class Cmp {
        show = signal(true);
        items = signal(['g1-a', 'g2-b']);
      }
      const ref = createWithMerge(Cmp, lastWins);
      const classesOf = () =>
        Array.from((ref.location.nativeElement as HTMLElement).querySelectorAll('x-cmp')).map(
          (element) => element.className,
        );
      const ifClasses = lastWins(['g2-hds', 'g3-hds', 'g1-cmps', 'g2-cmps', 'g1-if']);
      const forClasses = (item: string) =>
        lastWins(['g2-hds', 'g3-hds', 'g1-cmps', 'g2-cmps', item]);
      expect(classesOf()).toEqual([ifClasses, forClasses('g1-a'), forClasses('g2-b')]);

      ref.instance.show.set(false);
      ref.instance.items.set(['g2-b', 'g3-c']);
      ref.changeDetectorRef.detectChanges();
      ref.instance.show.set(true);
      ref.changeDetectorRef.detectChanges();
      expect(classesOf()).toEqual([ifClasses, forClasses('g2-b'), forClasses('g3-c')]);
    });

    it('should apply updates of OnPush and detached views once they are checked', () => {
      @Component({
        imports: [XCmp],
        changeDetection: ChangeDetectionStrategy.OnPush,
        template: `<x-cmp [class.g1-on]="on()" />`,
      })
      class Cmp {
        on = signal(false);
      }
      const ref = createWithMerge(Cmp, lastWins);
      const element = hostOf(ref, 'x-cmp');
      ref.changeDetectorRef.detach();
      ref.instance.on.set(true);
      expect(element.className.split(' ')).not.toContain('g1-on');
      ref.changeDetectorRef.reattach();
      ref.changeDetectorRef.detectChanges();
      expect(element.className.split(' ')).toContain('g1-on');
      expect(element.className.split(' ')).not.toContain('g1-cmps');
    });
  });

  describe('classes set outside of class bindings', () => {
    @Component({
      imports: [NgClass],
      template: `<div class="g1-static" [class.g1-prop]="prop()" [ngClass]="{'ngc': ngc()}"></div>`,
    })
    class Cmp {
      prop = signal(false);
      ngc = signal(true);
      renderer = inject(Renderer2);
    }

    it('should keep classes added with classList, Renderer2 and NgClass', () => {
      const ref = createWithMerge(Cmp, lastWins);
      const element = hostOf(ref, 'div');
      element.classList.add('foreign');
      ref.instance.renderer.addClass(element, 'renderer');
      ref.instance.prop.set(true);
      ref.changeDetectorRef.detectChanges();
      expect(sorted(element.className)).toBe('foreign g1-prop ngc renderer');

      ref.instance.ngc.set(false);
      ref.instance.prop.set(false);
      ref.changeDetectorRef.detectChanges();
      expect(sorted(element.className)).toBe('foreign g1-static renderer');
    });

    it('should not bring back a foreign class that was removed', () => {
      const ref = createWithMerge(Cmp, lastWins);
      const element = hostOf(ref, 'div');
      element.classList.add('foreign');
      ref.instance.prop.set(true);
      ref.changeDetectorRef.detectChanges();
      element.classList.remove('foreign');
      ref.instance.prop.set(false);
      ref.changeDetectorRef.detectChanges();
      expect(sorted(element.className)).toBe('g1-static ngc');
    });
  });

  describe('classes added through Renderer2', () => {
    /** Like `RouterLinkActive`: toggles a class with the injected renderer. */
    @Directive({selector: '[activeClass]', exportAs: 'activeClass'})
    class ActiveClass {
      private renderer = inject(Renderer2);
      private element = inject(ElementRef).nativeElement;
      @Input() activeClass = '';
      toggle(active: boolean) {
        active
          ? this.renderer.addClass(this.element, this.activeClass)
          : this.renderer.removeClass(this.element, this.activeClass);
      }
    }

    it('should let a class added with the renderer win, and restore the class it replaced', () => {
      @Component({
        imports: [ActiveClass],
        template: `<a class="g1-primary g2-x" activeClass="g1-secondary"></a>`,
      })
      class Cmp {}
      const ref = createWithMerge(Cmp, lastWins);
      const element = hostOf(ref, 'a');
      const activeClass = getActiveClass(ref);
      expect(element.className).toBe('g1-primary g2-x');
      activeClass.toggle(true);
      expect(element.className).toBe('g2-x g1-secondary');
      activeClass.toggle(false);
      expect(element.className).toBe('g1-primary g2-x');
    });

    it('should keep the renderer class above class bindings when they change', () => {
      @Component({
        imports: [XCmp, ActiveClass],
        template: `<x-cmp activeClass="g1-active" [class.g1-prop]="prop()" />`,
      })
      class Cmp {
        prop = signal(false);
      }
      const ref = createWithMerge(Cmp, lastWins);
      const element = hostOf(ref, 'x-cmp');
      getActiveClass(ref).toggle(true);
      ref.instance.prop.set(true);
      ref.changeDetectorRef.detectChanges();
      expect(element.className.split(' ').filter((c) => c.startsWith('g1-'))).toEqual([
        'g1-active',
      ]);
      getActiveClass(ref).toggle(false);
      expect(element.className.split(' ').filter((c) => c.startsWith('g1-'))).toEqual(['g1-prop']);
    });

    it('should leave elements that Angular did not create to the renderer', () => {
      @Component({template: ''})
      class Cmp {
        renderer = inject(Renderer2);
      }
      const ref = createWithMerge(Cmp, lastWins);
      const div = ref.instance.renderer.createElement('div');
      ref.instance.renderer.addClass(div, 'g1-a');
      ref.instance.renderer.addClass(div, 'g1-b');
      expect(div.className).toBe('g1-a g1-b');
    });

    function getActiveClass(ref: ComponentRef<unknown>): ActiveClass {
      const element = (ref.location.nativeElement as HTMLElement).querySelector('[activeclass]')!;
      return getDirectives(element).find((d) => d instanceof ActiveClass) as ActiveClass;
    }
  });

  describe('merge functions', () => {
    it('should use the merge function of each application', () => {
      const dropG1 = (classes: string[]) => classes.filter((c) => !c.startsWith('g1-')).join(' ');
      const first = createWithMerge(AllSources, lastWins);
      const second = createWithMerge(AllSources, dropG1);
      expect(hostOf(first, 'x-cmp').className).toBe(expectedClasses(lastWins));
      expect(hostOf(second, 'x-cmp').className).toBe(expectedClasses(dropG1));
    });

    it('should report an error of the merge function and write the classes unmerged', () => {
      const errors: unknown[] = [];
      TestBed.configureTestingModule({
        rethrowApplicationErrors: false,
        providers: [
          {provide: ErrorHandler, useValue: {handleError: (error: unknown) => errors.push(error)}},
        ],
      });
      const throwing = () => {
        throw new Error('merge failed');
      };
      const ref = createWithMerge(AllSources, throwing);
      expect(errors.length).toBeGreaterThan(0);
      expect((errors[0] as Error).message).toBe('merge failed');
      expect(sorted(hostOf(ref, 'x-cmp').className)).toBe(sorted(expectedClasses(identity)));
    });

    it('should treat classes added by the merge function as its own', () => {
      const addsWhenTplProp = (classes: string[]) =>
        [...classes, ...(classes.includes('g3-tplp') ? ['added'] : [])].join(' ');
      const ref = createWithMerge(AllSources, addsWhenTplProp);
      const element = hostOf(ref, 'x-cmp');
      sources.tpl.prop.set(true);
      ref.changeDetectorRef.detectChanges();
      expect(element.className.split(' ')).toContain('added');
      sources.tpl.prop.set(false);
      ref.changeDetectorRef.detectChanges();
      expect(element.className.split(' ')).not.toContain('added');
    });
  });

  it('should not change anything without a merge function', () => {
    const ref = createWithMerge(AllSources, null);
    // Unmerged Angular keeps conflicting classes side by side.
    expect(hostOf(ref, 'x-cmp').className.split(' ')).toContain('g1-cmps');
    expect(hostOf(ref, 'x-cmp').className.split(' ')).toContain('g1-dirAs');
  });
});
