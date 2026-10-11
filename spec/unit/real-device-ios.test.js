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

// What a run on a PHYSICAL iPhone needs and a simulator run does not: no `--emulator`, an address the phone can reach this machine
// on, a bundle id the signing team can register, and extra arguments that arrive as an array.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const ParamedicConfig = require('../../lib/ParamedicConfig');
const LocalServer = require('../../lib/LocalServer');
const { getLanAddress, getIosDeviceRunArgs, getIosDeviceBuildArgs, pickWiredIosDevice, pickUsbAndroidDevice } = require('../../lib/utils/utilities');

const config = (json) => new ParamedicConfig({ platform: 'ios', ...json });

test('getArgs is an array whatever it was given: spreading a string would give one argument per character', () => {
    assert.deepEqual(config({ args: ['--buildConfig=/a/build.json'] }).getArgs(), ['--buildConfig=/a/build.json']);
    assert.deepEqual(config({ args: '--buildFlag=-x  --verbose' }).getArgs(), ['--buildFlag=-x', '--verbose']);
    assert.deepEqual(config({ args: '' }).getArgs(), []);
    assert.deepEqual(config({}).getArgs(), []);
});

test('the command line reads --device, --appId and --medicHost', () => {
    const parsed = ParamedicConfig.parseFromArguments({ platform: 'ios', plugin: '.', device: true, appId: 'com.example.t', medicHost: '10.0.0.5' });
    assert.equal(parsed.isDevice(), true);
    assert.equal(parsed.getAppId(), 'com.example.t');
    assert.equal(parsed.getMedicHost(), '10.0.0.5');
    assert.equal(ParamedicConfig.parseFromArguments({ platform: 'ios', plugin: '.' }).isDevice(), false);
});

test('a device run is --device and the UDID, never --emulator', () => {
    assert.deepEqual(getIosDeviceRunArgs(['run', 'ios', '--no-telemetry'], '0000-UDID'), ['run', 'ios', '--no-telemetry', '--device', '--target', '0000-UDID']);
    assert.ok(!getIosDeviceRunArgs(['run', 'ios'], 'x').includes('--emulator'));
});

test('--device is not repeated when the arguments carry it, and no target means none is added', () => {
    assert.deepEqual(getIosDeviceRunArgs(['build', 'ios', '--device']), ['build', 'ios', '--device']);
});

test('the LAN address is the first IPv4 that is not a loopback one', () => {
    const interfaces = {
        lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
        en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }]
    };
    assert.equal(getLanAddress(interfaces), '192.168.1.20');
});

test('with no address a device could reach, it refuses instead of reporting to the phone itself', () => {
    assert.throws(() => getLanAddress({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), /--medicHost/);
});

test('the app reports to --medicHost first, then to this machine on a device, else to 127.0.0.1 (and the emulator\'s 10.0.2.2)', () => {
    const server = (json) => new LocalServer(config(json), null, 1234);
    assert.equal(server({ medicHost: '10.1.1.1', device: true }).getServerIP('ios'), '10.1.1.1');
    assert.equal(server({}).getServerIP('ios'), '127.0.0.1');
    assert.equal(server({}).getServerIP('android'), '10.0.2.2');
    assert.equal(server({ medicHost: '10.1.1.1' }).getMedicAddress('ios'), 'ws://10.1.1.1:1234');
});

test('the build for a device has the user arguments and --device, and no target (a build has none)', () => {
    assert.deepEqual(
        getIosDeviceBuildArgs(['--buildConfig=/a/build.json']),
        ['build', 'ios', '--buildConfig=/a/build.json', '--device', '--no-telemetry', '--no-update-notifier']
    );
    assert.deepEqual(getIosDeviceBuildArgs(['--device']).filter(a => a === '--device'), ['--device']);
    assert.ok(!getIosDeviceBuildArgs([]).includes('--target'));
});

const device = (udid, transportType, name = 'iPhone', platform = 'iOS') => ({
    hardwareProperties: { udid, platform },
    connectionProperties: { transportType },
    deviceProperties: { name }
});

test('the iPhone connected by cable is the one picked, not one that is only on the network', () => {
    const json = { result: { devices: [device('NET', 'localNetwork'), device('USB', 'wired', 'iPhone 16')] } };
    assert.equal(pickWiredIosDevice(json), 'USB');
});

test('with none, or several, connected by cable it refuses and says what to do', () => {
    assert.throws(() => pickWiredIosDevice({ result: { devices: [device('NET', 'localNetwork')] } }), /No iPhone is connected by cable/);
    assert.throws(() => pickWiredIosDevice({ result: { devices: [device('A', 'wired'), device('B', 'wired')] } }), /A\)[\s\S]*B\)/);
});

test('a device that is not an iPhone or iPad does not count', () => {
    assert.throws(() => pickWiredIosDevice({ result: { devices: [device('W', 'wired', 'Watch', 'watchOS')] } }), /No iPhone/);
});

const adbOutput = (...lines) => ['List of devices attached', ...lines, ''].join('\n');

test('the Android phone connected by USB is the one picked, not an emulator or a network device', () => {
    const out = adbOutput(
        '67031JEA303353         device usb:1048576X product:stallion model:Pixel_10a device:stallion transport_id:1',
        'emulator-5554          device product:sdk_gphone model:sdk transport_id:2',
        '192.168.1.5:5555       device product:x model:Y transport_id:3'
    );
    assert.equal(pickUsbAndroidDevice(out), '67031JEA303353');
});

test('with no phone ready by USB, or several, it refuses and says what is wrong', () => {
    assert.throws(() => pickUsbAndroidDevice(adbOutput('emulator-5554 device transport_id:2')), /No Android phone is connected by USB/);
    assert.throws(() => pickUsbAndroidDevice(adbOutput('R58M123 unauthorized usb:1 transport_id:4')), /R58M123 \(unauthorized\)/);
    assert.throws(() => pickUsbAndroidDevice(adbOutput('A device usb:1 transport_id:1', 'B device usb:2 transport_id:2')), /A, B/);
});

test('an Android phone reports on 127.0.0.1 (adb reverse), an emulator on 10.0.2.2', () => {
    const server = (json) => new LocalServer(config({ platform: 'android', ...json }), null, 1);
    assert.equal(server({ device: true }).getServerIP('android'), '127.0.0.1');
    assert.equal(server({}).getServerIP('android'), '10.0.2.2');
});
