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

// --timeout used to be documented and ignored: every run waited 60 minutes whatever it was given.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const ParamedicConfig = require('../../lib/ParamedicConfig');

const HOUR = 60 * 60 * 1000;

test('the timeout is 60 minutes when none is given', () => {
    assert.equal(ParamedicConfig.parseFromArguments({ platform: 'android', plugin: '.' }).getTimeout(), HOUR);
    assert.equal(new ParamedicConfig({ platform: 'android' }).getTimeout(), HOUR);
});

test('the command line and a configuration file both set the timeout', () => {
    // minimist hands a number for --timeout 30000 and a string for --timeout=30000
    assert.equal(ParamedicConfig.parseFromArguments({ platform: 'android', plugin: '.', timeout: 30000 }).getTimeout(), 30000);
    assert.equal(ParamedicConfig.parseFromArguments({ platform: 'android', plugin: '.', timeout: '30000' }).getTimeout(), 30000);
    assert.equal(new ParamedicConfig({ platform: 'android', timeout: 120000 }).getTimeout(), 120000);

    const fromFile = new ParamedicConfig({ platform: 'android', timeout: 120000 });
    fromFile.setTimeout(5000);
    assert.equal(fromFile.getTimeout(), 5000);
});

test('a timeout that is not a positive number throws instead of meaning an hour', () => {
    for (const timeout of ['abc', 0, -1, true]) {
        assert.throws(() => new ParamedicConfig({ platform: 'android', timeout }).getTimeout(), /--timeout must be a positive number/);
    }
});

test('the package entry point is the runner', () => {
    assert.equal(typeof require('../..').run, 'function');
});
