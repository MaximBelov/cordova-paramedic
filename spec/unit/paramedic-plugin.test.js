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

// The app side of a run (paramedic-plugin/paramedic.js), loaded with the browser and Cordova stubbed: when it connects to the local
// server, and that the events of tests that start before the connection is open are not lost. On a physical iOS device the
// connection waits for the local-network prompt to be answered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'paramedic-plugin', 'paramedic.js'), 'utf8');

function load (medic, { permissionPlugin } = {}) {
    const sockets = [];
    const listeners = {};
    class WebSocket {
        constructor (url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.handlers = {};
            sockets.push(this);
        }

        addEventListener (name, handler) { this.handlers[name] = handler; }
        send (message) { this.sent.push(JSON.parse(message)); }
        open () { this.readyState = WebSocket.OPEN; this.handlers.open(); }
    }
    WebSocket.OPEN = 1;

    const sandbox = {
        module: { exports: {} },
        require: () => function JasmineParamedicProxy () {},
        cordova: { require: () => ({ defineAutoTests () {} }) },
        window: { localNetworkPermission: permissionPlugin },
        document: { addEventListener: (name, handler) => { listeners[name] = handler; } },
        console: { log () {}, warn () {}, error () {} },
        XMLHttpRequest: class { open () {} send () { this.responseText = JSON.stringify(medic); } },
        WebSocket
    };
    vm.runInNewContext(source, sandbox);
    return { sandbox, sockets, listeners };
}

test('it connects at once, and what the tests said before the connection opened is sent when it does', () => {
    const { sandbox, sockets } = load({ logurl: 'ws://127.0.0.1:1' });
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'ws://127.0.0.1:1');

    sandbox.cordova.paramedic.socket.cdvSendEvent('specDone', { n: 1 });
    sockets[0].open();
    sandbox.cordova.paramedic.socket.cdvSendEvent('specDone', { n: 2 });
    assert.deepEqual(sockets[0].sent.map(m => m.data.n), [1, 2]);
});

test('on a physical iOS device it asks for the local-network permission first, and connects after the answer', () => {
    let answer;
    const permissionPlugin = { requestLocalNetworkPermission: (granted, declined) => { answer = { granted, declined }; } };
    const { sandbox, sockets, listeners } = load({ logurl: 'ws://192.168.1.2:9', requestLocalNetworkPermission: true }, { permissionPlugin });
    assert.equal(sockets.length, 0);

    sandbox.cordova.paramedic.socket.cdvSendEvent('jasmineStarted', {});
    listeners.deviceready();
    assert.equal(sockets.length, 0, 'the prompt is still up');

    answer.granted();
    assert.equal(sockets[0].url, 'ws://192.168.1.2:9');
    sockets[0].open();
    assert.deepEqual(sockets[0].sent.map(m => m.event), ['jasmineStarted']);
});

test('a declined prompt still connects: the connection fails and says so, instead of nothing happening', () => {
    const permissionPlugin = { requestLocalNetworkPermission: (granted, declined) => declined('Permission declined') };
    const { listeners, sockets } = load({ logurl: 'ws://192.168.1.2:9', requestLocalNetworkPermission: true }, { permissionPlugin });
    listeners.deviceready();
    assert.equal(sockets.length, 1);
});

test('without the permission plugin it connects anyway', () => {
    const { listeners, sockets } = load({ logurl: 'ws://192.168.1.2:9', requestLocalNetworkPermission: true });
    listeners.deviceready();
    assert.equal(sockets.length, 1);
});
