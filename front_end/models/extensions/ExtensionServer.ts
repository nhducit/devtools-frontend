/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration
/* eslint-disable @typescript-eslint/naming-convention */

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as Platform from '../../core/platform/platform.js';
import * as _ProtocolClient from '../../core/protocol_client/protocol_client.js';  // eslint-disable-line @typescript-eslint/no-unused-vars
import * as Root from '../../core/root/root.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Logs from '../../models/logs/logs.js';
import * as Components from '../../ui/legacy/components/utils/utils.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as ThemeSupport from '../../ui/legacy/theme_support/theme_support.js';
import * as Bindings from '../bindings/bindings.js';
import * as HAR from '../har/har.js';
import type * as TextUtils from '../text_utils/text_utils.js';
import * as Workspace from '../workspace/workspace.js';
import type * as Protocol from '../../generated/protocol.js';

import {ExtensionButton, ExtensionPanel, ExtensionSidebarPane} from './ExtensionPanel.js';
import type {TracingSession} from './ExtensionTraceProvider.js';
import {ExtensionTraceProvider} from './ExtensionTraceProvider.js';
import {LanguageExtensionEndpoint} from './LanguageExtensionEndpoint.js';
import {PrivateAPI} from './ExtensionAPI.js';

const extensionOrigins: WeakMap<MessagePort, string> = new WeakMap();

declare global {
  interface Window {
    DevToolsAPI?: {getInspectedTabId?(): string|undefined, getOriginsForbiddenForExtensions?(): string[]};
  }
}

const kAllowedOrigins = [
  'chrome://newtab',
  'chrome://new-tab-page',
].map(url => (new URL(url)).origin);

let extensionServerInstance: ExtensionServer|null;

export class ExtensionServer extends Common.ObjectWrapper.ObjectWrapper<EventTypes> {
  private readonly clientObjects: Map<string, unknown>;
  private readonly handlers:
      Map<string, (message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort) => unknown>;
  private readonly subscribers: Map<string, Set<MessagePort>>;
  private readonly subscriptionStartHandlers: Map<string, () => unknown>;
  private readonly subscriptionStopHandlers: Map<string, () => unknown>;
  private readonly extraHeaders: Map<string, Map<string, unknown>>;
  private requests: Map<number, TextUtils.ContentProvider.ContentProvider>;
  private readonly requestIds: Map<TextUtils.ContentProvider.ContentProvider, number>;
  private lastRequestId: number;
  private registeredExtensions: Map<string, {
    name: string,
  }>;
  private status: ExtensionStatus;
  private readonly sidebarPanesInternal: ExtensionSidebarPane[];
  private readonly traceProvidersInternal: ExtensionTraceProvider[];
  private readonly traceSessions: Map<string, TracingSession>;
  private extensionsEnabled: boolean;
  private inspectedTabId?: string;
  private readonly extensionAPITestHook?: (server: unknown, api: unknown) => unknown;
  private themeChangeHandlers: Map<string, MessagePort> = new Map();

  private constructor() {
    super();
    this.clientObjects = new Map();
    this.handlers = new Map();
    this.subscribers = new Map();
    this.subscriptionStartHandlers = new Map();
    this.subscriptionStopHandlers = new Map();
    this.extraHeaders = new Map();
    this.requests = new Map();
    this.requestIds = new Map();
    this.lastRequestId = 0;
    this.registeredExtensions = new Map();
    this.status = new ExtensionStatus();
    this.sidebarPanesInternal = [];
    this.traceProvidersInternal = [];
    this.traceSessions = new Map();
    // TODO(caseq): properly unload extensions when we disable them.
    this.extensionsEnabled = true;

    this.registerHandler(PrivateAPI.Commands.AddRequestHeaders, this.onAddRequestHeaders.bind(this));
    this.registerHandler(PrivateAPI.Commands.AddTraceProvider, this.onAddTraceProvider.bind(this));
    this.registerHandler(PrivateAPI.Commands.ApplyStyleSheet, this.onApplyStyleSheet.bind(this));
    this.registerHandler(PrivateAPI.Commands.CompleteTraceSession, this.onCompleteTraceSession.bind(this));
    this.registerHandler(PrivateAPI.Commands.CreatePanel, this.onCreatePanel.bind(this));
    this.registerHandler(PrivateAPI.Commands.CreateSidebarPane, this.onCreateSidebarPane.bind(this));
    this.registerHandler(PrivateAPI.Commands.CreateToolbarButton, this.onCreateToolbarButton.bind(this));
    this.registerHandler(PrivateAPI.Commands.EvaluateOnInspectedPage, this.onEvaluateOnInspectedPage.bind(this));
    this.registerHandler(PrivateAPI.Commands.ForwardKeyboardEvent, this.onForwardKeyboardEvent.bind(this));
    this.registerHandler(PrivateAPI.Commands.GetHAR, this.onGetHAR.bind(this));
    this.registerHandler(PrivateAPI.Commands.GetPageResources, this.onGetPageResources.bind(this));
    this.registerHandler(PrivateAPI.Commands.GetRequestContent, this.onGetRequestContent.bind(this));
    this.registerHandler(PrivateAPI.Commands.GetResourceContent, this.onGetResourceContent.bind(this));
    this.registerHandler(PrivateAPI.Commands.Reload, this.onReload.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetOpenResourceHandler, this.onSetOpenResourceHandler.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetThemeChangeHandler, this.onSetThemeChangeHandler.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetResourceContent, this.onSetResourceContent.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetSidebarHeight, this.onSetSidebarHeight.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetSidebarContent, this.onSetSidebarContent.bind(this));
    this.registerHandler(PrivateAPI.Commands.SetSidebarPage, this.onSetSidebarPage.bind(this));
    this.registerHandler(PrivateAPI.Commands.ShowPanel, this.onShowPanel.bind(this));
    this.registerHandler(PrivateAPI.Commands.Subscribe, this.onSubscribe.bind(this));
    this.registerHandler(PrivateAPI.Commands.OpenResource, this.onOpenResource.bind(this));
    this.registerHandler(PrivateAPI.Commands.Unsubscribe, this.onUnsubscribe.bind(this));
    this.registerHandler(PrivateAPI.Commands.UpdateButton, this.onUpdateButton.bind(this));
    this.registerHandler(
        PrivateAPI.Commands.RegisterLanguageExtensionPlugin, this.registerLanguageExtensionEndpoint.bind(this));
    window.addEventListener('message', this.onWindowMessage.bind(this), false);  // Only for main window.

    const existingTabId =
        window.DevToolsAPI && window.DevToolsAPI.getInspectedTabId && window.DevToolsAPI.getInspectedTabId();

    if (existingTabId) {
      this.setInspectedTabId({data: existingTabId});
    }
    Host.InspectorFrontendHost.InspectorFrontendHostInstance.events.addEventListener(
        Host.InspectorFrontendHostAPI.Events.SetInspectedTabId, this.setInspectedTabId, this);

    this.initExtensions();

    ThemeSupport.ThemeSupport.instance().addEventListener(ThemeSupport.ThemeChangeEvent.eventName, () => {
      const themeName = ThemeSupport.ThemeSupport.instance().themeName();
      for (const port of this.themeChangeHandlers.values()) {
        port.postMessage({command: PrivateAPI.Events.ThemeChange, themeName});
      }
    });
  }

