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

// Collecting the Android device logs runs `adb logcat` once the tests are done. The logs are for whoever reads the run: when adb
// will not hand them over, the results that were already collected must stay a success. These tests put a fake `adb` first on PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ParamedicLogCollector = require('../../lib/ParamedicLogCollector');

async function withFakeAdb (script, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paramedic-adb-'));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paramedic-logs-'));
    fs.writeFileSync(path.join(dir, 'adb'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    try {
        await run(outputDir);
    } finally {
        process.env.PATH = previous;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

const collector = (outputDir) => new ParamedicLogCollector('android', outputDir, outputDir, { target: 'emulator-5554' });

test('device logs that adb hands over are written to the output folder', { skip: process.platform === 'win32' }, async () => {
    await withFakeAdb('echo "10-14 18:14:42.000 I/Test: hello"', async (outputDir) => {
        await collector(outputDir).collectLogs();
        assert.match(fs.readFileSync(path.join(outputDir, 'android_logs.txt'), 'utf8'), /I\/Test: hello/);
    });
});

test('adb refusing the logs does not fail the run, and no file is written', { skip: process.platform === 'win32' }, async () => {
    await withFakeAdb('exit 255', async (outputDir) => {
        await collector(outputDir).collectLogs();
        assert.equal(fs.existsSync(path.join(outputDir, 'android_logs.txt')), false);
    });
});
