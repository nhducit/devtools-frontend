// Copyright (c) 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as LitHtml from '../../../ui/lit-html/lit-html.js';
import * as ComponentHelpers from '../helpers/helpers.js';
import type * as TextUtils from '../../../models/text_utils/text_utils.js';
import type {SortState, Column, Row} from './DataGridUtils.js';
import {SortDirection, getRowEntryForColumnId, getStringifiedCellValues} from './DataGridUtils.js';
import type {DataGridData, DataGridContextMenusConfiguration} from './DataGrid.js';
import type {ContextMenuColumnSortClickEvent, ColumnHeaderClickEvent} from './DataGridEvents.js';
import {DataGrid} from './DataGrid.js';
import dataGridControllerStyles from './dataGridController.css.js';

export interface DataGridControllerData {
  columns: Column[];
  rows: Row[];
  filters?: readonly TextUtils.TextUtils.ParsedFilter[];
  /**
   * Sets an initial sort state for the data grid. Is only used if the component
   * hasn't rendered yet. If you pass this in on subsequent renders, it is
   * ignored.
   */
  initialSort?: SortState;
  contextMenus?: DataGridContextMenusConfiguration;
}

export class DataGridController extends HTMLElement {
  static readonly litTagName = LitHtml.literal`devtools-data-grid-controller`;
  readonly #shadow = this.attachShadow({mode: 'open'});

  #hasRenderedAtLeastOnce = false;
  #columns: readonly Column[] = [];
  #rows: Row[] = [];
  #contextMenus?: DataGridContextMenusConfiguration = undefined;

  /**
   * Because the controller will sort data in place (e.g. mutate it) when we get
   * new data in we store the original data separately. This is so we don't
   * mutate the data we're given, but a copy of the data. If our `get data` is
   * called, we'll return the original, not the sorted data.
   */
  #originalColumns: readonly Column[] = [];
  #originalRows: Row[] = [];

  #sortState: Readonly<SortState>|null = null;
  #filters: readonly TextUtils.TextUtils.ParsedFilter[] = [];

  connectedCallback(): void {
    this.#shadow.adoptedStyleSheets = [dataGridControllerStyles];
  }

  get data(): DataGridControllerData {
    return {
      columns: this.#originalColumns as Column[],
      rows: this.#originalRows as Row[],
      filters: this.#filters,
      contextMenus: this.#contextMenus,
    };
  }

  set data(data: DataGridControllerData) {
    this.#originalColumns = data.columns;
    this.#originalRows = data.rows;
    this.#contextMenus = data.contextMenus;
    this.#filters = data.filters || [];
    this.#contextMenus = data.contextMenus;

    this.#columns = [...this.#originalColumns];
    this.#rows = this.#cloneAndFilterRows(data.rows, this.#filters);

    if (!this.#hasRenderedAtLeastOnce && data.initialSort) {
      this.#sortState = data.initialSort;
    }

    if (this.#sortState) {
      this.#sortRows(this.#sortState);
    }

    this.#render();
  }

  #testRowWithFilter(row: Row, filter: TextUtils.TextUtils.ParsedFilter): boolean {
    let rowMatchesFilter = false;

    const {key, text, negative, regex} = filter;

    let dataToTest;
    if (key) {
      dataToTest = getStringifiedCellValues([getRowEntryForColumnId(row, key)]);
    } else {
      dataToTest = getStringifiedCellValues(row.cells);
    }

    if (regex) {
      rowMatchesFilter = regex.test(dataToTest);
    } else if (text) {
      rowMatchesFilter = dataToTest.includes(text.toLowerCase());
    }