  static instance(opts: {
    forceNew: boolean|null,
  } = {forceNew: null}): ExtensionServer {
    const {forceNew} = opts;
    if (!extensionServerInstance || forceNew) {
      extensionServerInstance = new ExtensionServer();
    }

    return extensionServerInstance;
  }

  initializeExtensions(): void {
    // Defer initialization until DevTools is fully loaded.
    if (this.inspectedTabId !== null) {
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.setAddExtensionCallback(this.addExtension.bind(this));
    }
  }

  hasExtensions(): boolean {
    return Boolean(this.registeredExtensions.size);
  }

  notifySearchAction(panelId: string, action: string, searchString?: string): void {
    this.postNotification(PrivateAPI.Events.PanelSearch + panelId, action, searchString);
  }

  notifyViewShown(identifier: string, frameIndex?: number): void {
    this.postNotification(PrivateAPI.Events.ViewShown + identifier, frameIndex);
  }

  notifyViewHidden(identifier: string): void {
    this.postNotification(PrivateAPI.Events.ViewHidden + identifier);
  }

  notifyButtonClicked(identifier: string): void {
    this.postNotification(PrivateAPI.Events.ButtonClicked + identifier);
  }

  private registerLanguageExtensionEndpoint(
      message: PrivateAPI.ExtensionServerRequestMessage, _shared_port: MessagePort): Record {
    if (message.command !== PrivateAPI.Commands.RegisterLanguageExtensionPlugin) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.Subscribe}`);
    }
    const {pluginManager} = Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance();
    if (!pluginManager) {
      return this.status.E_FAILED('WebAssembly DWARF support needs to be enabled to use this extension');
    }

    const {pluginName, port, supportedScriptTypes: {language, symbol_types}} = message;
    const symbol_types_array =
        (Array.isArray(symbol_types) && symbol_types.every(e => typeof e === 'string') ? symbol_types : []);
    const endpoint = new LanguageExtensionEndpoint(pluginName, {language, symbol_types: symbol_types_array}, port);
    pluginManager.addPlugin(endpoint);
    return this.status.OK();
  }

  private inspectedURLChanged(event: Common.EventTarget.EventTargetEvent<SDK.Target.Target>): void {
    if (!this.canInspectURL(event.data.inspectedURL())) {
      this.disableExtensions();
      return;
    }
    if (event.data !== SDK.TargetManager.TargetManager.instance().mainTarget()) {
      return;
    }
    this.requests = new Map();
    const url = event.data.inspectedURL();
    this.postNotification(PrivateAPI.Events.InspectedURLChanged, url);
  }

  startTraceRecording(providerId: string, sessionId: string, session: TracingSession): void {
    this.traceSessions.set(sessionId, session);
    this.postNotification('trace-recording-started-' + providerId, sessionId);
  }

  stopTraceRecording(providerId: string): void {
    this.postNotification('trace-recording-stopped-' + providerId);
  }

  hasSubscribers(type: string): boolean {
    return this.subscribers.has(type);
  }

  private postNotification(type: string, ..._vararg: unknown[]): void {
    if (!this.extensionsEnabled) {
      return;
    }
    const subscribers = this.subscribers.get(type);
    if (!subscribers) {
      return;
    }
    const message = {command: 'notify-' + type, arguments: Array.prototype.slice.call(arguments, 1)};
    for (const subscriber of subscribers) {
      subscriber.postMessage(message);
    }
  }

  private onSubscribe(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.Subscribe) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.Subscribe}`);
    }
    const subscribers = this.subscribers.get(message.type);
    if (subscribers) {
      subscribers.add(port);
    } else {
      this.subscribers.set(message.type, new Set([port]));
      const handler = this.subscriptionStartHandlers.get(message.type);
      if (handler) {
        handler();
      }
    }
    return undefined;
  }

  private onUnsubscribe(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.Unsubscribe) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.Unsubscribe}`);
    }
    const subscribers = this.subscribers.get(message.type);
    if (!subscribers) {
      return;
    }
    subscribers.delete(port);
    if (!subscribers.size) {
      this.subscribers.delete(message.type);
      const handler = this.subscriptionStopHandlers.get(message.type);
      if (handler) {
        handler();
      }
    }
    return undefined;
  }

  private onAddRequestHeaders(message: PrivateAPI.ExtensionServerRequestMessage): Record|undefined {
    if (message.command !== PrivateAPI.Commands.AddRequestHeaders) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.AddRequestHeaders}`);
    }
    const id = message.extensionId;
    if (typeof id !== 'string') {
      return this.status.E_BADARGTYPE('extensionId', typeof id, 'string');
    }
    let extensionHeaders = this.extraHeaders.get(id);
    if (!extensionHeaders) {
      extensionHeaders = new Map();
      this.extraHeaders.set(id, extensionHeaders);
    }
    for (const name in message.headers) {
      extensionHeaders.set(name, message.headers[name]);
    }
    const allHeaders = ({} as Protocol.Network.Headers);
    for (const headers of this.extraHeaders.values()) {
      for (const [name, value] of headers) {
        if (name !== '__proto__' && typeof value === 'string') {
          allHeaders[name] = value;
        }
      }
    }

    SDK.NetworkManager.MultitargetNetworkManager.instance().setExtraHTTPHeaders(allHeaders);
    return undefined;
  }

  private onApplyStyleSheet(message: PrivateAPI.ExtensionServerRequestMessage): Record|undefined {
    if (message.command !== PrivateAPI.Commands.ApplyStyleSheet) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.ApplyStyleSheet}`);
    }
    if (!Root.Runtime.experiments.isEnabled('applyCustomStylesheet')) {
      return;
    }

    const styleSheet = document.createElement('style');
    styleSheet.textContent = message.styleSheet;
    document.head.appendChild(styleSheet);

    ThemeSupport.ThemeSupport.instance().addCustomStylesheet(message.styleSheet);
    // Add to all the shadow roots that have already been created
    for (let node: (Node|null)|HTMLElement = document.body; node; node = node.traverseNextNode(document.body)) {
      if (node instanceof ShadowRoot) {
        ThemeSupport.ThemeSupport.instance().injectCustomStyleSheets(node);
      }
    }
    return undefined;
  }

  private getExtensionOrigin(port: MessagePort): string {
    const origin = extensionOrigins.get(port);
    if (!origin) {
      throw new Error('Received a message from an unregistered extension');
    }
    return origin;
  }

  private onCreatePanel(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record {
    if (message.command !== PrivateAPI.Commands.CreatePanel) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.CreatePanel}`);
    }
    const id = message.id;
    // The ids are generated on the client API side and must be unique, so the check below
    // shouldn't be hit unless someone is bypassing the API.
    if (this.clientObjects.has(id) || UI.InspectorView.InspectorView.instance().hasPanel(id)) {
      return this.status.E_EXISTS(id);
    }

    const page = this.expandResourcePath(this.getExtensionOrigin(port), message.page) as string;
    let persistentId = this.getExtensionOrigin(port) + message.title;
    persistentId = persistentId.replace(/\s/g, '');
    const panelView =
        new ExtensionServerPanelView(persistentId, message.title, new ExtensionPanel(this, persistentId, id, page));
    this.clientObjects.set(id, panelView);
    UI.InspectorView.InspectorView.instance().addPanel(panelView);
    return this.status.OK();
  }

  private onShowPanel(message: PrivateAPI.ExtensionServerRequestMessage): Record|undefined {
    if (message.command !== PrivateAPI.Commands.ShowPanel) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.ShowPanel}`);
    }

    let panelViewId = message.id;
    const panelView = this.clientObjects.get(message.id);
    if (panelView && panelView instanceof ExtensionServerPanelView) {
      panelViewId = panelView.viewId();
    }
    void UI.InspectorView.InspectorView.instance().showPanel(panelViewId);
    return undefined;
  }

  private onCreateToolbarButton(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record {
    if (message.command !== PrivateAPI.Commands.CreateToolbarButton) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.CreateToolbarButton}`);
    }
    const panelView = this.clientObjects.get(message.panel);
    if (!panelView || !(panelView instanceof ExtensionServerPanelView)) {
      return this.status.E_NOTFOUND(message.panel);
    }
    const button = new ExtensionButton(
        this, message.id, this.expandResourcePath(this.getExtensionOrigin(port), message.icon), message.tooltip,
        message.disabled);
    this.clientObjects.set(message.id, button);

    void panelView.widget().then(appendButton);

    function appendButton(panel: UI.Widget.Widget): void {
      (panel as ExtensionPanel).addToolbarItem(button.toolbarButton());
    }

    return this.status.OK();
  }

  private onUpdateButton(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record {
    if (message.command !== PrivateAPI.Commands.UpdateButton) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.UpdateButton}`);
    }
    const button = this.clientObjects.get(message.id);
    if (!button || !(button instanceof ExtensionButton)) {
      return this.status.E_NOTFOUND(message.id);
    }
    button.update(
        message.icon && this.expandResourcePath(this.getExtensionOrigin(port), message.icon), message.tooltip,
        message.disabled);
    return this.status.OK();
  }

  private onCompleteTraceSession(message: PrivateAPI.ExtensionServerRequestMessage): Record|undefined {
    if (message.command !== PrivateAPI.Commands.CompleteTraceSession) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.CompleteTraceSession}`);
    }
    const session = this.traceSessions.get(message.id);
    if (!session) {
      return this.status.E_NOTFOUND(message.id);
    }
    this.traceSessions.delete(message.id);
    session.complete(message.url, message.timeOffset);
    return undefined;
  }

  private onCreateSidebarPane(message: PrivateAPI.ExtensionServerRequestMessage): Record {
    if (message.command !== PrivateAPI.Commands.CreateSidebarPane) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.CreateSidebarPane}`);
    }
    const id = message.id;
    const sidebar = new ExtensionSidebarPane(this, message.panel, message.title, id);
    this.sidebarPanesInternal.push(sidebar);
    this.clientObjects.set(id, sidebar);
    this.dispatchEventToListeners(Events.SidebarPaneAdded, sidebar);

    return this.status.OK();
  }

  sidebarPanes(): ExtensionSidebarPane[] {
    return this.sidebarPanesInternal;
  }

  private onSetSidebarHeight(message: PrivateAPI.ExtensionServerRequestMessage): Record {
    if (message.command !== PrivateAPI.Commands.SetSidebarHeight) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetSidebarHeight}`);
    }
    const sidebar = this.clientObjects.get(message.id);
    if (!sidebar || !(sidebar instanceof ExtensionSidebarPane)) {
      return this.status.E_NOTFOUND(message.id);
    }
    sidebar.setHeight(message.height);
    return this.status.OK();
  }

  private onSetSidebarContent(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.SetSidebarContent) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetSidebarContent}`);
    }
    const {requestId, id, rootTitle, expression, evaluateOptions, evaluateOnPage} = message;
    const sidebar = this.clientObjects.get(id);
    if (!sidebar || !(sidebar instanceof ExtensionSidebarPane)) {
      return this.status.E_NOTFOUND(message.id);
    }

    function callback(this: ExtensionServer, error: unknown): void {
      const result = error ? this.status.E_FAILED(error) : this.status.OK();
      this.dispatchCallback(requestId, port, result);
    }
    if (evaluateOnPage) {
      sidebar.setExpression(expression, rootTitle, evaluateOptions, this.getExtensionOrigin(port), callback.bind(this));
      return undefined;
    }
    sidebar.setObject(message.expression, message.rootTitle, callback.bind(this));
    return undefined;
  }

  private onSetSidebarPage(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.SetSidebarPage) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetSidebarPage}`);
    }
    const sidebar = this.clientObjects.get(message.id);
    if (!sidebar || !(sidebar instanceof ExtensionSidebarPane)) {
      return this.status.E_NOTFOUND(message.id);
    }
    sidebar.setPage(this.expandResourcePath(this.getExtensionOrigin(port), message.page));
    return undefined;
  }

  private onOpenResource(message: PrivateAPI.ExtensionServerRequestMessage): Record {
    if (message.command !== PrivateAPI.Commands.OpenResource) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.OpenResource}`);
    }
    const uiSourceCode = Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodeForURL(message.url);
    if (uiSourceCode) {
      void Common.Revealer.reveal(uiSourceCode.uiLocation(message.lineNumber, message.columnNumber));
      return this.status.OK();
    }

    const resource = Bindings.ResourceUtils.resourceForURL(message.url);
    if (resource) {
      void Common.Revealer.reveal(resource);
      return this.status.OK();
    }

    const request = Logs.NetworkLog.NetworkLog.instance().requestForURL(message.url);
    if (request) {
      void Common.Revealer.reveal(request);
      return this.status.OK();
    }

    return this.status.E_NOTFOUND(message.url);
  }

  private onSetOpenResourceHandler(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record
      |undefined {
    if (message.command !== PrivateAPI.Commands.SetOpenResourceHandler) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetOpenResourceHandler}`);
    }
    const extension = this.registeredExtensions.get(this.getExtensionOrigin(port));
    if (!extension) {
      throw new Error('Received a message from an unregistered extension');
    }
    const {name} = extension;
    if (message.handlerPresent) {
      Components.Linkifier.Linkifier.registerLinkHandler(name, this.handleOpenURL.bind(this, port));
    } else {
      Components.Linkifier.Linkifier.unregisterLinkHandler(name);
    }
    return undefined;
  }

  private onSetThemeChangeHandler(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record
      |undefined {
    if (message.command !== PrivateAPI.Commands.SetThemeChangeHandler) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetThemeChangeHandler}`);
    }
    const extensionOrigin = this.getExtensionOrigin(port);
    const extension = this.registeredExtensions.get(extensionOrigin);
    if (!extension) {
      throw new Error('Received a message from an unregistered extension');
    }

    if (message.handlerPresent) {
      this.themeChangeHandlers.set(extensionOrigin, port);
    } else {
      this.themeChangeHandlers.delete(extensionOrigin);
    }
    return undefined;
  }

  private handleOpenURL(
      port: MessagePort, contentProvider: TextUtils.ContentProvider.ContentProvider, lineNumber: number): void {
    port.postMessage(
        {command: 'open-resource', resource: this.makeResource(contentProvider), lineNumber: lineNumber + 1});
  }

  private onReload(message: PrivateAPI.ExtensionServerRequestMessage): Record {
    if (message.command !== PrivateAPI.Commands.Reload) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.Reload}`);
    }
    const options = (message.options || {});

    SDK.NetworkManager.MultitargetNetworkManager.instance().setUserAgentOverride(
        typeof options.userAgent === 'string' ? options.userAgent : '', null);
    let injectedScript;
    if (options.injectedScript) {
      injectedScript = '(function(){' + options.injectedScript + '})()';
    }
    SDK.ResourceTreeModel.ResourceTreeModel.reloadAllPages(Boolean(options.ignoreCache), injectedScript);
    return this.status.OK();
  }

  private onEvaluateOnInspectedPage(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record
      |undefined {
    if (message.command !== PrivateAPI.Commands.EvaluateOnInspectedPage) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.EvaluateOnInspectedPage}`);
    }

    const {requestId, expression, evaluateOptions} = message;
    function callback(
        this: ExtensionServer, error: string|null, object: SDK.RemoteObject.RemoteObject|null,
        wasThrown: boolean): void {
      let result;
      if (error || !object) {
        result = this.status.E_PROTOCOLERROR(error?.toString());
      } else if (wasThrown) {
        result = {isException: true, value: object.description};
      } else {
        result = {value: object.value};
      }

      this.dispatchCallback(requestId, port, result);
    }
    return this.evaluate(expression, true, true, evaluateOptions, this.getExtensionOrigin(port), callback.bind(this));
  }

  private async onGetHAR(message: PrivateAPI.ExtensionServerRequestMessage): Promise<Record|HAR.Log.LogDTO> {
    if (message.command !== PrivateAPI.Commands.GetHAR) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.GetHAR}`);
    }
    const requests = Logs.NetworkLog.NetworkLog.instance().requests();
    const harLog = await HAR.Log.Log.build(requests);
    for (let i = 0; i < harLog.entries.length; ++i) {
      // @ts-ignore
      harLog.entries[i]._requestId = this.requestId(requests[i]);
    }
    return harLog;
  }

  private makeResource(contentProvider: TextUtils.ContentProvider.ContentProvider): {
    url: string,
    type: string,
  } {
    return {url: contentProvider.contentURL(), type: contentProvider.contentType().name()};
  }

  private onGetPageResources(): {url: string, type: string}[] {
    const resources = new Map<unknown, {
      url: string,
      type: string,
    }>();

    function pushResourceData(
        this: ExtensionServer, contentProvider: TextUtils.ContentProvider.ContentProvider): boolean {
      if (!resources.has(contentProvider.contentURL())) {
        resources.set(contentProvider.contentURL(), this.makeResource(contentProvider));
      }
      return false;
    }
    let uiSourceCodes = Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodesForProjectType(
        Workspace.Workspace.projectTypes.Network);
    uiSourceCodes = uiSourceCodes.concat(Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodesForProjectType(
        Workspace.Workspace.projectTypes.ContentScripts));
    uiSourceCodes.forEach(pushResourceData.bind(this));
    for (const resourceTreeModel of SDK.TargetManager.TargetManager.instance().models(
             SDK.ResourceTreeModel.ResourceTreeModel)) {
      resourceTreeModel.forAllResources(pushResourceData.bind(this));
    }

    return [...resources.values()];
  }

  private async getResourceContent(
      contentProvider: TextUtils.ContentProvider.ContentProvider, message: PrivateAPI.ExtensionServerRequestMessage,
      port: MessagePort): Promise<void> {
    const {content} = await contentProvider.requestContent();
    const encoded = await contentProvider.contentEncoded();
    this.dispatchCallback(message.requestId, port, {encoding: encoded ? 'base64' : '', content: content});
  }

  private onGetRequestContent(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.GetRequestContent) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.GetRequestContent}`);
    }
    const request = this.requestById(message.id);
    if (!request) {
      return this.status.E_NOTFOUND(message.id);
    }
    void this.getResourceContent(request, message, port);
    return undefined;
  }

  private onGetResourceContent(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.GetResourceContent) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.GetResourceContent}`);
    }
    const url = (message.url as string);
    const contentProvider = Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodeForURL(url) ||
        Bindings.ResourceUtils.resourceForURL(url);
    if (!contentProvider) {
      return this.status.E_NOTFOUND(url);
    }
    void this.getResourceContent(contentProvider, message, port);
    return undefined;
  }

  private onSetResourceContent(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.SetResourceContent) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.SetResourceContent}`);
    }

    const {url, requestId, content, commit} = message;
    function callbackWrapper(this: ExtensionServer, error: string|null): void {
      const response = error ? this.status.E_FAILED(error) : this.status.OK();
      this.dispatchCallback(requestId, port, response);
    }

    const uiSourceCode = Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodeForURL(url);
    if (!uiSourceCode || !uiSourceCode.contentType().isDocumentOrScriptOrStyleSheet()) {
      const resource = SDK.ResourceTreeModel.ResourceTreeModel.resourceForURL(url);
      if (!resource) {
        return this.status.E_NOTFOUND(url);
      }
      return this.status.E_NOTSUPPORTED('Resource is not editable');
    }
    uiSourceCode.setWorkingCopy(content);
    if (commit) {
      uiSourceCode.commitWorkingCopy();
    }
    callbackWrapper.call(this, null);
    return undefined;
  }

  private requestId(request: TextUtils.ContentProvider.ContentProvider): number {
    const requestId = this.requestIds.get(request);
    if (requestId === undefined) {
      const newId = ++this.lastRequestId;
      this.requestIds.set(request, newId);
      this.requests.set(newId, request);
      return newId;
    }
    return requestId;
  }

  private requestById(id: number): TextUtils.ContentProvider.ContentProvider|undefined {
    return this.requests.get(id);
  }

  private onAddTraceProvider(message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort): Record|undefined {
    if (message.command !== PrivateAPI.Commands.AddTraceProvider) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.AddTraceProvider}`);
    }
    const provider = new ExtensionTraceProvider(
        this.getExtensionOrigin(port), message.id, message.categoryName, message.categoryTooltip);
    this.clientObjects.set(message.id, provider);
    this.traceProvidersInternal.push(provider);
    this.dispatchEventToListeners(Events.TraceProviderAdded, provider);
    return undefined;
  }

  traceProviders(): ExtensionTraceProvider[] {
    return this.traceProvidersInternal;
  }

  private onForwardKeyboardEvent(message: PrivateAPI.ExtensionServerRequestMessage): Record|undefined {
    if (message.command !== PrivateAPI.Commands.ForwardKeyboardEvent) {
      return this.status.E_BADARG('command', `expected ${PrivateAPI.Commands.ForwardKeyboardEvent}`);
    }
    message.entries.forEach(handleEventEntry);

    function handleEventEntry(entry: KeyboardEventInit&{eventType: string}): void {
      // Fool around closure compiler -- it has its own notion of both KeyboardEvent constructor
      // and initKeyboardEvent methods and overriding these in externs.js does not have effect.
      const event = new window.KeyboardEvent(entry.eventType, {
        key: entry.key,
        code: entry.code,
        keyCode: entry.keyCode,
        location: entry.location,
        ctrlKey: entry.ctrlKey,
        altKey: entry.altKey,
        shiftKey: entry.shiftKey,
        metaKey: entry.metaKey,
      });

      // @ts-ignore
      event.__keyCode = keyCodeForEntry(entry);
      document.dispatchEvent(event);
    }

    function keyCodeForEntry(entry: KeyboardEventInit): unknown {
      let keyCode = entry.keyCode;
      if (!keyCode) {
        // This is required only for synthetic events (e.g. dispatched in tests).
        if (entry.key === Platform.KeyboardUtilities.ESCAPE_KEY) {
          keyCode = 27;
        }
      }
      return keyCode || 0;
    }
    return undefined;
  }

  private dispatchCallback(requestId: unknown, port: MessagePort, result: unknown): void {
    if (requestId) {
      port.postMessage({command: 'callback', requestId: requestId, result: result});
    }
  }

  private initExtensions(): void {
    this.registerAutosubscriptionHandler(
        PrivateAPI.Events.ResourceAdded, Workspace.Workspace.WorkspaceImpl.instance(),
        Workspace.Workspace.Events.UISourceCodeAdded, this.notifyResourceAdded);
    this.registerAutosubscriptionTargetManagerHandler(
        PrivateAPI.Events.NetworkRequestFinished, SDK.NetworkManager.NetworkManager,
        SDK.NetworkManager.Events.RequestFinished, this.notifyRequestFinished);

    function onElementsSubscriptionStarted(this: ExtensionServer): void {
      UI.Context.Context.instance().addFlavorChangeListener(
          SDK.DOMModel.DOMNode, this.notifyElementsSelectionChanged, this);
    }

    function onElementsSubscriptionStopped(this: ExtensionServer): void {
      UI.Context.Context.instance().removeFlavorChangeListener(
          SDK.DOMModel.DOMNode, this.notifyElementsSelectionChanged, this);
    }

    this.registerSubscriptionHandler(
        PrivateAPI.Events.PanelObjectSelected + 'elements', onElementsSubscriptionStarted.bind(this),
        onElementsSubscriptionStopped.bind(this));
    this.registerResourceContentCommittedHandler(this.notifyUISourceCodeContentCommitted);

    SDK.TargetManager.TargetManager.instance().addEventListener(
        SDK.TargetManager.Events.InspectedURLChanged, this.inspectedURLChanged, this);
  }

  private notifyResourceAdded(event: Common.EventTarget.EventTargetEvent<Workspace.UISourceCode.UISourceCode>): void {
    const uiSourceCode = event.data;
    this.postNotification(PrivateAPI.Events.ResourceAdded, this.makeResource(uiSourceCode));
  }

  private notifyUISourceCodeContentCommitted(
      event: Common.EventTarget.EventTargetEvent<Workspace.Workspace.WorkingCopyCommitedEvent>): void {
    const {uiSourceCode, content} = event.data;
    this.postNotification(PrivateAPI.Events.ResourceContentCommitted, this.makeResource(uiSourceCode), content);
  }

  private async notifyRequestFinished(event: Common.EventTarget.EventTargetEvent<SDK.NetworkRequest.NetworkRequest>):
      Promise<void> {
    const request = event.data;
    const entry = await HAR.Log.Entry.build(request);
    this.postNotification(PrivateAPI.Events.NetworkRequestFinished, this.requestId(request), entry);
  }

  private notifyElementsSelectionChanged(): void {
    this.postNotification(PrivateAPI.Events.PanelObjectSelected + 'elements');
  }

  sourceSelectionChanged(url: string, range: TextUtils.TextRange.TextRange): void {
    this.postNotification(PrivateAPI.Events.PanelObjectSelected + 'sources', {
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
      url: url,
    });
  }

  private setInspectedTabId(event: Common.EventTarget.EventTargetEvent<string>): void {
    const oldId = this.inspectedTabId;
    this.inspectedTabId = event.data;
    if (oldId === null) {
      // Run deferred init
      this.initializeExtensions();
    }
  }

  private addExtension(extensionInfo: Host.InspectorFrontendHostAPI.ExtensionDescriptor): boolean|undefined {
    const startPage = extensionInfo.startPage;

    const inspectedURL = SDK.TargetManager.TargetManager.instance().mainTarget()?.inspectedURL() ?? '';
    if (inspectedURL !== '' && !this.canInspectURL(inspectedURL)) {
      this.disableExtensions();
    }
    if (!this.extensionsEnabled) {
      return;
    }
    try {
      const startPageURL = new URL((startPage as string));
      const extensionOrigin = startPageURL.origin;
      if (!this.registeredExtensions.get(extensionOrigin)) {
        // See ExtensionAPI.js for details.
        const injectedAPI = self.buildExtensionAPIInjectedScript(
            extensionInfo, this.inspectedTabId as string, ThemeSupport.ThemeSupport.instance().themeName(),
            UI.ShortcutRegistry.ShortcutRegistry.instance().globalShortcutKeys(),
            ExtensionServer.instance().extensionAPITestHook);
        Host.InspectorFrontendHost.InspectorFrontendHostInstance.setInjectedScriptForOrigin(
            extensionOrigin, injectedAPI);
        const name = extensionInfo.name || `Extension ${extensionOrigin}`;
        this.registeredExtensions.set(extensionOrigin, {name});
      }

      const iframe = document.createElement('iframe');
      iframe.src = startPage;
      iframe.dataset.devtoolsExtension = extensionInfo.name;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);  // Only for main window.
    } catch (e) {
      console.error('Failed to initialize extension ' + startPage + ':' + e);
      return false;
    }
    return true;
  }

  private registerExtension(origin: string, port: MessagePort): void {
    if (!this.registeredExtensions.has(origin)) {
      if (origin !== window.location.origin) {  // Just ignore inspector frames.
        console.error('Ignoring unauthorized client request from ' + origin);
      }
      return;
    }
    extensionOrigins.set(port, origin);
    port.addEventListener('message', this.onmessage.bind(this), false);
    port.start();
  }

  private onWindowMessage(event: MessageEvent): void {
    if (event.data === 'registerExtension') {
      this.registerExtension(event.origin, event.ports[0]);
    }
  }

  private async onmessage(event: MessageEvent): Promise<void> {
    const message = event.data;
    let result;

    const handler = this.handlers.get(message.command);

    if (!handler) {
      result = this.status.E_NOTSUPPORTED(message.command);
    } else if (!this.extensionsEnabled) {
      result = this.status.E_FAILED('Permission denied');
    } else {
      result = await handler(message, event.target as MessagePort);
    }

    if (result && message.requestId) {
      this.dispatchCallback(message.requestId, event.target as MessagePort, result);
    }
  }

  private registerHandler(
      command: string,
      callback: (message: PrivateAPI.ExtensionServerRequestMessage, port: MessagePort) => unknown): void {
    console.assert(Boolean(command));
    this.handlers.set(command, callback);
  }

  private registerSubscriptionHandler(
      eventTopic: string, onSubscribeFirst: () => unknown, onUnsubscribeLast: () => unknown): void {
    this.subscriptionStartHandlers.set(eventTopic, onSubscribeFirst);
    this.subscriptionStopHandlers.set(eventTopic, onUnsubscribeLast);
  }

  private registerAutosubscriptionHandler<Events, T extends keyof Events>(
      eventTopic: string, eventTarget: Common.EventTarget.EventTarget<Events>, frontendEventType: T,
      handler: Common.EventTarget.EventListener<Events, T>): void {
    this.registerSubscriptionHandler(
        eventTopic, () => eventTarget.addEventListener(frontendEventType, handler, this),
        () => eventTarget.removeEventListener(frontendEventType, handler, this));
  }

  private registerAutosubscriptionTargetManagerHandler<Events, T extends keyof Events>(
      eventTopic: string, modelClass: new(arg1: SDK.Target.Target) => SDK.SDKModel.SDKModel<Events>,
      frontendEventType: T, handler: Common.EventTarget.EventListener<Events, T>): void {
    this.registerSubscriptionHandler(
        eventTopic,
        () => SDK.TargetManager.TargetManager.instance().addModelListener(modelClass, frontendEventType, handler, this),
        () => SDK.TargetManager.TargetManager.instance().removeModelListener(
            modelClass, frontendEventType, handler, this));
  }

  private registerResourceContentCommittedHandler(
      handler: (arg0: Common.EventTarget.EventTargetEvent<Workspace.Workspace.WorkingCopyCommitedEvent>) => unknown):
      void {
    function addFirstEventListener(this: ExtensionServer): void {
      Workspace.Workspace.WorkspaceImpl.instance().addEventListener(
          Workspace.Workspace.Events.WorkingCopyCommittedByUser, handler, this);
      Workspace.Workspace.WorkspaceImpl.instance().setHasResourceContentTrackingExtensions(true);
    }

    function removeLastEventListener(this: ExtensionServer): void {
      Workspace.Workspace.WorkspaceImpl.instance().setHasResourceContentTrackingExtensions(false);
      Workspace.Workspace.WorkspaceImpl.instance().removeEventListener(
          Workspace.Workspace.Events.WorkingCopyCommittedByUser, handler, this);
    }

    this.registerSubscriptionHandler(
        PrivateAPI.Events.ResourceContentCommitted, addFirstEventListener.bind(this),
        removeLastEventListener.bind(this));
  }

  private expandResourcePath(extensionPath: string, resourcePath: string): string {
    return extensionPath + '/' + Common.ParsedURL.normalizePath(resourcePath);
  }

  evaluate(
      expression: string, exposeCommandLineAPI: boolean, returnByValue: boolean,
      options: PrivateAPI.EvaluateOptions|undefined, securityOrigin: string,
      callback: (arg0: string|null, arg1: SDK.RemoteObject.RemoteObject|null, arg2: boolean) => unknown): Record
      |undefined {
    let context;

    function resolveURLToFrame(url: string): SDK.ResourceTreeModel.ResourceTreeFrame|null {
      let found = null;
      function hasMatchingURL(frame: SDK.ResourceTreeModel.ResourceTreeFrame): SDK.ResourceTreeModel.ResourceTreeFrame|
          null {
        found = (frame.url === url) ? frame : null;
        return found;
      }
      SDK.ResourceTreeModel.ResourceTreeModel.frames().some(hasMatchingURL);
      return found;
    }

    options = options || {};
    let frame;
    if (options.frameURL) {
      frame = resolveURLToFrame(options.frameURL);
    } else {
      const target = SDK.TargetManager.TargetManager.instance().mainTarget();
      const resourceTreeModel = target && target.model(SDK.ResourceTreeModel.ResourceTreeModel);
      frame = resourceTreeModel && resourceTreeModel.mainFrame;
    }
    if (!frame) {
      if (options.frameURL) {
        console.warn('evaluate: there is no frame with URL ' + options.frameURL);
      } else {
        console.warn('evaluate: the main frame is not yet available');
      }
      return this.status.E_NOTFOUND(options.frameURL || '<top>');
    }
    // We shouldn't get here if the top frame can't be inspected by an extension, but
    // let's double check for subframes.
    if (!this.canInspectURL(frame.url)) {
      return this.status.E_FAILED('Permission denied');
    }

    let contextSecurityOrigin;
    if (options.useContentScriptContext) {
      contextSecurityOrigin = securityOrigin;
    } else if (options.scriptExecutionContext) {
      contextSecurityOrigin = options.scriptExecutionContext;
    }

    const runtimeModel = frame.resourceTreeModel().target().model(SDK.RuntimeModel.RuntimeModel);
    const executionContexts = runtimeModel ? runtimeModel.executionContexts() : [];
    if (contextSecurityOrigin) {
      for (let i = 0; i < executionContexts.length; ++i) {
        const executionContext = executionContexts[i];
        if (executionContext.frameId === frame.id && executionContext.origin === contextSecurityOrigin &&
            !executionContext.isDefault) {
          context = executionContext;
        }
      }
      if (!context) {
        console.warn('The JavaScript context ' + contextSecurityOrigin + ' was not found in the frame ' + frame.url);
        return this.status.E_NOTFOUND(contextSecurityOrigin);
      }
    } else {
      for (let i = 0; i < executionContexts.length; ++i) {
        const executionContext = executionContexts[i];
        if (executionContext.frameId === frame.id && executionContext.isDefault) {
          context = executionContext;
        }
      }
      if (!context) {
        return this.status.E_FAILED(frame.url + ' has no execution context');
      }
    }
    if (!this.canInspectURL(context.origin)) {
      return this.status.E_FAILED('Permission denied');
    }

    void context
        .evaluate(
            {
              expression: expression,
              objectGroup: 'extension',
              includeCommandLineAPI: exposeCommandLineAPI,
              silent: true,
              returnByValue: returnByValue,
              generatePreview: false,
            },
            /* userGesture */ false, /* awaitPromise */ false)
        .then(onEvaluate);

    function onEvaluate(result: SDK.RuntimeModel.EvaluationResult): void {
      if ('error' in result) {
        callback(result.error, null, false);
        return;
      }
      callback(null, result.object || null, Boolean(result.exceptionDetails));
    }
    return undefined;
  }

  private canInspectURL(url: string): boolean {
    let parsedURL;
    // This is only to work around invalid URLs we're occasionally getting from some tests.
    // TODO(caseq): make sure tests supply valid URLs or we specifically handle invalid ones.
    try {
      parsedURL = new URL(url);
    } catch (exception) {
      return false;
    }
    if (kAllowedOrigins.includes(parsedURL.origin)) {
      return true;
    }
    if (parsedURL.protocol === 'chrome:' || parsedURL.protocol === 'devtools:') {
      return false;
    }
    if (parsedURL.protocol.startsWith('http') && parsedURL.hostname === 'chrome.google.com' &&
        parsedURL.pathname.startsWith('/webstore')) {
      return false;
    }

    if ((window.DevToolsAPI && window.DevToolsAPI.getOriginsForbiddenForExtensions &&
             window.DevToolsAPI.getOriginsForbiddenForExtensions() ||
         []).includes(parsedURL.origin)) {
      return false;
    }
    return true;
  }

  private disableExtensions(): void {
    this.extensionsEnabled = false;
  }
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Events {
  SidebarPaneAdded = 'SidebarPaneAdded',
  TraceProviderAdded = 'TraceProviderAdded',
}

