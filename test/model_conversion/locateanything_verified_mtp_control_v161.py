"""Research-only greedy verification control;no model/backend/service imports.

MTP proposals have no authority. A causal target first-token prediction and
causal verification logits determine every emitted token. Discard everything
after the first mismatch. Complete blocks keep their boundary token pending
instead of emitting a non-EOS bonus,so the next box can be proposed as a block.
This pure control logic does not prove numerical equality between compiled
multirow verification and current AR1,or a speed benefit on any device.
"""


def select_verified_prefix(proposal, first_target, verified_next, eos, remaining):
    """Return tokens and how many verified-input KV rows to retain.

    Before this step one generated token is pending. The proposer processes
    that token into a target prefix cache of length G. With emitted length N,
    retain prefix G+N-1:the last emitted token remains pending. verified_next[i]
    is the target prediction AFTER proposal[i],not at the same token position.
    No probability sampling or changed repetition penalty is introduced.
    """
    assert isinstance(remaining, int) and remaining > 0
    assert isinstance(first_target, int) and isinstance(eos, int)
    assert all(isinstance(x, int) for x in proposal)
    # The target can immediately end or reject the very first proposal. In
    # that case no speculative verification pass is needed or consulted.
    if remaining == 1 or first_target == eos or not proposal or proposal[0] != first_target:
        return [first_target], 0
    assert verified_next is not None and len(verified_next) >= len(proposal)
    assert all(isinstance(x, int) for x in verified_next)
    accepted = [first_target]
    for index in range(1, min(len(proposal), remaining)):
        target = verified_next[index - 1]
        accepted.append(target)
        if target == eos or proposal[index] != target:
            return accepted, len(accepted) - 1
    # Only an EOS bonus is consumed. A normal bonus might move the pending
    # position inside the next box and defeat boundary-aligned proposals.
    if len(accepted) < remaining and len(accepted) == len(proposal):
        bonus = verified_next[len(proposal) - 1]
        if bonus == eos:
            accepted.append(bonus)
    assert 1 <= len(accepted) <= remaining
    return accepted, len(accepted) - 1
