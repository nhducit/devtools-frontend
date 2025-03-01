// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import type * as puppeteer from 'puppeteer';

import {$, click, enableExperiment, getBrowserAndPages, goToResource, platform, pressKey, reloadDevTools, scrollElementIntoView, typeText, waitFor, waitForFunction} from '../../shared/helper.js';
import {describe, it} from '../../shared/mocha-extensions.js';
import {toggleShowCorsErrors} from '../helpers/console-helpers.js';
import {navigateToCssOverviewTab, startCaptureCSSOverview} from '../helpers/css-overview-helpers.js';
import {editCSSProperty, focusElementsTree, navigateToSidePane, waitForContentOfSelectedElementsNode, waitForElementsStyleSection} from '../helpers/elements-helpers.js';
import {openCommandMenu} from '../helpers/quick_open-helpers.js';
import {closeSecurityTab, navigateToSecurityTab} from '../helpers/security-helpers.js';
import {openPanelViaMoreTools, openSettingsTab} from '../helpers/settings-helpers.js';

interface UserMetrics {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Action: {[name: string]: number};
}

interface EnumHistogramEvent {
  actionName: string;
  actionCode: number;
}

interface EnumHistogramEventWithOptionalCode {
  actionName: string;
  actionCode?: number;
}

interface PerformanceHistogramEvent {
  histogramName: string;
  duration: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Window {
    /* eslint-disable @typescript-eslint/naming-convention */
    Host: {
      UserMetrics: UserMetrics,
      userMetrics: {
        actionTaken(name: number): void,
      },
    };
  }
  /* eslint-enable @typescript-eslint/naming-convention */
}

function retrieveRecordedHistogramEvents(frontend: puppeteer.Page): Promise<EnumHistogramEvent[]> {
  // @ts-ignore
  return frontend.evaluate(() => window.InspectorFrontendHost.recordedEnumeratedHistograms);
}

function retrieveRecordedPerformanceHistogramEvents(frontend: puppeteer.Page): Promise<PerformanceHistogramEvent[]> {
  // @ts-ignore
  return frontend.evaluate(() => window.InspectorFrontendHost.recordedPerformanceHistograms);
}

async function assertHistogramEventsInclude(expected: EnumHistogramEvent[]) {
  const {frontend} = getBrowserAndPages();
  const events = await retrieveRecordedHistogramEvents(frontend);

  assert.includeDeepMembers(events, expected);
}

async function waitForHistogramEvent(expected: EnumHistogramEventWithOptionalCode) {
  const {frontend} = getBrowserAndPages();
  await waitForFunction(async () => {
    const events = await retrieveRecordedHistogramEvents(frontend);
    return events.find(
        e => e.actionName === expected.actionName && (!('value' in expected) || e.actionCode === expected.actionCode));
  });
}

