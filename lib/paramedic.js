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

const Server = require('./LocalServer');
const path = require('path');
const fs = require('fs');
const { setTimeout: timelimit } = require('node:timers/promises');

const { logger, utilities, spawnAsync } = require('./utils');
const Reporters = require('./Reporters');
const ParamedicKill = require('./ParamedicKill');
const ParamedicLogCollector = require('./ParamedicLogCollector');
const ParamediciOSPermissions = require('./ParamediciOSPermissions');
const ParamedicTargetChooser = require('./ParamedicTargetChooser');
const ParamedicAppUninstall = require('./ParamedicAppUninstall');
const ParamedicApp = require('./ParamedicApp');

// Time to wait for initial device connection.
// If device has not connected within this interval the tests are stopped.
const INITIAL_CONNECTION_TIMEOUT = 540000; // 9mins

class ParamedicRunner {
    constructor (config) {
        this.tempFolder = null;
        this.config = config;
        this.targetObj = undefined;

        this.isBrowser = this.config.getPlatformId() === utilities.BROWSER;
        this.isIos = this.config.getPlatformId() === utilities.IOS;
        // A physical iPhone: no simulator to choose, start or uninstall from.
        this.isIosDevice = this.isIos && this.config.isDevice();
        // A physical Android phone: reports through `adb reverse`, and is neither started nor killed with the emulators.
        this.isAndroidDevice = this.config.getPlatformId() === utilities.ANDROID && this.config.isDevice();
        this.reversedPort = null;
    }

    /**
     * The main runner that:
     * - Creates, sets up, & prepares the project.
     * - Runs the project
     * - Executes the tests
     *
     * On a successful case, the test results should be returned.
     *
     * An error can be thrown if there was any issues within the
     * process. Failures in the app uninstall process will not
     * error out.
     *
     * @returns {Promise}
     */
    async run () {
        this.checkConfig();

        const paramedicApp = new ParamedicApp(this.config, this.storedCWD, this);

        try {
            // Create a Cordova project
            this.tempFolder = await paramedicApp.createTempProject();

            // Prepare the project by installing plugins, platforms, seting up test startpage, & check platform requirements
            await paramedicApp.prepareProjectToRunTests();

            // Start server if the tests are to run
            if (this.config.runMainTests()) {
                this.server = await Server.startServer(this.config);

                this.injectReporters();
                this.subcribeForEvents();

                const logUrl = this.server.getMedicAddress(this.config.getPlatformId());
                this.writeMedicJson(logUrl);

                logger.normal('[paramedic] Start building app and running tests at ' + (new Date()).toLocaleTimeString());
            }

            const results = await Promise.race([
                this.runLocalTests(),
                // If the tests fail to complete in the allowed time (--timeout, default 60 minutes), it will reject
                timelimit(this.config.getTimeout())
                    .then(() => Promise.reject(
                        new Error(`[paramedic] Tests failed to complete in ${this.config.getTimeout()} ms.`)
                    ))
            ]);

            logger.warn('---------------------------------------------------------');
            logger.warn('6. Collect data and clean up');
            logger.warn('---------------------------------------------------------');
            logger.normal('Completed tests at ' + (new Date()).toLocaleTimeString());

            // When --justbuild is not set, fetch logs from the device.
            if (this.config.getAction() !== 'build') {
            // collect logs and uninstall app
                await this.collectDeviceLogs();

                try {
                    await this.uninstallApp();
                } catch {
                    // do not fail if uninstall failed
                } finally {
                    this.killEmulatorProcess();
                }
            }

            return results;
        } catch (error) {
            logger.error(error);
            console.log(error.stack);
            throw error;
        } finally {
            await this.removeReversedPort();
            this.cleanUpProject();
        }
    }

    checkConfig () {
        logger.warn('---------------------------------------------------------');
        logger.warn('0. Paramedic config');
        const config = this.config.getAll();
        for (const property in config) {
            if (Object.prototype.hasOwnProperty.call(config, property)) {
                if (typeof config[property] !== 'undefined' && config[property] !== null) {
                    logger.warn(`   - ${property}: ${config[property]}`);
                }
            }
        }
        logger.warn('---------------------------------------------------------');

        // a bad --timeout fails here, before a project is created, rather than after the build
        this.config.getTimeout();

        if (!this.config.runMainTests()) {
            throw new Error('No tests to run: --skipMainTests was used');
        }

        if (!['cordova', 'phonegap'].includes(this.config.getCli())) {
            if (!path.isAbsolute(this.config.getCli())) {
                const cliAbsolutePath = path.resolve(this.config.getCli());
                this.config.setCli(cliAbsolutePath);
            }
        }

        logger.info('[paramedic] Will use the following cli: ' + this.config.getCli());
    }

