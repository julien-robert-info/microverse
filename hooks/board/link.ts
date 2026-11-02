// Rule E-2: which mission an agent works on. Exported for the Agents screen
// and the brief summary, which need the same answer.

export type LinkRow = { id: string; branch: string | null; isRange: boolean }

export type LinkAgent = {
  agentId: string
  description: string
  // The branch of the brief the store holds for this agent, when there is one.
  briefBranch?: string
}

export type LinkTree = { branch: string; path: string }

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

// A worktree made for an agent sits at `.claude/worktrees/agent-<agentId>`.
const treeOf = (agentId: string, trees: LinkTree[]) =>
  trees.find(tree => tree.path.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(`/agent-${agentId}`))

// In this order: the brief's branch, the branch of the agent's worktree, a
// token of the description that is a mission Id (`E33a` and `E33f2` give `E33`). A range
// such as `E1-E29` is never a target. Null when nothing matches.
export const linkAgent = (agent: LinkAgent, rows: LinkRow[], trees: LinkTree[]): string | null => {
  const targets = rows.filter(row => !row.isRange)
  const byBranch = (branch: string | undefined) =>
    branch === undefined || branch === ''
      ? null
      : (targets.find(row => row.branch !== null && same(row.branch, branch))?.id ?? null)

  const fromBrief = byBranch(agent.briefBranch)
  if (fromBrief !== null) {
    return fromBrief
  }
  const fromTree = byBranch(treeOf(agent.agentId, trees)?.branch)
  if (fromTree !== null) {
    return fromTree
  }
  for (const token of agent.description.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    const exact = targets.find(row => row.id === token)
    if (exact !== undefined) {
      return exact.id
    }
    // A sub-mission suffix is a letter and an optional number (`E33f2`); an
    // exact row, tried above, always wins over the stem.
    const stem = targets.find(row => row.id === token.replace(/[a-z]\d*$/, ''))
    if (stem !== undefined && token !== stem.id) {
      return stem.id
    }
  }

  return null
}
