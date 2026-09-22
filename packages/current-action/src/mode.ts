/**
 * Which half of the Action runs. This branch is the Action's actual control
 * flow and it is deliberately a pure function so it can be tested without a
 * GitHub runner:
 *
 *   pull_request  → comment with the delta, write NOTHING to history
 *   push to base  → append one history entry, refresh the badge, no comment
 *   anything else → compute and report, touch nothing
 *
 * PR runs must never append history: a trend log polluted with speculative
 * branch scores is worse than no trend log, because it looks authoritative.
 */
export type ActionMode = 'pull-request' | 'push-default-branch' | 'inert';

export interface ActionContext {
  eventName: string;
  /** e.g. "refs/heads/main" */
  ref: string | undefined;
  defaultBranch: string | undefined;
  isPullRequest: boolean;
}

export function selectMode(ctx: ActionContext): ActionMode {
  if (ctx.eventName === 'pull_request' || ctx.eventName === 'pull_request_target') {
    return ctx.isPullRequest ? 'pull-request' : 'inert';
  }
  if (
    ctx.eventName === 'push' &&
    ctx.defaultBranch !== undefined &&
    ctx.ref === `refs/heads/${ctx.defaultBranch}`
  ) {
    return 'push-default-branch';
  }
  return 'inert';
}

export function writesHistory(mode: ActionMode): boolean {
  return mode === 'push-default-branch';
}

export function writesComment(mode: ActionMode): boolean {
  return mode === 'pull-request';
}
