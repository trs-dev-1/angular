/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  ChangeDetectionStrategy,
  Component,
  provideClassMerge,
  provideZonelessChangeDetection,
} from '@angular/core';
import {FormControl, FormsModule, ReactiveFormsModule, Validators} from '../public_api';
import {TestBed} from '@angular/core/testing';

describe('status host binding classes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({providers: [provideZonelessChangeDetection()]});
  });

  it('work in OnPush components', async () => {
    @Component({
      selector: 'test-cmp',
      template: `<input type="text" [formControl]="control" />`,
      imports: [FormsModule, ReactiveFormsModule],
      changeDetection: ChangeDetectionStrategy.OnPush,
    })
    class App {
      control = new FormControl('old value', [Validators.required]);
    }

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.innerHTML).toContain('ng-valid');
    expect(fixture.nativeElement.innerHTML).toContain('ng-untouched');
    expect(fixture.nativeElement.innerHTML).toContain('ng-pristine');

    fixture.componentInstance.control.setValue(null);
    await fixture.whenStable();
    expect(fixture.nativeElement.innerHTML).toContain('ng-invalid');

    fixture.debugElement.query((x) => x.name === 'input').triggerEventHandler('blur');
    await fixture.whenStable();
    expect(fixture.nativeElement.innerHTML).toContain('ng-touched');

    fixture.componentInstance.control.reset();
    await fixture.whenStable();
    expect(fixture.nativeElement.innerHTML).toContain('ng-untouched');
  });

  it('work with provideClassMerge', async () => {
    TestBed.configureTestingModule({
      providers: [provideClassMerge((classes) => classes.join(' '))],
    });
    @Component({
      selector: 'test-cmp',
      template: `<input type="text" class="field" [formControl]="control" />`,
      imports: [ReactiveFormsModule],
    })
    class App {
      control = new FormControl('', [Validators.required]);
    }

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.className).toBe('ng-untouched ng-pristine ng-invalid field');

    fixture.componentInstance.control.setValue('value');
    await fixture.whenStable();
    expect(input.className).toBe('ng-untouched ng-pristine ng-valid field');
  });
});
