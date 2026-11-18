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
  InjectionToken,
  Input,
  PendingTasks,
  PLATFORM_ID,
  provideClassMerge,
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

const mergeProviders = [provideClassMerge(lastWins)];

@Directive({selector: '[variant]', host: {class: 'g1-variant g3-variant'}})
class Variant {}

/** The size class of `Chip`, `g2-md` unless provided (e.g. differently on the client). */
const CHIP_SIZE = new InjectionToken<string>('CHIP_SIZE', {factory: () => 'g2-md'});

@Component({
  selector: 'chip',
  template: 'chip',
  host: {'class': 'g1-chip g2-chip', '[class]': 'size()'},
})
class Chip {
  size = signal(inject(CHIP_SIZE));
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
      imports: [Variant, ActiveLink],
      template: `<a variant activeLink class="g2-link" [class.g1-on]="on()"></a>`,
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
    const link = (compRef.location.nativeElement as HTMLElement).querySelector('a')!;
    const classes = () => link.className.split(' ');
    // Not dropped while the client has not re-applied it yet (no flicker).
    expect(classes()).toContain('active');
    expect(classes()).toContain('g1-on');

    compRef.instance.on.set(false);
    appRef.tick();
    expect(classes()).toContain('active');
    expect(classes()).not.toContain('g1-on');
  });

  it('should drop server classes of a [class] binding that the client no longer produces', async () => {
    @Component({selector: 'app', imports: [Chip], template: `<chip />`})
    class App {}

    const html = await ssr(App, {envProviders: mergeProviders});
    expect(getAppContents(html)).toContain('g2-md');

    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: [...mergeProviders, {provide: CHIP_SIZE, useValue: 'g2-lg'}],
    });
    appRef.tick();

    const chip = (getComponentRef<App>(appRef).location.nativeElement as HTMLElement).querySelector(
      'chip',
    )!;
    await appRef.whenStable();
    expect(chip.className).toBe(lastWins(['g1-chip', 'g2-chip', 'g2-lg']));
  });

  it('should keep a server class of an element with a [class] binding until it is added again', async () => {
    /** Like `RouterLinkActive`: on the client, adds its class again once the navigation is done. */
    @Directive({selector: '[activeLink]'})
    class ActiveLink {
      private renderer = inject(Renderer2);
      private element = inject(ElementRef).nativeElement as HTMLElement;
      /** Whether the link is still active on the client. */
      @Input() activeLink = '';
      constructor() {
        if (isPlatformServer(inject(PLATFORM_ID))) {
          this.activate();
          return;
        }
        // The pending navigation keeps the application unstable.
        const removeTask = inject(PendingTasks).add();
        setTimeout(() => {
          if (this.activeLink === 'still') {
            this.activate();
          }
          removeTask();
        });
      }
      private activate() {
        this.renderer.addClass(this.element, 'g1-active');
      }
    }

    @Component({
      selector: 'app',
      imports: [Chip, ActiveLink],
      template: `<chip activeLink="still" [class.g3-on]="true" /><chip activeLink="not" />`,
    })
    class App {}

    const html = await ssr(App, {envProviders: mergeProviders});
    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: mergeProviders,
    });
    appRef.tick();

    const root = getComponentRef<App>(appRef).location.nativeElement as HTMLElement;
    const [still, not] = Array.from(root.querySelectorAll('chip'));
    // No flicker: the server class stays while the navigation is pending.
    expect(still.className).toBe(`${lastWins(['g1-chip', 'g2-chip', 'g2-md', 'g3-on'])} g1-active`);
    expect(not.className).toBe(`${lastWins(['g1-chip', 'g2-chip', 'g2-md'])} g1-active`);

    await appRef.whenStable();
    expect(still.className).toBe(lastWins(['g1-chip', 'g2-chip', 'g2-md', 'g3-on', 'g1-active']));
    expect(not.className).toBe(lastWins(['g1-chip', 'g2-chip', 'g2-md']));
  });

  it('should merge the classes of an element that skips hydration', async () => {
    @Component({
      selector: 'app',
      imports: [Chip, Variant],
      template: `<chip ngSkipHydration variant class="g3-consumer" [class.g1-active]="active()" />`,
    })
    class App {
      active = signal(true);
    }

    const html = await ssr(App, {envProviders: mergeProviders});
    resetTViewsFor(App);
    const appRef = await prepareEnvironmentAndHydrate(doc, html, App, {
      envProviders: mergeProviders,
    });
    appRef.tick();

    const compRef = getComponentRef<App>(appRef);
    const chip = (compRef.location.nativeElement as HTMLElement).querySelector('chip')!;
    const expected = (active: boolean) =>
      lastWins([
        'g1-chip',
        'g2-chip',
        'g2-md',
        'g1-variant',
        'g3-variant',
        'g3-consumer',
        ...(active ? ['g1-active'] : []),
      ]);
    expect(chip.className).toBe(expected(true));
    compRef.instance.active.set(false);
    appRef.tick();
    expect(chip.className).toBe(expected(false));
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