    /**
     * Setup iOS related Permissions
     */
    async setPermissions () {
        const applicationsToGrantPermission = ['kTCCServiceAddressBook'];
        if (this.isIos) {
            logger.info('[paramedic] Setting required permissions.');
            const tccDb = this.config.getTccDb();
            if (tccDb) {
                const appName = utilities.PARAMEDIC_DEFAULT_APP_NAME;
                const paramediciOSPermissions = new ParamediciOSPermissions(appName, tccDb, this.targetObj);
                await paramediciOSPermissions.updatePermissions(applicationsToGrantPermission);
            }
        }
    }

    injectReporters () {
        const reporters = Reporters.getReporters(this.config.getOutputDir());

        [
            'jasmineStarted',
            'specStarted',
            'specDone',
            'suiteStarted',
            'suiteDone',
            'jasmineDone'
        ].forEach((route) => {
            reporters.forEach((reporter) => {
                if (reporter[route] instanceof Function) {
                    this.server.on(route, reporter[route].bind(reporter));
                }
            });
        });
    }

    subcribeForEvents () {
        this.server.on('deviceLog', (data) => {
            logger.verbose('device|console.' + data.type + ': ' + data.msg[0]);
        });

        this.server.on('deviceInfo', (data) => {
            logger.normal('[paramedic] Device info: ' + JSON.stringify(data));
        });
    }

    writeMedicJson (logUrl) {
        logger.normal('[paramedic] writing medic log url to project ' + logUrl);
        const medicFilePath = path.join(this.tempFolder.name, 'www', 'medic.json');
        const medicFileContent = JSON.stringify({ logurl: logUrl, requestLocalNetworkPermission: this.isIosDevice });
        fs.writeFileSync(medicFilePath, medicFileContent);
    }

    /**
     * Runs the local tests (Jasmine) and returns the results.
     * A reject maybe returned for example the tests do not complete in the timelimit.
     *
     * @returns {Promise}
     */
    async runLocalTests () {
        logger.warn('---------------------------------------------------------');
        logger.warn('4. Run (Jasmine) tests...');
        logger.warn('... locally');
        logger.warn('---------------------------------------------------------');

        // checking for Android platform here because in this case we still need to start an emulator
        // will check again a bit lower
        if (!this.config.runMainTests() && this.config.getPlatformId() !== utilities.ANDROID) {
            logger.normal('Skipping main tests...');
            return utilities.TEST_PASSED;
        }

        logger.info('[paramedic] running tests locally');
        await this.setPermissions();

        const cmdArgs = await this.getRunLocalTestCommandArgs();

        if (this.config.getAction() === 'build') {
            await spawnAsync(
                this.config.getCli(),
                cmdArgs,
                { cwd: this.tempFolder.name }
            );

            // Build only does not trigger tests. Pass will be returned.
            return utilities.TEST_PASSED;
        }

        // Main tests are being skipped. Pass will be returned.
        if (!this.config.runMainTests()) {
            logger.normal('[paramedic] Skipping main tests...');
            return utilities.TEST_PASSED;
        }

        // Waiting for test results for run/emulate commands.
        if (this.shouldWaitForTestResult()) {
            return await Promise.race([
                this.waitForTests(cmdArgs), // resolve on request
                timelimit(INITIAL_CONNECTION_TIMEOUT).then(() => {
                    if (!this.server.isDeviceConnected()) {
                        const ERR_MSG = `[paramedic] The device failed to connect to local server in ${INITIAL_CONNECTION_TIMEOUT / 1000} secs`;
                        return Promise.reject(new Error(ERR_MSG));
                    }
                })
            ]);
        }

        // Nothing happened so return pass.
        return utilities.TEST_PASSED;
    }

    async waitForTests (cmdArgs) {
        logger.info('[paramedic] Waiting for test results...');

        const testResults = new Promise((resolve, reject) => {
            this.server.on('jasmineDone', (data) => {
                logger.info('[paramedic] Tests has completed.');
                resolve(data.specResults.specFailed === 0);
            });
            this.server.on('disconnect', () => {
                reject(new Error('[paramedic] Device is disconnected before passing the tests'));
            });
        });

        if (this.isIosDevice) {
            await this.buildAndLaunchOnIosDevice();
        } else {
            // This spawns the Cordova run command. It will build, run, and trigger the automatic tests.
            await spawnAsync(
                this.config.getCli(),
                cmdArgs,
                { cwd: this.tempFolder.name }
            );
        }

        return testResults;
    }