    // If `negative` is set to `true`, that means we have to flip the final
    // result, because the filter is matching anything that doesn't match. e.g.
    // {text: 'foo', negative: false} matches rows that contain the text `foo`
    // but {text: 'foo', negative: true} matches rows that do NOT contain the
    // text `foo` so if a filter is marked as negative, we first match against
    // that filter, and then we flip it here.
    return negative ? !rowMatchesFilter : rowMatchesFilter;
  }

  #cloneAndFilterRows(rows: Row[], filters: readonly TextUtils.TextUtils.ParsedFilter[]): Row[] {
    if (filters.length === 0) {
      return [...rows];
    }

    return rows.map(row => {
      // We assume that the row should be visible by default.
      let rowShouldBeVisible = true;
      for (const filter of filters) {
        const rowMatchesFilter = this.#testRowWithFilter(row, filter);
        // If there are multiple filters, if any return false we hide the row.
        // So if we get a false from testRowWithFilter, we can break early and return false.
        if (!rowMatchesFilter) {
          rowShouldBeVisible = false;
          break;
        }
      }
      return {
        ...row,
        hidden: !rowShouldBeVisible,
      };
    });
  }

  #sortRows(state: SortState): void {
    const {columnId, direction} = state;

    this.#rows.sort((row1, row2) => {
      const cell1 = getRowEntryForColumnId(row1, columnId);
      const cell2 = getRowEntryForColumnId(row2, columnId);

      const value1 = typeof cell1.value === 'number' ? cell1.value : String(cell1.value).toUpperCase();
      const value2 = typeof cell2.value === 'number' ? cell2.value : String(cell2.value).toUpperCase();
      if (value1 < value2) {
        return direction === SortDirection.ASC ? -1 : 1;
      }
      if (value1 > value2) {
        return direction === SortDirection.ASC ? 1 : -1;
      }
      return 0;
    });
    this.#render();
  }

  #onColumnHeaderClick(event: ColumnHeaderClickEvent): void {
    const {column} = event.data;
    this.#applySortOnColumn(column);
  }

  #applySortOnColumn(column: Column): void {
    if (this.#sortState && this.#sortState.columnId === column.id) {
      const {columnId, direction} = this.#sortState;

      /* When users sort, we go No Sort => ASC => DESC => No sort
       * So if the current direction is DESC, we clear the state.
       */
      if (direction === SortDirection.DESC) {
        this.#sortState = null;
      } else {
        /* The state is ASC, so toggle to DESC */
        this.#sortState = {
          columnId,
          direction: SortDirection.DESC,
        };
      }
    } else {
      /* The column wasn't previously sorted, so we sort it in ASC order. */
      this.#sortState = {
        columnId: column.id,
        direction: SortDirection.ASC,
      };
    }

    if (this.#sortState) {
      this.#sortRows(this.#sortState);
    } else {
      // No sortstate = render the original rows.
      this.#rows = this.#cloneAndFilterRows(this.#originalRows, this.#filters);
      this.#render();
    }
  }

  #onContextMenuColumnSortClick(event: ContextMenuColumnSortClickEvent): void {
    this.#applySortOnColumn(event.data.column);
  }

  #onContextMenuHeaderResetClick(): void {
    this.#sortState = null;
    this.#rows = [...this.#originalRows];
    this.#render();
  }

  #render(): void {
    // Disabled until https://crbug.com/1079231 is fixed.
    // clang-format off
    LitHtml.render(LitHtml.html`
      <${DataGrid.litTagName} .data=${{
          columns: this.#columns,
          rows: this.#rows,
          activeSort: this.#sortState,
          contextMenus: this.#contextMenus,
        } as DataGridData}
        @columnheaderclick=${this.#onColumnHeaderClick}
        @contextmenucolumnsortclick=${this.#onContextMenuColumnSortClick}
        @contextmenuheaderresetclick=${this.#onContextMenuHeaderResetClick}
     ></${DataGrid.litTagName}>
    `, this.#shadow, {
      host: this,
    });
    // clang-format on
    this.#hasRenderedAtLeastOnce = true;
  }
}

ComponentHelpers.CustomElements.defineComponent('devtools-data-grid-controller', DataGridController);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLElementTagNameMap {
    'devtools-data-grid-controller': DataGridController;
  }
}
