// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }

    function submit(BountyEscrow e, uint256 id, bytes32 h) external {
        e.submit(id, h);
    }

    function withdraw(BountyEscrow e) external {
        e.withdraw();
    }
}

contract BountyEscrowTest is Test {
    BountyEscrow internal escrow;
    address internal poster = address(0xB0573);
    address internal verifier = address(0x7E21F);
    address internal hunter = address(0x4A47);
    address internal other = address(0x07E5);
    bytes32 internal constant TARGET = keccak256("target");
    bytes32 internal constant INV = keccak256("balance == totalDeposits");
    bytes32 internal constant PROOF = keccak256("proof");
    bytes32 internal constant VERDICT = keccak256("verdict");

    /// Computed locally (not via escrow.commitmentOf) so it does not consume a vm.prank.
    function _c(uint256 id, bytes32 proofHash, address h) internal pure returns (bytes32) {
        return keccak256(abi.encode(proofHash, h, id));
    }

    function setUp() public {
        escrow = new BountyEscrow();
        vm.deal(poster, 100 ether);
    }

    function _post(uint256 reward) internal returns (uint256 id) {
        vm.prank(poster);
        id = escrow.post{value: reward}(verifier, uint64(block.timestamp + 7 days), TARGET, INV);
    }

    function test_happyPath_paysFirstSubmitter() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.prank(verifier);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        assertEq(escrow.owed(hunter), 1 ether);
        vm.prank(hunter);
        escrow.withdraw();
        assertEq(hunter.balance, 1 ether);
        assertEq(address(escrow).balance, 0);
    }

    function test_rejectedProof_paysNothing_bountyStaysOpen() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.prank(verifier);
        escrow.resolve(id, PROOF, hunter, false, VERDICT);
        assertEq(escrow.owed(hunter), 0);
        (,, bool settled,,,,) = escrow.bounties(id);
        assertFalse(settled);
    }

    function test_cannotPayTwice() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.prank(other);
        escrow.submit(id, _c(id, keccak256("proof2"), other));
        vm.startPrank(verifier);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        vm.expectRevert(BountyEscrow.AlreadySettled.selector);
        escrow.resolve(id, keccak256("proof2"), other, true, VERDICT);
        vm.stopPrank();
    }

    function test_sameSenderCannotCommitTwice() public {
        uint256 id = _post(1 ether);
        vm.startPrank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.expectRevert(BountyEscrow.AlreadySubmitted.selector);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.stopPrank();
    }

    function test_onlyVerifierResolves() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.prank(hunter);
        vm.expectRevert(BountyEscrow.NotVerifier.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
    }

    function test_resolveRequiresSubmission() public {
        uint256 id = _post(1 ether);
        vm.prank(verifier);
        vm.expectRevert(BountyEscrow.NotSubmitted.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
    }

    function test_submitClosedAfterDeadline() public {
        uint256 id = _post(1 ether);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(hunter);
        vm.expectRevert(BountyEscrow.SubmissionClosed.selector);
        escrow.submit(id, _c(id, PROOF, hunter));
    }

    function test_reclaimOnlyAfterWindow_andBlocksResolve() public {
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.warp(block.timestamp + 7 days + 1 days);
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.reclaim(id);
        vm.warp(block.timestamp + 1);
        vm.prank(verifier);
        vm.expectRevert(BountyEscrow.ResolveWindowClosed.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
        vm.prank(poster);
        escrow.reclaim(id);
        assertEq(escrow.owed(poster), 1 ether);
    }

    function test_onlyPosterReclaims() public {
        uint256 id = _post(1 ether);
        vm.warp(block.timestamp + 9 days);
        vm.prank(other);
        vm.expectRevert(BountyEscrow.NotPoster.selector);
        escrow.reclaim(id);
    }

    function test_postValidation() public {
        vm.startPrank(poster);
        vm.expectRevert(BountyEscrow.ZeroReward.selector);
        escrow.post(verifier, uint64(block.timestamp + 1), TARGET, INV);
        vm.expectRevert(BountyEscrow.ZeroVerifier.selector);
        escrow.post{value: 1}(address(0), uint64(block.timestamp + 1), TARGET, INV);
        vm.expectRevert(BountyEscrow.BadDeadline.selector);
        escrow.post{value: 1}(verifier, uint64(block.timestamp), TARGET, INV);
        vm.expectRevert(BountyEscrow.VerifierIsPoster.selector);
        escrow.post{value: 1}(poster, uint64(block.timestamp + 1), TARGET, INV);
        vm.stopPrank();
    }

    function test_unknownBounty() public {
        vm.expectRevert(BountyEscrow.UnknownBounty.selector);
        escrow.submit(42, _c(42, PROOF, other));
    }

    function test_revertingHunterCannotBlockOthers() public {
        RevertingReceiver r = new RevertingReceiver();
        uint256 id = _post(1 ether);
        r.submit(escrow, id, _c(id, PROOF, address(r)));
        vm.prank(verifier);
        escrow.resolve(id, PROOF, address(r), true, VERDICT);
        vm.expectRevert(BountyEscrow.TransferFailed.selector);
        r.withdraw(escrow);
        // Funds stay credited to the hunter; a second bounty is unaffected.
        assertEq(escrow.owed(address(r)), 1 ether);
        uint256 id2 = _post(2 ether);
        vm.prank(hunter);
        escrow.submit(id2, _c(id2, PROOF, hunter));
        vm.prank(verifier);
        escrow.resolve(id2, PROOF, hunter, true, VERDICT);
        vm.prank(hunter);
        escrow.withdraw();
        assertEq(hunter.balance, 2 ether);
    }

    function testFuzz_payoutConservesFunds(uint96 reward, bytes32 proofHash, address h) public {
        vm.assume(reward > 0 && proofHash != bytes32(0));
        vm.assume(h != address(0) && h.code.length == 0 && uint160(h) > 0x100 && h != address(escrow));
        vm.assume(h != address(vm) && h != 0x000000000000000000636F6e736F6c652e6c6f67);
        vm.deal(poster, uint256(reward));
        uint256 id = _post(reward);
        vm.prank(h);
        escrow.submit(id, _c(id, proofHash, h));
        vm.prank(verifier);
        escrow.resolve(id, proofHash, h, true, VERDICT);
        uint256 before = h.balance;
        vm.prank(h);
        escrow.withdraw();
        assertEq(h.balance - before, reward);
        assertEq(address(escrow).balance, 0);
    }

    function testFuzz_onlyVerifierCanResolve(address caller) public {
        vm.assume(caller != verifier);
        uint256 id = _post(1 ether);
        vm.prank(hunter);
        escrow.submit(id, _c(id, PROOF, hunter));
        vm.prank(caller);
        vm.expectRevert(BountyEscrow.NotVerifier.selector);
        escrow.resolve(id, PROOF, hunter, true, VERDICT);
    }
}
