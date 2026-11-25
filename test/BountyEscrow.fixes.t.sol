// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {BountyEscrowLegacy} from "./legacy/BountyEscrowLegacy.sol";

/// Regression tests for the Ultrafuzz bounty-002 findings (2026-11-24).
contract BountyEscrowFixesTest is Test {
    BountyEscrow internal escrow;
    BountyEscrowLegacy internal legacy;
    address internal poster = address(0xB0573);
    address internal verifier = address(0x7E21F);
    address internal hunter = address(0x4A47);
    address internal attacker = address(0xBADBAD);
    bytes32 internal constant TARGET = keccak256("target");
    bytes32 internal constant INV = keccak256("balance == totalDeposits");
    bytes32 internal constant PROOF = keccak256("proof");
    bytes32 internal constant VERDICT = keccak256("verdict");

    function setUp() public {
        escrow = new BountyEscrow();
        legacy = new BountyEscrowLegacy();
        vm.deal(poster, 100 ether);
    }

    /// Computed locally (not via escrow.commitmentOf) so it does not consume a vm.prank;
    /// test_commitmentEncoding pins it to the contract's own encoding.
    function _c(uint256 id, bytes32 proofHash, address h) internal pure returns (bytes32) {
        return keccak256(abi.encode(proofHash, h, id));
    }

    function _post(uint256 reward) internal returns (uint256 id) {
        vm.prank(poster);
        id = escrow.post{value: reward}(verifier, uint64(block.timestamp + 7 days), TARGET, INV);
    }

    // ---------------------------------------------------------------- HIGH: front-running

    /// BEFORE: the old contract pays whoever first sends the proof hash. The attacker copies
    /// the hunter's pending submit(id, proofHash) from the mempool and lands first; the hunter's
    /// own tx reverts; the verifier checks the (real hunter's) proof and the attacker is paid.
    function test_frontRun_legacyPaysTheCopier() public {
        vm.prank(poster);
        uint256 id = legacy.post{value: 1 ether}(verifier, uint64(block.timestamp + 7 days), TARGET, INV);

        vm.prank(attacker); // front-run: same calldata, higher priority
        legacy.submit(id, PROOF);
        vm.prank(hunter); // the hunter's original tx lands second
        vm.expectRevert(BountyEscrowLegacy.AlreadySubmitted.selector);
        legacy.submit(id, PROOF);

        vm.prank(verifier); // verifier checks the hunter's proof body: valid
        legacy.resolve(id, PROOF, true, VERDICT);

        assertEq(legacy.owed(attacker), 1 ether, "legacy: copier is paid");
        assertEq(legacy.owed(hunter), 0, "legacy: real hunter gets nothing");
        vm.prank(attacker);
        legacy.withdraw();
        assertEq(attacker.balance, 1 ether);
    }

    /// AFTER: the same attack against the fixed contract. The copied commitment is stored under
    /// the attacker's address, it does not block the hunter, the hunter is paid, and no hunter
    /// argument the verifier could pass makes the attacker's copy payable.
    function test_frontRun_fixedRefusesTheCopier() public {
        uint256 id = _post(1 ether);
        bytes32 c = _c(id, PROOF, hunter);

        vm.prank(attacker); // front-run: copies the hunter's commitment byte for byte
        escrow.submit(id, c);
        vm.prank(hunter); // not blocked by the copy
        escrow.submit(id, c);

        // Paying the attacker for this proof is impossible: the commitment recomputed with the
        // attacker's address is a different key that nobody committed.
        vm.startPrank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, PROOF, attacker, true, VERDICT);

        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        vm.stopPrank();
        assertEq(escrow.owed(hunter), 1 ether, "fixed: real hunter is paid");
        assertEq(escrow.owed(attacker), 0, "fixed: copier gets nothing");
        vm.prank(attacker);
        vm.expectRevert(BountyEscrow.NothingOwed.selector);
        escrow.withdraw();
    }

    /// A copier who front-runs and the hunter never commits at all (e.g. the hunter's tx is
    /// censored): the copy is still worthless, the bounty stays open.
    function test_frontRun_copyAloneIsNeverPayable() public {
        uint256 id = _post(1 ether);
        bytes32 c = _c(id, PROOF, hunter);
        vm.prank(attacker);
        escrow.submit(id, c);
        vm.startPrank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT); // hunter never committed it
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, PROOF, attacker, true, VERDICT);
        vm.stopPrank();
        (,, bool settled,,,,) = escrow.bounties(id);
        assertFalse(settled);
    }

    /// Cross-bounty replay: a commitment confirmed on bounty A cannot be reused on bounty B,
    /// by the attacker or even by the hunter, because the bounty id is inside it.
    function test_crossBountyReplay_refused() public {
        uint256 a = _post(1 ether);
        uint256 b = _post(1 ether);
        bytes32 cA = _c(a, PROOF, hunter);
        vm.prank(hunter);
        escrow.submit(a, cA);
        vm.prank(attacker);
        escrow.submit(b, cA); // replay A's public commitment on B
        vm.prank(hunter);
        escrow.submit(b, cA); // even the hunter replaying it on B

        vm.startPrank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(b, PROOF, attacker, true, VERDICT);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(b, PROOF, hunter, true, VERDICT);
        escrow.resolve(a, PROOF, hunter, true, VERDICT);
        vm.stopPrank();
        assertEq(escrow.owed(hunter), 1 ether);
        assertEq(escrow.owed(attacker), 0);
        (,, bool settledB,,,,) = escrow.bounties(b);
        assertFalse(settledB);
    }

    function test_commitmentEncoding() public view {
        assertEq(escrow.commitmentOf(7, PROOF, hunter), keccak256(abi.encode(PROOF, hunter, uint256(7))));
    }

    function test_zeroCommitmentRejected() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        vm.expectRevert(BountyEscrow.ZeroCommitment.selector);
        escrow.submit(id, bytes32(0));
    }

    function test_resolveZeroHunterRefused() public {
        uint256 id = _post(1 ether);
        vm.prank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, PROOF, address(0), true, VERDICT);
    }

    /// Fuzz: for any proof, bounty and pair of distinct accounts, a commitment copied by `copier`
    /// can never be resolved in the copier's favour, and never blocks the hunter.
    function testFuzz_onlyCommittingHunterCanBePaid(bytes32 proofHash, address h, address copier, uint96 reward)
        public
    {
        vm.assume(h != address(0) && copier != address(0) && h != copier);
        vm.assume(h != poster && copier != poster && h != verifier && copier != verifier);
        reward = uint96(bound(reward, 1, 100 ether));
        uint256 id = _post(reward);
        bytes32 c = _c(id, proofHash, h);
        vm.prank(copier);
        escrow.submit(id, c);
        vm.prank(h);
        escrow.submit(id, c);
        vm.startPrank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, proofHash, copier, true, VERDICT);
        escrow.resolve(id, proofHash, h, true, VERDICT);
        vm.stopPrank();
        assertEq(escrow.owed(h), reward);
        assertEq(escrow.owed(copier), 0);
        assertEq(uint8(escrow.verdictOf(id, proofHash, h)), uint8(BountyEscrow.Verdict.Paid));
    }

    // ------------------------------------------------------ MEDIUM: poster as own verifier

    function test_posterCannotBeVerifier() public {
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.VerifierIsPoster.selector);
        escrow.post{value: 1 ether}(poster, uint64(block.timestamp + 7 days), TARGET, INV);
        assertEq(escrow.nextId(), 0);
    }

    function testFuzz_posterCannotBeVerifier(address p) public {
        vm.assume(p != address(0) && p.code.length == 0 && uint160(p) > 0x100);
        vm.deal(p, 1 ether);
        vm.prank(p);
        vm.expectRevert(BountyEscrow.VerifierIsPoster.selector);
        escrow.post{value: 1 ether}(p, uint64(block.timestamp + 7 days), TARGET, INV);
    }

    // ------------------------------------------------------- LOW: verdicts are stored, final

    function test_rejectedIsStoredAndFinal() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.startPrank(verifier);
        escrow.resolve(id, PROOF, hunter, false, VERDICT);
        assertEq(uint8(escrow.verdictOf(id, PROOF, hunter)), uint8(BountyEscrow.Verdict.Rejected));
        // Cannot be re-rejected with a different verdict hash...
        vm.expectRevert(BountyEscrow.AlreadyResolved.selector);
        escrow.resolve(id, PROOF, hunter, false, keccak256("other verdict"));
        // ...nor flipped to Paid later.
        vm.expectRevert(BountyEscrow.AlreadyResolved.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        vm.stopPrank();
        assertEq(escrow.owed(hunter), 0);
        (,, bool settled,,,,) = escrow.bounties(id);
        assertFalse(settled, "a rejection leaves the bounty open for other proofs");
    }

    function test_rejectedOneProof_otherProofStillPayable() public {
        uint256 id = _post(1 ether);
        bytes32 p2 = keccak256("proof2");
        vm.startPrank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        escrow.submit(id, _c(id, p2, hunter));
        vm.stopPrank();
        vm.startPrank(verifier);
        escrow.resolve(id, PROOF, hunter, false, VERDICT);
        escrow.resolve(id, p2, hunter, true, VERDICT);
        vm.stopPrank();
        assertEq(escrow.owed(hunter), 1 ether);
        assertEq(uint8(escrow.verdictOf(id, PROOF, hunter)), uint8(BountyEscrow.Verdict.Rejected));
        assertEq(uint8(escrow.verdictOf(id, p2, hunter)), uint8(BountyEscrow.Verdict.Paid));
    }

    function test_paidIsFinal() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.startPrank(verifier);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        vm.expectRevert(BountyEscrow.AlreadySettled.selector);
        escrow.resolve(id, PROOF, hunter, false, VERDICT);
        vm.stopPrank();
        assertEq(uint8(escrow.verdictOf(id, PROOF, hunter)), uint8(BountyEscrow.Verdict.Paid));
        vm.warp(block.timestamp + 9 days);
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.AlreadySettled.selector);
        escrow.reclaim(id);
        assertEq(escrow.owed(hunter), 1 ether);
    }

    function test_unresolvedVerdictIsNone() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        assertEq(uint8(escrow.verdictOf(id, PROOF, hunter)), uint8(BountyEscrow.Verdict.None));
        (uint64 at, BountyEscrow.Verdict v) = escrow.commits(id, _c(id, PROOF, hunter), hunter);
        assertEq(at, block.timestamp);
        assertEq(uint8(v), 0);
    }
}
