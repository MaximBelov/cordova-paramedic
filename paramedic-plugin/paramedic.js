/* global window, document, cordova, jasmine, XMLHttpRequest */
/*
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

function Paramedic () { }

Paramedic.prototype.initialize = function () {
    const me = this;
    const config = me.loadParamedicConfig();
    const connectionUri = config.logurl;

    /**
     * While the testing application is running, events may be generated
     * before the socket connection is fully open. In this case, the events
     * are stored in the eventQueue and will be sent once the connection
     * has opened.
     *
     * The object is not the WebSocket itself: on a physical iOS device the connection is
     * made only once the user has answered the local-network prompt, and the events of the
     * tests that run meanwhile wait here.
     */
    const socket = { cdvEventQueue: [], ws: null };

    socket.cdvSendEvent = function (eventName, payload) {
        const message = JSON.stringify({ event: eventName, data: payload });

        /**
         * Sends the event immediately if the socket is open; otherwise,
         * queues the event to be sent later when the connection opens.
         */
        if (socket.ws && socket.ws.readyState === WebSocket.OPEN) {
            socket.ws.send(message);
        } else {
            socket.cdvEventQueue.push(message);
        }
    };

    const connect = function () {
        const ws = new WebSocket(connectionUri);
        socket.ws = ws;
        // On the page's own log: a connection that never opens is otherwise not to be told from one nobody tried.
        ws.addEventListener('error', () => console.log('[paramedic] cannot reach ' + connectionUri));
        ws.addEventListener('close', () => console.log('[paramedic] connection to ' + connectionUri + ' closed'));
        /**
         * Sends all queued events once the socket connection is open.
         */
        ws.addEventListener('open', () => {
            for (const msg of socket.cdvEventQueue) {
                ws.send(msg);
            }
            socket.cdvEventQueue = [];
        });
    };

    this.socket = socket;

    this.overrideConsole();
    this.injectJasmineReporter();

    // indicate our presence
    window.PARAMEDIC = true;

    if (config.requestLocalNetworkPermission) {
        // The prompt is answered, or declined, before the first connection: iOS refuses the connection of an app that has
        // not been allowed, and a refused WebSocket is not retried. Either answer connects: a refusal fails, and says so.
        document.addEventListener('deviceready', function () {
            const plugin = window.localNetworkPermission;
            if (plugin) {
                plugin.requestLocalNetworkPermission(function () {
                    console.log('[paramedic] local network permission granted');
                    connect();
                }, function (error) {
                    console.log('[paramedic] local network permission: ' + error);
                    connect();
                });
            } else {
                console.log('[paramedic] The local network permission plugin is missing');
                connect();
            }
        });
    } else {
        connect();
    }
};

Paramedic.prototype.overrideConsole = function () {
    const origConsole = window.console;
    const me = this;

    function createCustomLogger (type) {
        return function () {
            origConsole[type].apply(origConsole, arguments);

            me.socket.cdvSendEvent('deviceLog', { type, msg: Array.prototype.slice.apply(arguments) });
        };
    }
    window.console = {
        log: createCustomLogger('log'),
        warn: createCustomLogger('warn'),
        error: createCustomLogger('error')
    };
    console.log('Paramedic console has been installed.');
};

Paramedic.prototype.injectJasmineReporter = function () {
    const JasmineParamedicProxy = require('cordova-plugin-paramedic.JasmineParamedicProxy');
    const jasmineProxy = new JasmineParamedicProxy(this.socket);
    const testsModule = cordova.require('cordova-plugin-test-framework.cdvtests');
    const defineAutoTestsOriginal = testsModule.defineAutoTests;

    testsModule.defineAutoTests = function () {
        defineAutoTestsOriginal();
        jasmine.getEnv().addReporter(jasmineProxy);
    };
};

Paramedic.prototype.loadParamedicConfig = function () {
    try {
        // attempt to synchronously load medic config
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '../medic.json', false);
        xhr.send(null);
        const cfg = JSON.parse(xhr.responseText);
        if (cfg.logurl) {
            return cfg;
        }
    } catch (ex) {
        console.log('Unable to load paramedic server url: ' + ex);
    }

    throw new Error('[paramedic] Failed to find logurl.');
};

cordova.paramedic = new Paramedic();
cordova.paramedic.initialize();

module.exports = Paramedic;