describe('User Metrics', () => {
  it('dispatches dock and undock events', async () => {
    const {frontend} = getBrowserAndPages();
    await frontend.evaluate(() => {
      self.Host.userMetrics.actionTaken(self.Host.UserMetrics.Action.WindowDocked);
      self.Host.userMetrics.actionTaken(self.Host.UserMetrics.Action.WindowUndocked);
    });
    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 1,  // WindowDocked.
      },
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 2,  // WindowUndocked.
      },
    ]);
  });

  it('dispatches a metric event the console drawer', async () => {
    const {frontend} = getBrowserAndPages();

    await frontend.keyboard.press('Escape');
    await frontend.waitForSelector('.console-view');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 10,  // drawer-console-view.
      },
      {
        actionName: 'DevTools.KeyboardShortcutFired',
        actionCode: 17,  // main.toggle-drawer
      },
    ]);
  });

  it('dispatches a metric event for show CORS errors console settings', async () => {
    const {frontend} = getBrowserAndPages();

    await frontend.keyboard.press('Escape');
    await frontend.waitForSelector('.console-view');
    await toggleShowCorsErrors();
    await toggleShowCorsErrors();

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 10,  // drawer-console-view.
      },
      {
        actionName: 'DevTools.ConsoleShowsCorsErrors',
        actionCode: 0,  // disabled
      },
      {
        actionName: 'DevTools.ConsoleShowsCorsErrors',
        actionCode: 1,  // enabled
      },
    ]);
  });

  it('dispatches events for views', async () => {
    const {frontend} = getBrowserAndPages();

    // Head to the Timeline tab.
    await click('#tab-timeline');
    await frontend.waitForSelector('.timeline');

    await assertHistogramEventsInclude([{
      actionName: 'DevTools.PanelShown',
      actionCode: 5,  // Timeline.
    }]);
  });

  it('dispatches events for triple dot items', async () => {
    await openPanelViaMoreTools('Animations');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 10,  // 'console-view'.
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 11,  // 'animations'.
      },
    ]);
  });

  it('dispatches events for opening issues drawer via hamburger menu', async () => {
    await openPanelViaMoreTools('Issues');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssuesPanelOpenedFrom',
        actionCode: 3,  // 'HamburgerMenu'.
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 10,  // 'console-view'.
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 37,  // 'issues-pane'.
      },
    ]);
  });

  it('dispatches event when opening issues drawer via command menu', async () => {
    await openCommandMenu();
    await typeText('issues');
    await waitFor('.filtered-list-widget-title');
    await pressKey('Enter');
    await waitFor('[aria-label="Issues panel"]');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssuesPanelOpenedFrom',
        actionCode: 5,  // CommandMenu
      },
    ]);
  });

  it('dispatches an event when F1 is used to open settings', async () => {
    const {frontend} = getBrowserAndPages();

    await frontend.keyboard.press('F1');
    await waitFor('.settings-window-main');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 29,
      },
      {
        actionName: 'DevTools.KeyboardShortcutFired',
        actionCode: 22,  // settings.show
      },
    ]);
  });

  it('dispatches an event when Ctrl/Meta+F8 is used to deactivate breakpoints', async () => {
    const {frontend} = getBrowserAndPages();

    await click('#tab-sources');
    await waitFor('#sources-panel-sources-view');

    switch (platform) {
      case 'mac':
        await frontend.keyboard.down('Meta');
        break;

      case 'linux':
      case 'win32':
        await frontend.keyboard.down('Control');
        break;
    }

    await frontend.keyboard.press('F8');

    switch (platform) {
      case 'mac':
        await frontend.keyboard.up('Meta');
        break;

      case 'linux':
      case 'win32':
        await frontend.keyboard.up('Control');
        break;
    }

    await waitFor('[aria-label="Activate breakpoints"]');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 4,  // sources
      },
      {
        actionName: 'DevTools.KeyboardShortcutFired',
        actionCode: 35,  // debugger.toggle-breakpoints-active
      },
    ]);
  });

  it('dispatches an event when the keybindSet setting is changed', async () => {
    const {frontend} = getBrowserAndPages();

    await frontend.keyboard.press('F1');
    await waitFor('.settings-window-main');
    await click('[aria-label="Shortcuts"]');
    await waitFor('.keybinds-set-select');

    const keybindSetSelect = await $('.keybinds-set-select select') as puppeteer.ElementHandle<HTMLSelectElement>;
    keybindSetSelect.select('vsCode');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 29,  // settings-preferences
      },
      {
        actionName: 'DevTools.KeyboardShortcutFired',
        actionCode: 22,  // settings.show
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 38,  // settings-keybinds
      },
      {
        actionName: 'DevTools.KeybindSetSettingChanged',
        actionCode: 1,  // vsCode
      },
    ]);
  });

  it('dispatches closed panel events for views', async () => {
    // Focus and close a tab
    await navigateToSecurityTab();
    await closeSecurityTab();

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 16,  // Security
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 1,
      },
      {
        actionName: 'DevTools.PanelClosed',
        actionCode: 16,  // Security
      },
    ]);
  });

  it('dispatches an event when experiments are enabled and disabled', async () => {
    await openSettingsTab('Experiments');
    const customThemeCheckbox = await waitFor('[aria-label="Allow extensions to load custom stylesheets"]');
    // Enable the experiment
    await customThemeCheckbox.click();
    // Disable the experiment
    await customThemeCheckbox.click();

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 29,  // settings-preferences
      },
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 31,  // Experiments
      },
      {
        actionName: 'DevTools.ExperimentEnabled',
        actionCode: 0,  // Allow extensions to load custom stylesheets
      },
      {
        actionName: 'DevTools.ExperimentDisabled',
        actionCode: 0,  // Allow extensions to load custom stylesheets
      },
    ]);
  });

  it('tracks panel loading', async () => {
    // We specify the selected panel here because the default behavior is to go to the
    // elements panel, but this means we won't get the PanelLoaded event. Instead we
    // request that the resetPages helper sets the timeline as the target panel, and
    // we wait for the timeline in the test. This means, in turn, we get the PanelLoaded
    // event.
    await reloadDevTools({selectedPanel: {name: 'timeline'}});
    const {frontend} = getBrowserAndPages();

    await waitFor('.timeline');

    const events = await retrieveRecordedPerformanceHistogramEvents(frontend);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].histogramName, 'DevTools.Launch.Timeline');
  });

  it('records the selected language', async () => {
    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.Language',
        actionCode: 17,  // en-US
      },
    ]);
  });

  it('records the sync setting', async () => {
    await assertHistogramEventsInclude([{
      actionName: 'DevTools.SyncSetting',
      actionCode: 1,  // Chrome Sync is disabled
    }]);
  });
});

