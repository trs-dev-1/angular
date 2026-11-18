/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {DOCUMENT, isPlatformServer} from '@angular/common';
import {
  ApplicationRef,
  Component,
  Directive,
  destroyPlatform,
  ElementRef,
  inject,
  PLATFORM_ID,
  provideClassMerge,
  Provider,
  Renderer2,
  signal,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {withIncrementalHydration} from '@angular/platform-browser';

import {
  clearDocument,
  getAppContents,
  prepareEnvironmentAndHydrate,
  resetTViewsFor,
} from './dom_utils';
import {
  clearConsole,
  getComponentRef,
  resetNgDevModeCounters,
  ssr,
  verifyAllNodesClaimedForHydration,
  verifyClientAndSSRContentsMatch,
} from './hydration_utils';

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

const mergeProviders = [provideClassMerge(lastWins)] as unknown as Provider[];

@Directive({selector: '[variant]', host: {class: 'g1-variant g3-variant'}})
class Variant {}

@Component({
  selector: 'chip',
  template: 'chip',
  host: {'class': 'g1-chip g2-chip', '[class]': 'size()'},
})
class Chip {
  size = signal('g2-md');
}

describe('class merge with SSR and hydration', () => {
  let doc: Document;

  beforeEach(() => {
    resetNgDevModeCounters();
    doc = TestBed.inject(DOCUMENT);
    clearConsole(TestBed.inject(ApplicationRef));
  });

  afterEach(() => {
    clearDocument(doc);
    destroyPlatform();
  });

  it('should render merged classes on the server and keep them when hydrating', async () => {
    @Component({
      selector: 'app',
      imports: [Chip, Variant],
      template: `<chip variant class="g3-consumer" [class.g1-active]="active()" />`,
    })
    class App {
      active = signal(true);
    }

    const html = await ssr(App, {envProviders: mergeProviders});
    const ssrContents = getAppContents(html);
    const expected = lastWins([
      'g1-chip',
      'g2-chip',
      'g2-md',
      'g1-variant',
      'g3-variant',
      'g3-consumer',
      'g1-active',
    ]);
    expect(ssrContents).toContain(`class="${expected}"`);

    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: mergeProviders,
    });
    const compRef = getComponentRef<App>(appRef);
    appRef.tick();

    const root = compRef.location.nativeElement as HTMLElement;
    verifyAllNodesClaimedForHydration(root);
    verifyClientAndSSRContentsMatch(ssrContents, root);
    expect(root.querySelector('chip')!.className).toBe(expected);

    compRef.instance.active.set(false);
    appRef.tick();
    expect(root.querySelector('chip')!.className).toBe(
      lastWins(['g1-chip', 'g2-chip', 'g2-md', 'g1-variant', 'g3-variant', 'g3-consumer']),
    );
  });

  it('should drop server classes that the client state no longer produces', async () => {
    @Component({
      selector: 'app',
      imports: [Chip],
      template: `<chip [class.g1-server]="onServer" [class.g1-client]="!onServer" />`,
    })
    class App {
      onServer = isPlatformServer(inject(PLATFORM_ID));
    }

    const html = await ssr(App, {envProviders: mergeProviders});
    expect(getAppContents(html)).toContain('g1-server');

    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: mergeProviders,
    });
    appRef.tick();

    const chip = (getComponentRef<App>(appRef).location.nativeElement as HTMLElement).querySelector(
      'chip',
    )!;
    expect(chip.className).toBe(lastWins(['g1-chip', 'g2-chip', 'g2-md', 'g1-client']));
  });

  it('should keep server rendered classes added outside of class bindings', async () => {
    /** Like `RouterLinkActive`: adds a class with the renderer, on the client only later. */
    @Directive({selector: '[activeLink]'})
    class ActiveLink {
      private renderer = inject(Renderer2);
      private element = inject(ElementRef).nativeElement as HTMLElement;
      constructor() {
        if (isPlatformServer(inject(PLATFORM_ID))) {
          this.renderer.addClass(this.element, 'active');
        }
      }
      activate() {
        this.renderer.addClass(this.element, 'active');
      }
    }

    @Component({
      selector: 'app',
      imports: [Chip, ActiveLink],
      template: `<chip activeLink [class.g1-on]="on()" />`,
    })
    class App {
      on = signal(true);
    }

    const html = await ssr(App, {envProviders: mergeProviders});
    expect(getAppContents(html)).toContain('active');

    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: mergeProviders,
    });
    appRef.tick();

    const compRef = getComponentRef<App>(appRef);
    const chip = (compRef.location.nativeElement as HTMLElement).querySelector('chip')!;
    const classes = () => chip.className.split(' ');
    // Not dropped while the client has not re-applied it yet (no flicker).
    expect(classes()).toContain('active');
    expect(classes()).toContain('g1-on');

    compRef.instance.on.set(false);
    appRef.tick();
    expect(classes()).toContain('active');
    expect(classes()).not.toContain('g1-on');
  });

  describe('incremental hydration', () => {
    const originalWindow = globalThis.window;

    beforeAll(async () => {
      globalThis.window = globalThis as unknown as Window & typeof globalThis;
      await import('../../core/primitives/event-dispatch/contract_bundle_min.js' as string);
    });

    afterAll(() => {
      globalThis.window = originalWindow;
    });

    it('should merge the classes of elements in a hydrated defer block', async () => {
      @Component({
        selector: 'app',
        imports: [Chip, Variant],
        template: `
          <main>
            @defer (hydrate on immediate) {
              <chip variant class="g3-consumer" [class.g1-active]="active()" />
            }
          </main>
        `,
      })
      class App {
        active = signal(true);
      }

      const hydrationFeatures = () => [withIncrementalHydration()];
      const html = await ssr(App, {envProviders: mergeProviders, hydrationFeatures});
      const expected = lastWins([
        'g1-chip',
        'g2-chip',
        'g2-md',
        'g1-variant',
        'g3-variant',
        'g3-consumer',
        'g1-active',
      ]);
      expect(getAppContents(html)).toContain(`class="${expected}"`);

      resetTViewsFor(App);
      const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
        envProviders: [...mergeProviders, {provide: PLATFORM_ID, useValue: 'browser'}],
        hydrationFeatures,
      });
      appRef.tick();
      await appRef.whenStable();
      appRef.tick();

      const compRef = getComponentRef<App>(appRef);
      const chip = (compRef.location.nativeElement as HTMLElement).querySelector('chip')!;
      expect(chip.className).toBe(expected);

      compRef.instance.active.set(false);
      appRef.tick();
      expect(chip.className).toBe(
        lastWins(['g1-chip', 'g2-chip', 'g2-md', 'g1-variant', 'g3-variant', 'g3-consumer']),
      );
    });
  });
});
