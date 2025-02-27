// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Root from '../../core/root/root.js';
import * as Diff from '../../third_party/diff/diff.js';
import * as DiffView from '../../ui/components/diff_view/diff_view.js';
import * as UI from '../../ui/legacy/legacy.js';

import changesViewStyles from './changesView.css.js';

import type * as Workspace from '../../models/workspace/workspace.js';
import * as WorkspaceDiff from '../../models/workspace_diff/workspace_diff.js';

import {ChangesSidebar, Events} from './ChangesSidebar.js';

const UIStrings = {
  /**
  *@description Screen reader/tooltip label for a button in the Changes tool that reverts all changes to the currently open file.
  */
  revertAllChangesToCurrentFile: 'Revert all changes to current file',
  /**
  *@description Text in Changes View of the Changes tab
  */
  noChanges: 'No changes',
  /**
  *@description Text in Changes View of the Changes tab
  */
  binaryData: 'Binary data',
  /**
  * @description Text in the Changes tab that indicates how many lines of code have changed in the
  * selected file. An insertion refers to an added line of code. The (+) is a visual cue to indicate
  * lines were added (not translatable).
  */
  sInsertions: '{n, plural, =1 {# insertion (+)} other {# insertions (+)}}',
  /**
  * @description Text in the Changes tab that indicates how many lines of code have changed in the
  * selected file. A deletion refers to a removed line of code. The (-) is a visual cue to indicate
  * lines were removed (not translatable).
  */
  sDeletions: '{n, plural, =1 {# deletion (-)} other {# deletions (-)}}',
};
const str_ = i18n.i18n.registerUIStrings('panels/changes/ChangesView.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

function diffStats(diff: Diff.Diff.DiffArray): string {
  const insertions =
      diff.reduce((ins, token) => ins + (token[0] === Diff.Diff.Operation.Insert ? token[1].length : 0), 0);
  const deletions =
      diff.reduce((ins, token) => ins + (token[0] === Diff.Diff.Operation.Delete ? token[1].length : 0), 0);
  const deletionText = i18nString(UIStrings.sDeletions, {n: deletions});
  const insertionText = i18nString(UIStrings.sInsertions, {n: insertions});
  return `${insertionText}, ${deletionText}`;
}

let changesViewInstance: ChangesView;

export class ChangesView extends UI.Widget.VBox {
  private emptyWidget: UI.EmptyWidget.EmptyWidget;
  private readonly workspaceDiff: WorkspaceDiff.WorkspaceDiff.WorkspaceDiffImpl;
  readonly changesSidebar: ChangesSidebar;
  private selectedUISourceCode: Workspace.UISourceCode.UISourceCode|null;
  private readonly diffContainer: HTMLElement;
  private readonly toolbar: UI.Toolbar.Toolbar;
  private readonly diffStats: UI.Toolbar.ToolbarText;
  private readonly diffView: DiffView.DiffView.DiffView;

  private constructor() {
    super(true);

    const splitWidget = new UI.SplitWidget.SplitWidget(true /* vertical */, false /* sidebar on left */);
    const mainWidget = new UI.Widget.Widget();
    splitWidget.setMainWidget(mainWidget);
    splitWidget.show(this.contentElement);

    this.emptyWidget = new UI.EmptyWidget.EmptyWidget('');
    this.emptyWidget.show(mainWidget.element);

    this.workspaceDiff = WorkspaceDiff.WorkspaceDiff.workspaceDiff();
    this.changesSidebar = new ChangesSidebar(this.workspaceDiff);
    this.changesSidebar.addEventListener(Events.SelectedUISourceCodeChanged, this.selectedUISourceCodeChanged, this);
    splitWidget.setSidebarWidget(this.changesSidebar);

    this.selectedUISourceCode = null;

    this.diffContainer = mainWidget.element.createChild('div', 'diff-container');
    UI.ARIAUtils.markAsTabpanel(this.diffContainer);
    this.diffContainer.addEventListener('click', event => this.click(event));

    this.diffView = this.diffContainer.appendChild(new DiffView.DiffView.DiffView());

    this.toolbar = new UI.Toolbar.Toolbar('changes-toolbar', mainWidget.element);
    const revertButton =
        new UI.Toolbar.ToolbarButton(i18nString(UIStrings.revertAllChangesToCurrentFile), 'largeicon-undo');
    revertButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, this.revert.bind(this));
    this.toolbar.appendToolbarItem(revertButton);
    this.diffStats = new UI.Toolbar.ToolbarText('');
    this.toolbar.appendToolbarItem(this.diffStats);
    this.toolbar.setEnabled(false);

    this.hideDiff(i18nString(UIStrings.noChanges));
    this.selectedUISourceCodeChanged();
  }

  static instance(opts: {forceNew: boolean|null} = {forceNew: null}): ChangesView {
    const {forceNew} = opts;
    if (!changesViewInstance || forceNew) {
      changesViewInstance = new ChangesView();
    }

    return changesViewInstance;
  }

  private selectedUISourceCodeChanged(): void {
    this.revealUISourceCode(this.changesSidebar.selectedUISourceCode());
  }

  private revert(): void {
    const uiSourceCode = this.selectedUISourceCode;
    if (!uiSourceCode) {
      return;
    }
    void this.workspaceDiff.revertToOriginal(uiSourceCode);
  }

  private click(event: MouseEvent): void {
    if (!this.selectedUISourceCode) {
      return;
    }
    for (let target: HTMLElement|null = event.target as HTMLElement; target; target = target.parentElement) {
      if (target.classList.contains('diff-line-content')) {
        const number = target.getAttribute('data-line-number');
        if (number) {
          // Unfortunately, caretRangeFromPoint is broken in shadow
          // roots, which makes determining the character offset more
          // work than justified here.
          void Common.Revealer.reveal(this.selectedUISourceCode.uiLocation(Number(number) - 1, 0), false);
          event.consume(true);
        }
        break;
      } else if (target.classList.contains('diff-listing')) {
        break;
      }
    }
  }

  private revealUISourceCode(uiSourceCode: Workspace.UISourceCode.UISourceCode|null): void {
    if (this.selectedUISourceCode === uiSourceCode) {
      return;
    }

    if (this.selectedUISourceCode) {
      this.workspaceDiff.unsubscribeFromDiffChange(this.selectedUISourceCode, this.refreshDiff, this);
    }
    if (uiSourceCode && this.isShowing()) {
      this.workspaceDiff.subscribeToDiffChange(uiSourceCode, this.refreshDiff, this);
    }

    this.selectedUISourceCode = uiSourceCode;
    void this.refreshDiff();
  }

  wasShown(): void {
    void this.refreshDiff();
    this.registerCSSFiles([changesViewStyles]);
  }

  private async refreshDiff(): Promise<void> {
    if (!this.isShowing()) {
      return;
    }

    if (!this.selectedUISourceCode) {
      this.renderDiffRows();
      return;
    }
    const uiSourceCode = this.selectedUISourceCode;
    if (!uiSourceCode.contentType().isTextType()) {
      this.hideDiff(i18nString(UIStrings.binaryData));
      return;
    }
    const diffResponse = await this.workspaceDiff.requestDiff(
        uiSourceCode, {shouldFormatDiff: Root.Runtime.experiments.isEnabled('preciseChanges')});
    if (this.selectedUISourceCode !== uiSourceCode) {
      return;
    }
    this.renderDiffRows(diffResponse?.diff);
  }

  private hideDiff(message: string): void {
    this.diffStats.setText('');
    this.toolbar.setEnabled(false);
    this.diffContainer.style.display = 'none';
    this.emptyWidget.text = message;
    this.emptyWidget.showWidget();
  }

  private renderDiffRows(diff?: Diff.Diff.DiffArray): void {
    if (!diff || (diff.length === 1 && diff[0][0] === Diff.Diff.Operation.Equal)) {
      this.hideDiff(i18nString(UIStrings.noChanges));
    } else {
      this.diffStats.setText(diffStats(diff));
      this.toolbar.setEnabled(true);
      this.emptyWidget.hideWidget();
      const mimeType = (this.selectedUISourceCode as Workspace.UISourceCode.UISourceCode).mimeType();
      this.diffContainer.style.display = 'block';
      this.diffView.data = {diff, mimeType};
    }
  }
}

let diffUILocationRevealerInstance: DiffUILocationRevealer;
export class DiffUILocationRevealer implements Common.Revealer.Revealer {
  static instance(opts: {forceNew: boolean} = {forceNew: false}): DiffUILocationRevealer {
    const {forceNew} = opts;
    if (!diffUILocationRevealerInstance || forceNew) {
      diffUILocationRevealerInstance = new DiffUILocationRevealer();
    }

    return diffUILocationRevealerInstance;
  }

  async reveal(diffUILocation: Object, omitFocus?: boolean|undefined): Promise<void> {
    if (!(diffUILocation instanceof WorkspaceDiff.WorkspaceDiff.DiffUILocation)) {
      throw new Error('Internal error: not a diff ui location');
    }
    await UI.ViewManager.ViewManager.instance().showView('changes.changes');
    ChangesView.instance().changesSidebar.selectUISourceCode(diffUILocation.uiSourceCode, omitFocus);
  }
}