describe('User Metrics for CSS Overview', () => {
  it('dispatch events when capture overview button hit', async () => {
    await goToResource('css_overview/default.html');
    await navigateToCssOverviewTab();

    await startCaptureCSSOverview();

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.PanelShown',
        actionCode: 39,  // cssoverview
      },
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 41,  // CaptureCssOverviewClicked
      },
    ]);
  });
});

describe('User Metrics for sidebar panes', () => {
  it('dispatches sidebar panes events for navigating Elements Panel sidebar panes', async () => {
    await navigateToSidePane('Computed');
    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.SidebarPaneShown',
        actionCode: 2,  // Computed
      },
    ]);
  });

  it('should not dispatch sidebar panes events for navigating to the same pane', async () => {
    await navigateToSidePane('Styles');

    const {frontend} = getBrowserAndPages();
    const events = await retrieveRecordedHistogramEvents(frontend);
    const eventNames = events.map(event => event.actionName);

    assert.notInclude(eventNames, 'DevTools.SidebarPaneShown');
  });
});

describe('User Metrics for Issue Panel', () => {
  beforeEach(async () => {
    await enableExperiment('contrastIssues');
    await openPanelViaMoreTools('Issues');
  });

  it('dispatch events when issue is expanded', async () => {
    await goToResource('host/cookie-issue.html');
    await waitFor('.issue');

    await click('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 15,  // CookieIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 15,  // CookieIssue
      },
      {
        actionName: 'DevTools.IssuesPanelIssueExpanded',
        actionCode: 2,  // SameSiteCookie
      },
    ]);
  });

  it('dispatches an event when a LowTextContrastIssue is created', async () => {
    await goToResource('elements/low-contrast.html');
    await waitFor('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 41,  // LowTextContrastIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 41,  // LowTextContrastIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 41,  // LowTextContrastIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 41,  // LowTextContrastIssue
      },
    ]);
  });

  it('dispatches an event when a SharedArrayBufferIssue is created', async () => {
    await goToResource('issues/sab-issue.rawresponse');
    await waitFor('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 37,  // SharedArrayBufferIssue::CreationIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 60,  // DeprecationIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 36,  // SharedArrayBufferIssue::TransferIssue
      },
    ]);
  });

  it('dispatch events when a link to an element is clicked', async () => {
    await goToResource('elements/element-reveal-inline-issue.html');
    await waitFor('.issue');
    await click('.issue');

    await waitFor('.element-reveal-icon');
    await scrollElementIntoView('.element-reveal-icon');
    await click('.element-reveal-icon');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 1,  // ContentSecurityPolicyIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 1,  // ContentSecurityPolicyIssue
      },
      {
        actionName: 'DevTools.IssuesPanelIssueExpanded',
        actionCode: 4,  // ContentSecurityPolicy
      },
      {
        actionName: 'DevTools.IssuesPanelResourceOpened',
        actionCode: 7,  // ContentSecurityPolicyElement
      },
    ]);
  });

  it('dispatch events when a "Learn More" link is clicked', async () => {
    await goToResource('elements/element-reveal-inline-issue.html');
    await waitFor('.issue');
    await click('.issue');

    await waitFor('.link-list x-link');
    await scrollElementIntoView('.link-list x-link');
    await click('.link-list x-link');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 1,  // ContentSecurityPolicyIssue
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 1,  // ContentSecurityPolicyIssue
      },
      {
        actionName: 'DevTools.IssuesPanelIssueExpanded',
        actionCode: 4,  // ContentSecurityPolicy
      },
      {
        actionName: 'DevTools.IssuesPanelResourceOpened',
        actionCode: 12,  // ContentSecurityPolicyLearnMore
      },
    ]);
  });

  it('dispatches events when Quirks Mode issues are created', async () => {
    await goToResource('elements/quirks-mode-iframes.html');
    await waitFor('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 58,  // QuirksModeIssue::QuirksMode
      },
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 59,  // QuirksModeIssue::LimitedQuirksMode
      },
    ]);
  });

  it('dispatches an event when a Client Hints are used with invalid origin', async () => {
    await goToResource('issues/client-hint-issue-MetaTagAllowListInvalidOrigin.html');
    await waitFor('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 61,  // ClientHintIssue::MetaTagAllowListInvalidOrigin
      },
    ]);
  });

  it('dispatches an event when a Client Hints are modified by javascript', async () => {
    await goToResource('issues/client-hint-issue-MetaTagModifiedHTML.html');
    await waitFor('.issue');

    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.IssueCreated',
        actionCode: 62,  // ClientHintIssue::MetaTagModifiedHTML
      },
    ]);
  });
});

