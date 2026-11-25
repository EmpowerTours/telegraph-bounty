// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BountyEscrow
/// @notice A poster locks a native-token reward for a target (hash of the vulnerable and
/// patched sources) plus a stated invariant (hash of its text). The poster names a verifier,
/// which must be a different address from the poster.
///
/// Hunters commit `commitment = keccak256(abi.encode(proofHash, hunter, id))` on-chain, where
/// `proofHash` is the keccak256 of the proof source. The commitment binds the proof to the
/// committing hunter and to this bounty, and it is stored under the sender's own address, so:
///   - a copier who replays someone else's commitment stores it under the copier's address,
///     where it can never match a recomputation (the copier's address is not in it);
///   - the copy does not block the real hunter's own commit of the same value;
///   - a commitment cannot be replayed on another bounty (the id is in it).
///
/// The proof itself goes to the verifier off-chain together with the hunter's address. The
/// verifier runs the deterministic check (proof must break the invariant on the vulnerable
/// target and must not break it on the patched one) and calls resolve(id, proofHash, hunter,
/// ...). The contract recomputes the commitment from (proofHash, hunter, id) and requires that
/// `hunter` itself committed it. Each commitment gets exactly one stored verdict (Rejected or
/// Paid); a valid verdict settles the bounty and credits the reward to `hunter`. Payouts are
/// pulled with withdraw(). If nothing valid is resolved by deadline + RESOLVE_WINDOW, the
/// poster can reclaim.
///
/// Trust model: the verifier is still the single oracle for validity. There is deliberately no
/// on-chain challenge window (see README, "Security fixes after Ultrafuzz").
contract BountyEscrow {
    uint64 public constant RESOLVE_WINDOW = 1 days;

    enum Verdict {
        None,
        Rejected,
        Paid
    }

    struct Bounty {
        address poster;
        uint64 deadline;
        bool settled;
        address verifier;
        uint96 reward;
        bytes32 targetHash;
        bytes32 invariantHash;
    }

    struct Commit {
        uint64 committedAt; // block.timestamp of the commit; 0 = never committed
        Verdict verdict;
    }

    uint256 public nextId;
    mapping(uint256 => Bounty) public bounties;
    /// @notice bountyId => commitment => committer => commit record. Keyed by the sender, so a
    /// copied commitment lives under the copier and never under the hunter it was copied from.
    mapping(uint256 => mapping(bytes32 => mapping(address => Commit))) public commits;
    /// @notice Pull-payment balances (hunter rewards and poster reclaims).
    mapping(address => uint256) public owed;

    event Posted(
        uint256 indexed id,
        address indexed poster,
        address indexed verifier,
        uint256 reward,
        uint64 deadline,
        bytes32 targetHash,
        bytes32 invariantHash
    );
    event Submitted(uint256 indexed id, bytes32 indexed commitment, address indexed hunter);
    event Paid(uint256 indexed id, bytes32 indexed proofHash, address indexed hunter, uint256 reward, bytes32 verdictHash);
    event Rejected(uint256 indexed id, bytes32 indexed proofHash, address indexed hunter, bytes32 verdictHash);
    event Reclaimed(uint256 indexed id, address indexed poster, uint256 reward);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroReward();
    error RewardTooLarge();
    error ZeroVerifier();
    error VerifierIsPoster();
    error BadDeadline();
    error UnknownBounty();
    error AlreadySettled();
    error SubmissionClosed();
    error ZeroCommitment();
    error AlreadySubmitted();
    error NotVerifier();
    error NotSubmitted();
    error AlreadyResolved();
    error ResolveWindowClosed();
    error NotPoster();
    error TooEarly();
    error NothingOwed();
    error TransferFailed();

    /// @notice The value a hunter commits for `proofHash` on bounty `id`.
    function commitmentOf(uint256 id, bytes32 proofHash, address hunter) public pure returns (bytes32) {
        return keccak256(abi.encode(proofHash, hunter, id));
    }

    /// @notice Stored verdict for `hunter`'s commitment of `proofHash` on bounty `id`.
    function verdictOf(uint256 id, bytes32 proofHash, address hunter) external view returns (Verdict) {
        return commits[id][commitmentOf(id, proofHash, hunter)][hunter].verdict;
    }

    function post(address verifier, uint64 deadline, bytes32 targetHash, bytes32 invariantHash)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value == 0) revert ZeroReward();
        if (msg.value > type(uint96).max) revert RewardTooLarge();
        if (verifier == address(0)) revert ZeroVerifier();
        if (verifier == msg.sender) revert VerifierIsPoster();
        if (deadline <= block.timestamp) revert BadDeadline();

        id = nextId++;
        bounties[id] = Bounty({
            poster: msg.sender,
            deadline: deadline,
            settled: false,
            verifier: verifier,
            reward: uint96(msg.value),
            targetHash: targetHash,
            invariantHash: invariantHash
        });
        emit Posted(id, msg.sender, verifier, msg.value, deadline, targetHash, invariantHash);
    }

    /// @notice Commit `commitmentOf(id, proofHash, msg.sender)`. Only the commitment goes
    /// on-chain; the proof is handed to the verifier off-chain, so committing does not leak the
    /// exploit, and the proof hash itself is not revealed until resolve().
    function submit(uint256 id, bytes32 commitment) external {
        Bounty storage b = _get(id);
        if (b.settled) revert AlreadySettled();
        if (block.timestamp > b.deadline) revert SubmissionClosed();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        Commit storage c = commits[id][commitment][msg.sender];
        if (c.committedAt != 0) revert AlreadySubmitted();
        c.committedAt = uint64(block.timestamp);
        emit Submitted(id, commitment, msg.sender);
    }

    /// @notice Record the deterministic verdict for `hunter`'s committed proof. `verdictHash`
    /// is the keccak256 of the verifier's canonical verdict JSON, for off-chain evidence
    /// matching. Each commitment can be resolved once; a valid verdict settles the bounty.
    function resolve(uint256 id, bytes32 proofHash, address hunter, bool valid, bytes32 verdictHash) external {
        Bounty storage b = _get(id);
        if (msg.sender != b.verifier) revert NotVerifier();
        if (b.settled) revert AlreadySettled();
        if (block.timestamp > uint256(b.deadline) + RESOLVE_WINDOW) revert ResolveWindowClosed();
        // committedAt != 0 under key `hunter` means `hunter` itself sent this exact commitment.
        Commit storage c = commits[id][commitmentOf(id, proofHash, hunter)][hunter];
        if (c.committedAt == 0) revert NotSubmitted();
        if (c.verdict != Verdict.None) revert AlreadyResolved();

        if (!valid) {
            c.verdict = Verdict.Rejected;
            emit Rejected(id, proofHash, hunter, verdictHash);
            return;
        }
        c.verdict = Verdict.Paid;
        b.settled = true;
        uint256 reward = b.reward;
        owed[hunter] += reward;
        emit Paid(id, proofHash, hunter, reward, verdictHash);
    }

    function reclaim(uint256 id) external {
        Bounty storage b = _get(id);
        if (msg.sender != b.poster) revert NotPoster();
        if (b.settled) revert AlreadySettled();
        if (block.timestamp <= uint256(b.deadline) + RESOLVE_WINDOW) revert TooEarly();
        b.settled = true;
        uint256 reward = b.reward;
        owed[msg.sender] += reward;
        emit Reclaimed(id, msg.sender, reward);
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function _get(uint256 id) private view returns (Bounty storage b) {
        b = bounties[id];
        if (b.poster == address(0)) revert UnknownBounty();
    }
}
