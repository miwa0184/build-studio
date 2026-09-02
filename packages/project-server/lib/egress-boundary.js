'use strict';

const LOCAL_MERGE_REMOVED = 'LOCAL_MERGE_REMOVED';
const DEFAULT_BRANCH_PUSH_REMOVED = 'DEFAULT_BRANCH_PUSH_REMOVED';
const REMOTE_MUTATION_REMOVED = 'REMOTE_MUTATION_REMOVED';
const EGRESS_NOT_INSTALLED = 'not_installed';

const LOCAL_EGRESS_MESSAGE =
  'Local merge egress has been removed. The candidate branch is preserved at the A1c boundary; '
  + 'no checkout, default-branch merge, push, tag, or branch deletion was performed.';

function egressRefusal(code, extra = {}) {
  const messages = {
    [DEFAULT_BRANCH_PUSH_REMOVED]:
      'Pushing the default branch from Build Studio is disabled until A1c installs reviewed PR egress.',
    [REMOTE_MUTATION_REMOVED]:
      'Git remote mutation from Build Studio is disabled until A1c installs reviewed PR egress.',
  };
  return {
    code,
    egress: EGRESS_NOT_INSTALLED,
    error: messages[code] || LOCAL_EGRESS_MESSAGE,
    ...extra,
  };
}

module.exports = {
  LOCAL_MERGE_REMOVED,
  DEFAULT_BRANCH_PUSH_REMOVED,
  REMOTE_MUTATION_REMOVED,
  EGRESS_NOT_INSTALLED,
  LOCAL_EGRESS_MESSAGE,
  egressRefusal,
};
