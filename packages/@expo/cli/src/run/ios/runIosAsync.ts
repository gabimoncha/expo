import spawnAsync from '@expo/spawn-async';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

import * as XcodeBuild from './XcodeBuild';
import type { Options } from './XcodeBuild.types';
import { exportEagerAsync } from '../../export/embed/exportEager';
import * as Log from '../../log';
import { AppleAppIdResolver } from '../../start/platforms/ios/AppleAppIdResolver';
import { getContainerPathAsync, simctlAsync } from '../../start/platforms/ios/simctl';
import { resolveBuildCache, uploadBuildCache } from '../../utils/build-cache-providers';
import { maybePromptToSyncPodsAsync } from '../../utils/cocoapods';
import { CommandError } from '../../utils/errors';
import { setNodeEnv } from '../../utils/nodeEnv';
import { ensurePortAvailabilityAsync } from '../../utils/port';
import { profile } from '../../utils/profile';
import { getSchemesForIosAsync } from '../../utils/scheme';
import { ensureNativeProjectAsync } from '../ensureNativeProject';
import { logProjectLogsLocation } from '../hints';
import { startBundlerAsync } from '../startBundler';
import { getLaunchInfoForBinaryAsync, launchAppAsync } from './launchApp';
import { resolveOptionsAsync } from './options/resolveOptions';
import { getValidBinaryPathAsync } from './validateExternalBinary';

const debug = require('debug')('expo:run:ios');

