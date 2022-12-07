import { type ExecutorContext } from '@nrwl/devkit';
import { concat, defer, forkJoin, lastValueFrom, merge, of } from 'rxjs';
import { catchError, concatMap, reduce, switchMap } from 'rxjs/operators';
import type { VersionBuilderSchema } from './schema';
import {
  calculateChangelogChanges,
  defaultHeader,
  getChangelogPath,
} from './utils/changelog';
import { formatCommitMessage } from './utils/commit';
import {
  getDependencyRoots,
  type DependencyRoot,
} from './utils/get-project-dependencies';
import { tryPush } from './utils/git';
import { _logStep } from './utils/logger';
import { runTargets } from './utils/run-targets';
import { formatTag, formatTagPrefix } from './utils/tag';
import { tryBump } from './utils/try-bump';
import { getProjectRoot } from './utils/workspace';
import {
  versionProject,
  versionWorkspace,
  type CommonVersionOptions,
} from './version';

export default async function version(
  options: VersionBuilderSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const {
    push,
    remote,
    dryRun,
    trackDeps,
    baseBranch,
    noVerify,
    syncVersions,
    skipRootChangelog,
    skipProjectChangelog,
    releaseAs,
    preid,
    changelogHeader,
    versionTagPrefix,
    postTargets,
    commitMessageFormat,
    preset,
    allowEmptyRelease,
    skipCommitTypes,
    skipCommit,
    preCommitTargets,
    postCommitTargets,
  } = _normalizeOptions(options);
  const workspaceRoot = context.root;
  const projectName = context.projectName as string;

  let dependencyRoots: DependencyRoot[] = [];
  try {
    dependencyRoots = await getDependencyRoots({
      projectName,
      releaseAs,
      trackDeps,
      context,
    });
  } catch (e) {
    _logStep({
      step: 'failure',
      level: 'error',
      message: `Failed to determine dependencies.
      Please report an issue: https://github.com/jscutlery/semver/issues/new.`,
      projectName,
    });
    return { success: false };
  }

  const tagPrefix = formatTagPrefix({
    versionTagPrefix,
    projectName,
    syncVersions,
  });
  const projectRoot = getProjectRoot(context);
  const newVersion$ = tryBump({
    preset,
    projectRoot,
    dependencyRoots,
    tagPrefix,
    releaseType: releaseAs,
    preid,
    syncVersions,
    allowEmptyRelease,
    skipCommitTypes,
    projectName,
  });

  const changelogPath = getChangelogPath(
    syncVersions ? workspaceRoot : projectRoot
  );

  const run$ = forkJoin({
    newVersion: newVersion$,
    changelog: newVersion$.pipe(
      calculateChangelogChanges({
        changelogHeader,
        changelogPath,
      })
    ),
  });

  const runSemver$ = run$.pipe(
    switchMap(({ newVersion, changelog }) => {
      if (newVersion == null) {
        _logStep({
          step: 'nothing_changed',
          level: 'info',
          message: 'Nothing changed since last release.',
          projectName,
        });
        return of({ success: true });
      }

      _logStep({
        step: 'calculate_version_success',
        message: `Calculated new version "${newVersion.version}".`,
        projectName,
      });

      const { version, dependencyUpdates } = newVersion;
      const tag = formatTag({ tagPrefix, version });
      const commitMessage = formatCommitMessage({
        projectName,
        commitMessageFormat,
        version,
      });

      const options: CommonVersionOptions = {
        context,
        newVersion: version,
        changelog,
        tag,
        dryRun,
        trackDeps,
        noVerify,
        preset,
        tagPrefix,
        changelogHeader,
        workspaceRoot,
        projectName,
        skipProjectChangelog,
        commitMessage,
        dependencyUpdates,
        skipCommit,
        preCommitTargets,
        postCommitTargets,
      };

      const version$ = defer(() =>
        syncVersions
          ? versionWorkspace({
              ...options,
              projectRoot,
              skipRootChangelog,
            })
          : versionProject({
              ...options,
              projectRoot,
            })
      );

      const push$ = defer(() =>
        tryPush({
          tag,
          branch: baseBranch,
          noVerify,
          remote,
          projectName,
        })
      );

      const _runPostTargets = ({ notes }: { notes: string }) =>
        defer(() =>
          runTargets({
            context,
            projectName,
            targets: postTargets,
            templateStringContext: {
              notes,
              version,
              projectName,
              tag,
            },
          })
        );

      return version$.pipe(
        concatMap((notes) =>
          concat(
            ...(push && dryRun === false ? [push$] : []),
            ...(dryRun === false ? [_runPostTargets({ notes })] : [])
          )
        ),
        reduce((result) => result, { success: true })
      );
    })
  );

  return lastValueFrom(
    runSemver$.pipe(
      catchError((error) => {
        _logStep({
          step: 'failure',
          level: 'error',
          message: _toErrorMessage(error),
          projectName,
        });
        return of({ success: false });
      })
    )
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _toErrorMessage(error: any): string {
  return error.stack ?? error.toString();
}

function _normalizeOptions(options: VersionBuilderSchema) {
  return {
    ...options,
    push: options.push as boolean,
    remote: options.remote as string,
    dryRun: options.dryRun as boolean,
    trackDeps: options.trackDeps as boolean,
    baseBranch: options.baseBranch as string,
    noVerify: options.noVerify as boolean,
    syncVersions: options.syncVersions as boolean,
    skipRootChangelog: options.skipRootChangelog as boolean,
    skipProjectChangelog: options.skipProjectChangelog as boolean,
    allowEmptyRelease: options.allowEmptyRelease as boolean,
    skipCommitTypes: options.skipCommitTypes as string[],
    releaseAs: options.releaseAs ?? options.version,
    changelogHeader: options.changelogHeader ?? defaultHeader,
    versionTagPrefix: options.tagPrefix ?? options.versionTagPrefix,
    commitMessageFormat: options.commitMessageFormat as string,
    skipCommit: options.skipCommit as boolean,
    preset:
      options.preset === 'conventional'
        ? 'conventionalcommits'
        : options.preset || 'angular',
  };
}