export type EventTypes = {
  [Events.SidebarPaneAdded]: ExtensionSidebarPane,
  [Events.TraceProviderAdded]: ExtensionTraceProvider,
};

class ExtensionServerPanelView extends UI.View.SimpleView {
  private readonly name: string;
  private readonly panel: UI.Panel.Panel;

  constructor(name: string, title: string, panel: UI.Panel.Panel) {
    super(title);
    this.name = name;
    this.panel = panel;
  }

  viewId(): string {
    return this.name;
  }

  widget(): Promise<UI.Widget.Widget> {
    return Promise.resolve(this.panel) as Promise<UI.Widget.Widget>;
  }
}

export class ExtensionStatus {
  OK: (...args: unknown[]) => Record;
  E_EXISTS: (...args: unknown[]) => Record;
  E_BADARG: (...args: unknown[]) => Record;
  E_BADARGTYPE: (...args: unknown[]) => Record;
  E_NOTFOUND: (...args: unknown[]) => Record;
  E_NOTSUPPORTED: (...args: unknown[]) => Record;
  E_PROTOCOLERROR: (...args: unknown[]) => Record;
  E_FAILED: (...args: unknown[]) => Record;

  constructor() {
    function makeStatus(code: string, description: string, ...details: unknown[]): Record {
      const status: Record = {code, description, details};
      if (code !== 'OK') {
        status.isError = true;
        console.error('Extension server error: ' + Platform.StringUtilities.sprintf(description, ...details));
      }
      return status;
    }

    this.OK = makeStatus.bind(null, 'OK', 'OK');
    this.E_EXISTS = makeStatus.bind(null, 'E_EXISTS', 'Object already exists: %s');
    this.E_BADARG = makeStatus.bind(null, 'E_BADARG', 'Invalid argument %s: %s');
    this.E_BADARGTYPE = makeStatus.bind(null, 'E_BADARGTYPE', 'Invalid type for argument %s: got %s, expected %s');
    this.E_NOTFOUND = makeStatus.bind(null, 'E_NOTFOUND', 'Object not found: %s');
    this.E_NOTSUPPORTED = makeStatus.bind(null, 'E_NOTSUPPORTED', 'Object does not support requested operation: %s');
    this.E_PROTOCOLERROR = makeStatus.bind(null, 'E_PROTOCOLERROR', 'Inspector protocol error: %s');
    this.E_FAILED = makeStatus.bind(null, 'E_FAILED', 'Operation failed: %s');
  }
}
export interface Record {
  code: string;
  description: string;
  details: unknown[];
  isError?: boolean;
}