describe('User Metrics for CSS custom properties in the Styles pane', () => {
  beforeEach(async () => {
    await goToResource('elements/css-variables.html');
    await navigateToSidePane('Styles');
    await waitForElementsStyleSection();
    await waitForContentOfSelectedElementsNode('<body>\u200B');
    await focusElementsTree();
  });

  it('dispatch events when capture overview button hit', async () => {
    const {frontend} = getBrowserAndPages();
    await frontend.keyboard.press('ArrowRight');
    await waitForContentOfSelectedElementsNode('<div id=\u200B"properties-to-inspect">\u200B</div>\u200B');

    await click('.css-var-link');
    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 47,  // CustomPropertyLinkClicked
      },
    ]);
  });

  it('dispatch events when a custom property value is edited', async () => {
    await editCSSProperty('body, body', '--color', '#f06');
    await assertHistogramEventsInclude([
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 14,  // StyleRuleEdited
      },
      {
        actionName: 'DevTools.ActionTaken',
        actionCode: 48,  // CustomPropertyEdited
      },
    ]);
  });
});

describe('User Metrics for the Page Resource Loader', () => {
  it('dispatches an event when a source map is loaded', async () => {
    await goToResource('sources/script-with-sourcemap-without-mappings.html');
    await waitForHistogramEvent(
        {
          actionName: 'DevTools.DeveloperResourceLoaded',
          actionCode: 0,  // LoadThroughPageViaTarget
        },
    );
    await waitForHistogramEvent(
        {
          actionName: 'DevTools.DeveloperResourceScheme',
        },
    );
  });
});