    /**
     * Builds the app for the device and starts it on it, with `devicectl`.
     *
     * `cordova run ios --device` launches through ios-deploy, which cannot mount the developer disk
     * image of a recent iOS ("Unable to locate DeviceSupport directory"), so the app is built by Cordova
     * and installed and launched by Xcode's own tool, which can. The app starts on the test page and
     * runs the tests by itself, and reports to the local server like any other run.
     */
    async buildAndLaunchOnIosDevice () {
        const udid = this.config.getTarget() || utilities.findWiredIosDevice();
        logger.info('[paramedic] Device: ' + udid);
        const cwd = this.tempFolder.name;

        await spawnAsync(
            this.config.getCli(),
            utilities.getIosDeviceBuildArgs(this.config.getArgs()),
            { cwd }
        );

        const buildDir = path.join(cwd, 'platforms', 'ios', 'build', 'Debug-iphoneos');
        // A build with a build configuration is exported as an .ipa; one without leaves the .app.
        const built = fs.readdirSync(buildDir);
        const app = built.find(name => name.endsWith('.ipa')) || built.find(name => name.endsWith('.app'));
        if (!app) {
            throw new Error(`[paramedic] Neither an .ipa nor an .app was built in ${buildDir}`);
        }

        await spawnAsync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, path.join(buildDir, app)], { cwd });
        await spawnAsync(
            'xcrun',
            ['devicectl', 'device', 'process', 'launch', '--device', udid, '--terminate-existing', this.config.getAppId() || utilities.CORDOVA_DEFAULT_APP_ID],
            { cwd }
        );
    }

    /**
     * Creates the run/build command.
     *
     * @returns {Array}
     */
    async getRunLocalTestCommandArgs () {
        const args = [
            this.config.getAction(),
            this.config.getPlatformId(),
            ...this.config.getArgs(),
            ...utilities.PARAMEDIC_COMMON_ARGS
        ];

        if (this.isBrowser || this.config.getAction() === 'build') {
            return this.isIosDevice ? utilities.getIosDeviceRunArgs(args) : args;
        }

        if (this.isIosDevice) {
            const target = this.config.getTarget();
            this.targetObj = { target };
            return utilities.getIosDeviceRunArgs(args, target);
        }

        const targetChooser = new ParamedicTargetChooser(this.tempFolder.name, this.config);
        this.targetObj = await targetChooser.chooseTarget(this.config.getTarget());

        if (this.isAndroidDevice) {
            await this.reverseServerPort(this.targetObj.target);
        }

        // CB-11472 In case of iOS provide additional '--emulator' flag, otherwise
        // 'cordova run ios --target' would hang waiting for device with name
        // as specified in 'target' in case if any device is physically connected
        return [
            ...args,
            '--target',
            this.targetObj.target
        ].concat(this.isIos ? ['--emulator'] : []);
    }

    /**
     * Lets the phone reach the local server on its own 127.0.0.1 (the address in medic.json), over USB.
     */
    async reverseServerPort (serial) {
        const port = this.server.port;
        await spawnAsync('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
        this.reversedPort = { serial, port };
    }

    async removeReversedPort () {
        if (this.reversedPort) {
            const { serial, port } = this.reversedPort;
            this.reversedPort = null;
            await spawnAsync('adb', ['-s', serial, 'reverse', '--remove', `tcp:${port}`]).catch(() => {});
        }
    }

    shouldWaitForTestResult () {
        const action = this.config.getAction();
        return (action.indexOf('run') === 0) || (action.indexOf('emulate') === 0);
    }

    /**
     * Removes the temporary project directory if flagged to cleanup after run.
     */
    cleanUpProject () {
        if (this.config.shouldCleanUpAfterRun()) {
            logger.info('[paramedic] Removing Temporary Project: ' + this.tempFolder.name);
            fs.rmSync(this.tempFolder.name, { force: true, recursive: true });
        }
    }

    killEmulatorProcess () {
        if (this.config.shouldCleanUpAfterRun() && !this.isIosDevice && !this.isAndroidDevice) {
            logger.info('[paramedic] Terminating Emulator Process');
            const paramedicKill = new ParamedicKill(this.config.getPlatformId());
            paramedicKill.kill();
        }
    }

    /**
     * Collects and stores logs when possible
     */
    async collectDeviceLogs () {
        if (this.isIosDevice) {
            logger.info('[paramedic] Device logs are not collected from a physical iOS device');
            return;
        }
        logger.info('[paramedic] Collecting Device Logs');
        const outputDir = this.config.getOutputDir() ? this.config.getOutputDir() : this.tempFolder.name;
        const paramedicLogCollector = new ParamedicLogCollector(this.config.getPlatformId(), this.tempFolder.name, outputDir, this.targetObj);
        await paramedicLogCollector.collectLogs();
    }

    uninstallApp () {
        if (this.isIosDevice) {
            logger.info('[paramedic] The app stays on the physical iOS device');
            return Promise.resolve();
        }
        logger.info('[paramedic] Uninstalling App');
        const paramedicAppUninstall = new ParamedicAppUninstall(this.tempFolder.name, this.config.getPlatformId());
        return paramedicAppUninstall.uninstallApp(this.targetObj, this.config.getAppId() || utilities.PARAMEDIC_DEFAULT_APP_NAME);
    }
}

let storedCWD = null;

exports.run = function (paramedicConfig) {
    storedCWD = storedCWD || process.cwd();

    const runner = new ParamedicRunner(paramedicConfig, null);
    runner.storedCWD = storedCWD;

    return runner.run();
};
