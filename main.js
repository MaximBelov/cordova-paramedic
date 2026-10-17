#!/usr/bin/env node

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

const parseArgs = require('minimist');

const paramedic = require('./lib/paramedic');
const ParamedicConfig = require('./lib/ParamedicConfig');
const { utilities } = require('./lib/utils');

const USAGE = `Error missing args.

cordova-paramedic --platform PLATFORM --plugin PATH [--justbuild --version ...]
cordova-paramedic --config PATH

--platform PLATFORM : the platform id. Currently supports 'ios', 'browser' 'android'.
    Path to platform can be specified as link to git repo like:
    android@https://github.com/apache/cordova-android.git
    or path to local copied git repo like:
    android@../cordova-android/
--plugin PATH : the relative or absolute path to a plugin folder
    expected to have a 'tests' folder.
    You may specify multiple --plugin flags and they will all
    be installed and tested together.

--action : (optional) the cordova command the app is started with: run (default), build or emulate
--args : (optional) add command line args to the "cordova build" and "cordova run" commands
--ci : (optional) sets window.IS_CI in the app, so tests that need a person can skip themselves
--cleanUpAfterRun : (optional) deletes the temporary app and stops its emulator or simulator after the run
--appId : (optional) bundle/application id of the temporary app (default: Cordova's own).
    A physical iPhone needs one the signing team can register.
--cli : (optional) A path to Cordova CLI
--config : (optional) read configuration from a paramedic configuration file: a path, or a name under conf/
    (pr/local/android-12 for conf/pr/local/android-12.config.json)
--device : (optional) run on a physical phone instead of a simulator or emulator. With --target left out it is the iPhone
    connected by cable, or the Android phone connected by USB. An iPhone reports to this machine's LAN address (see
    --medicHost) and is signed through --args, e.g. --args=--buildConfig=/path/build.json; an Android phone reports
    through "adb reverse".
--justbuild : (optional) just builds the project, without running the tests
--medicHost : (optional) the address the app reports its results to
    (default: 127.0.0.1, the Android emulator's 10.0.2.2, or this machine's LAN address with --device)
--outputDir : (optional) path to save Junit results file & Device logs
--skipMainTests : (optional) do not run the cordova-plugin-test-framework tests. They are the only tests, so the run
    stops at once and fails
--target : (optional) target to deploy to
--tccDb : (optional) iOS only - specifies the path for the TCC.db file to be copied.
--verbose : (optional) verbose mode. Display more information output
--version : (optional) prints cordova-paramedic version and exits

A run whose tests have not finished after 60 minutes fails. The limit is fixed.
`;

const argv = parseArgs(process.argv.slice(2), { string: ['plugin', 'appId', 'medicHost'] });
const pathToParamedicConfig = utilities.getConfigPath(argv.config);

if (argv.version) {
    console.log(require('./package.json').version);
    process.exit(0);
}

if (!pathToParamedicConfig && (!argv.platform || !argv.plugin)) {
    console.log(USAGE);
    process.exit(1);
}

const paramedicConfig = pathToParamedicConfig
    ? ParamedicConfig.parseFromFile(pathToParamedicConfig)
    : ParamedicConfig.parseFromArguments(argv);

if (argv.justBuild || argv.justbuild) {
    paramedicConfig.setAction('build');
}

if (argv.plugin) {
    paramedicConfig.setPlugins(argv.plugin);
}

if (argv.outputDir) {
    paramedicConfig.setOutputDir(argv.outputDir);
}

if (argv.tccDb) {
    paramedicConfig.setTccDb(argv.tccDb);
}

if (argv.platform) {
    paramedicConfig.setPlatform(argv.platform);
}

if (argv.action) {
    paramedicConfig.setAction(argv.action);
}

if (argv.skipMainTests) {
    paramedicConfig.setSkipMainTests(argv.skipMainTests);
}

if (argv.ci) {
    paramedicConfig.setCI(argv.ci);
}

if (argv.target) {
    paramedicConfig.setTarget(argv.target);
}

if (argv.cli) {
    paramedicConfig.setCli(argv.cli);
}

if (argv.args) {
    paramedicConfig.setArgs(argv.args);
}

if (argv.device) {
    paramedicConfig.setDevice(true);
}

if (argv.appId) {
    paramedicConfig.setAppId(argv.appId);
}

if (argv.medicHost) {
    paramedicConfig.setMedicHost(argv.medicHost);
}

paramedic.run(paramedicConfig)
    .then((isTestPassed) => {
        const exitCode = isTestPassed ? 0 : 1;
        console.log('Finished with exit code ' + exitCode);
        process.exit(exitCode);
    })
    .catch((error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    });
