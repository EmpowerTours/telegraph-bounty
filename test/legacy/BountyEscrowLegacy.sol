// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BountyEscrowLegacy (pre-fix copy, test-only)
/// @dev Verbatim copy of src/BountyEscrow.sol at 0184e16, renamed. Kept ONLY so the front-run
/// regression test can show the old contract paying the copier. Never deploy it.
/// @notice A poster locks a native-token reward for a target (hash of the vulnerable and
/// patched sources) plus a stated invariant (hash of its text). Hunters commit the hash of
/// their proof on-chain; the first committer of a given proof hash owns it. The poster-named
/// verifier runs the deterministic check off-chain (proof must break the invariant on the
/// vulnerable target and must not break it on the patched one) and resolves. A valid proof
/// credits the reward to its committer; payouts are pulled with withdraw().
/// If nothing valid is resolved by deadline + RESOLVE_WINDOW, the poster can reclaim.
contract BountyEscrowLegacy {
    uint64 public constant RESOLVE_WINDOW = 1 days;

    struct Bounty {
        address poster;
        uint64 deadline;
        bool settled;
        address verifier;
        uint96 reward;
        bytes32 targetHash;
        bytes32 invariantHash;
    }

    uint256 public nextId;
    mapping(uint256 => Bounty) public bounties;
    /// @notice bountyId => proofHash => first address that committed it.
    mapping(uint256 => mapping(bytes32 => address)) public submitterOf;
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
    event Submitted(uint256 indexed id, bytes32 indexed proofHash, address indexed hunter);
    event Paid(uint256 indexed id, bytes32 indexed proofHash, address indexed hunter, uint256 reward, bytes32 verdictHash);
    event Rejected(uint256 indexed id, bytes32 indexed proofHash, address indexed hunter, bytes32 verdictHash);
    event Reclaimed(uint256 indexed id, address indexed poster, uint256 reward);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroReward();
    error RewardTooLarge();
    error ZeroVerifier();
    error BadDeadline();
    error UnknownBounty();
    error AlreadySettled();
    error SubmissionClosed();
    error ZeroProofHash();
    error AlreadySubmitted();
    error NotVerifier();
    error NotSubmitted();
    error ResolveWindowClosed();
    error NotPoster();
    error TooEarly();
    error NothingOwed();
    error TransferFailed();

    function post(address verifier, uint64 deadline, bytes32 targetHash, bytes32 invariantHash)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value == 0) revert ZeroReward();
        if (msg.value > type(uint96).max) revert RewardTooLarge();
        if (verifier == address(0)) revert ZeroVerifier();
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

    /// @notice Commit a proof hash. Only the hash goes on-chain; the proof itself is handed
    /// to the verifier off-chain, so committing does not leak the exploit.
    function submit(uint256 id, bytes32 proofHash) external {
        Bounty storage b = _get(id);
        if (b.settled) revert AlreadySettled();
        if (block.timestamp > b.deadline) revert SubmissionClosed();
        if (proofHash == bytes32(0)) revert ZeroProofHash();
        if (submitterOf[id][proofHash] != address(0)) revert AlreadySubmitted();
        submitterOf[id][proofHash] = msg.sender;
        emit Submitted(id, proofHash, msg.sender);
    }

    /// @notice Record the deterministic verdict for a committed proof. `verdictHash` is the
    /// keccak256 of the verifier's canonical verdict JSON, for off-chain evidence matching.
    function resolve(uint256 id, bytes32 proofHash, bool valid, bytes32 verdictHash) external {
        Bounty storage b = _get(id);
        if (msg.sender != b.verifier) revert NotVerifier();
        if (b.settled) revert AlreadySettled();
        if (block.timestamp > uint256(b.deadline) + RESOLVE_WINDOW) revert ResolveWindowClosed();
        address hunter = submitterOf[id][proofHash];
        if (hunter == address(0)) revert NotSubmitted();

        if (!valid) {
            emit Rejected(id, proofHash, hunter, verdictHash);
            return;
        }
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