export async function runIosAsync(projectRoot: string, options: Options) {
  setNodeEnv(options.configuration === 'Release' ? 'production' : 'development');
  require('@expo/env').load(projectRoot);

  assertPlatform();

  const install = !!options.install;

  if (
    (await ensureNativeProjectAsync(projectRoot, {
      platform: 'ios',
      install,
    })) &&
    install
  ) {
    await maybePromptToSyncPodsAsync(projectRoot);
  }

  // Resolve the CLI arguments into useable options.
  const props = await profile(resolveOptionsAsync)(projectRoot, options);

  if (!options.binary && options.withArchive) {
    // For device builds, we cache archives (.xcarchive)
    const archivePath = path.join(
      props.projectRoot,
      '.expo',
      'archives',
      `${props.scheme}.xcarchive`
    );

    Log.log('Found cached archive, exporting signed IPA...');
    const ipaPath = await XcodeBuild.exportArchiveAsync(archivePath, projectRoot);
    options.binary = ipaPath;
  } else if (!options.binary && props.buildCacheProvider && props.isSimulator) {
    const localPath = await resolveBuildCache({
      projectRoot,
      platform: 'ios',
      runOptions: options,
      provider: props.buildCacheProvider,
    });
    if (localPath) {
      options.binary = localPath;
    }
  }

  if (options.rebundle) {
    Log.warn(`The --unstable-rebundle flag is experimental and may not work as expected.`);
    // Get the existing binary path to re-bundle the app.

    let binaryPath: string;
    if (!options.binary) {
      if (!props.isSimulator) {
        throw new Error('Re-bundling on physical devices requires the --binary flag.');
      }
      const appId = await new AppleAppIdResolver(projectRoot).getAppIdAsync();
      const possibleBinaryPath = await getContainerPathAsync(props.device, {
        appId,
      });
      if (!possibleBinaryPath) {
        throw new CommandError(
          `Cannot rebundle because no --binary was provided and no existing binary was found on the device for ID: ${appId}.`
        );
      }
      binaryPath = possibleBinaryPath;
      Log.log('Re-using existing binary path:', binaryPath);
      // Set the binary path to the existing binary path.
      options.binary = binaryPath;
    }

    Log.log('Rebundling the Expo config file');
    // Re-bundle the config file the same way the app was originally bundled.
    await spawnAsync('node', [
      path.join(require.resolve('expo-constants/package.json'), '../scripts/getAppConfig.js'),
      projectRoot,
      path.join(options.binary, 'EXConstants.bundle'),
    ]);
    // Re-bundle the app.

    const possibleBundleOutput = path.join(options.binary, 'main.jsbundle');

    if (fs.existsSync(possibleBundleOutput)) {
      Log.log('Rebundling the app...');
      await exportEagerAsync(projectRoot, {
        resetCache: false,
        dev: false,
        platform: 'ios',
        assetsDest: path.join(options.binary, 'assets'),
        bundleOutput: possibleBundleOutput,
      });
    } else {
      Log.warn('Bundle output not found at expected location:', possibleBundleOutput);
    }
  }

  let binaryPath: string;
  let shouldUpdateBuildCache = false;
  let archivePath: string | undefined;
  if (options.binary) {
    binaryPath = await getValidBinaryPathAsync(options.binary, props);
    Log.log('Using custom binary path:', binaryPath);
  } else {
    let eagerBundleOptions: string | undefined;

    if (options.configuration === 'Release') {
      eagerBundleOptions = JSON.stringify(
        await exportEagerAsync(projectRoot, {
          dev: false,
          platform: 'ios',
        })
      );
    }

    if (!props.isSimulator && props.buildCacheProvider && options.withArchive) {
      // Step 1: Build and create archive
      archivePath = await XcodeBuild.archiveAsync({
        ...props,
        eagerBundleOptions,
      });

      // Step 2: Export archive to signed IPA
      binaryPath = await XcodeBuild.exportArchiveAsync(archivePath, projectRoot);
    } else {
      const buildOutput = await XcodeBuild.buildAsync({
        ...props,
        eagerBundleOptions,
      });

      binaryPath = profile(XcodeBuild.getAppBinaryPath)(buildOutput);
    }
    shouldUpdateBuildCache = true;
  }
  debug('Binary path:', binaryPath);

  // Ensure the port hasn't become busy during the build.
  if (props.shouldStartBundler && !(await ensurePortAvailabilityAsync(projectRoot, props))) {
    props.shouldStartBundler = false;
  }

  const launchInfo = await getLaunchInfoForBinaryAsync(binaryPath);
  const isCustomBinary = !!options.binary;

  // Always close the app before launching on a simulator. Otherwise certain cached resources like the splashscreen will not be available.
  if (props.isSimulator) {
    try {
      await simctlAsync(['terminate', props.device.udid, launchInfo.bundleId]);
    } catch (error) {
      // If we failed it's likely that the app was not running to begin with and we will get an `invalid device` error
      debug('Failed to terminate app (possibly because it was not running):', error);
    }
  }

  // Start the dev server which creates all of the required info for
  // launching the app on a simulator.
  const manager = await startBundlerAsync(projectRoot, {
    port: props.port,
    headless: !props.shouldStartBundler,
    // If a scheme is specified then use that instead of the package name.

    scheme: isCustomBinary
      ? // If launching a custom binary, use the schemes in the Info.plist.
        launchInfo.schemes[0]
      : // If a scheme is specified then use that instead of the package name.
        (await getSchemesForIosAsync(projectRoot))?.[0],
  });

  // Install and launch the app binary on a device.
  await launchAppAsync(
    binaryPath,
    manager,
    {
      isSimulator: props.isSimulator,
      device: props.device,
      shouldStartBundler: props.shouldStartBundler,
    },
    launchInfo.bundleId
  );

  // Log the location of the JS logs for the device.
  if (props.shouldStartBundler) {
    logProjectLogsLocation();
  } else {
    await manager.stopAsync();
  }

  if (shouldUpdateBuildCache && props.buildCacheProvider) {
    const cacheKey = !props.isSimulator && archivePath ? { unsigned: true } : {};

    await uploadBuildCache({
      projectRoot,
      platform: 'ios',
      provider: props.buildCacheProvider,
      buildPath: archivePath || binaryPath,
      runOptions: { ...options, ...cacheKey },
    });

    // TODO: save the archive with a different fingerprint or smth
    // if (archivePath) {
    //   fs.rmSync(archivePath, { recursive: true, force: true });
    // }
  }
}

function assertPlatform() {
  if (process.platform !== 'darwin') {
    Log.exit(
      chalk`iOS apps can only be built on macOS devices. Use {cyan eas build -p ios} to build in the cloud.`
    );
  }
}
